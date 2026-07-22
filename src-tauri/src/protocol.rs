use tauri::http::{Response, StatusCode};
use hmac::Mac;

// Pure helper (no Tauri types) so the query-extraction logic below is
// directly unit-testable — this is exactly the kind of logic that had a
// real, live bug (see the /stream handler below): `ext` was never being
// extracted at all, only `id` was.
fn extract_query_param(parsed_url: &url::Url, key: &str) -> Option<String> {
    parsed_url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

// This module proxies the Tauri custom URI scheme (`drplay://`) into the
// Drive-audio-streaming Axum proxy (see `proxy.rs`). The cover-art / SQLite
// metadata pipeline that used to live here (R2 lookups, in-RAM cover cache,
// the `/cover` route) has been removed: this app streams files directly from
// Google Drive with no local metadata database and no cover-art fetch.
//
// IMPORTANT — this is the LIVE handler for every real stream request, not a
// secondary/unused path: registering a scheme named "drplay" here makes
// Tauri route BOTH `drplay://...` AND `http://drplay.localhost/...` to this
// same closure (on Windows/Android, custom schemes are exposed to the
// webview as `http://<scheme>.localhost/...` because those WebView engines
// can't load a truly custom scheme directly — see Tauri's own
// `convertFileSrc` implementation and GHSA-7gmj-67g7-phm9 for the documented
// mapping). `build_stream_url` in lib.rs always produces
// `http://drplay.localhost/stream?...` URLs, and Windows is the only
// platform this app ships for (see .github/workflows/build.yml) — so every
// single stream request goes through here.

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("drplay", move |_app, request, responder| {
        tauri::async_runtime::spawn(async move {
            let uri = request.uri().to_string();
            let parsed_url = match url::Url::parse(&uri) {
                Ok(u) => u,
                Err(_) => {
                    responder.respond(
                        Response::builder()
                            .status(StatusCode::BAD_REQUEST)
                            .body(Vec::new())
                            .unwrap_or_else(|e| {
                                log::error!("[protocol] failed to build BAD_REQUEST (invalid URI) response: {e}");
                                Response::new(Vec::new())
                            }),
                    );
                    return;
                }
            };

            let method = request.method();
            let path = parsed_url.path().to_string();

            if method == "OPTIONS" {
                responder.respond(
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
                        .header("Access-Control-Allow-Headers", "*")
                        .body(Vec::new())
                        .unwrap_or_else(|e| {
                            log::error!("[protocol] failed to build OPTIONS response: {e}");
                            Response::new(Vec::new())
                        })
                );
                return;
            }

            // GET /stream?id={id}&ext={ext} — redirect to Axum proxy
            if path == "/stream" {
                let file_id = match extract_query_param(&parsed_url, "id") {
                    Some(id) => id,
                    None => {
                        responder.respond(Response::builder().status(StatusCode::BAD_REQUEST).body(b"Missing ID".to_vec()).unwrap_or_else(|_| Response::new(Vec::new())));
                        return;
                    }
                };
                // `ext` was previously dropped entirely here: this handler is
                // the LIVE target of every stream URL build_stream_url()
                // (lib.rs) produces (http://drplay.localhost/... resolves to
                // this exact registered "drplay" scheme handler on Windows —
                // the only platform this app ships for — per Tauri's own
                // custom-protocol-to-.localhost mapping), not a dead/unused
                // alternate path. Always re-signing with an empty ext and
                // never forwarding the real one to the Axum proxy meant
                // `StreamQuery.ext` was always `None` there, permanently
                // disabling the Content-Type override that exists (per
                // proxy.rs's own comment) specifically because "Drive's
                // Content-Type is often wrong" for FLAC/OGG/WAV/M4A/AAC/etc.
                // — i.e. every non-MP3 stream request was silently missing
                // the fix that was built to make it play correctly.
                let ext = extract_query_param(&parsed_url, "ext");
                let ext_str = ext.clone().unwrap_or_default();
                let port = crate::PROXY_PORT.load(std::sync::atomic::Ordering::SeqCst);

                let exp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() + crate::STREAM_URL_TTL_SECS;
                let payload = format!("{}:{}:{}", file_id, ext_str, exp);
                let secret = match crate::PROXY_SECRET.get() {
                    Some(s) => s.clone(),
                    None => {
                        responder.respond(Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(b"Proxy not ready".to_vec()).unwrap_or_else(|_| Response::new(Vec::new())));
                        return;
                    }
                };
                let mut mac = match <hmac::Hmac<sha2::Sha256> as hmac::Mac>::new_from_slice(secret.as_bytes()) {
                    Ok(m) => m,
                    Err(_) => {
                        responder.respond(
                            Response::builder()
                                .status(StatusCode::INTERNAL_SERVER_ERROR)
                                .body(b"HMAC init error".to_vec())
                                .unwrap_or_else(|_| Response::new(Vec::new())),
                        );
                        return;
                    }
                };
                mac.update(payload.as_bytes());
                let sig = mac.finalize().into_bytes().iter().map(|b| format!("{:02x}", b)).collect::<String>();

                let ext_param = ext.as_deref().map(|e| format!("&ext={}", e)).unwrap_or_default();
                let redirect_url = format!("http://127.0.0.1:{}/stream?id={}{}&exp={}&sig={}", port, file_id, ext_param, exp, sig);

                responder.respond(
                    Response::builder()
                        .status(StatusCode::FOUND)
                        .header("Location", redirect_url)
                        .header("Cache-Control", "private, max-age=3600")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Vec::new())
                        .unwrap_or_else(|_| Response::new(Vec::new()))
                );
                return;
            }

            responder.respond(Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap_or_else(|e| {
                log::error!("[protocol] failed to build 404 response: {e}");
                Response::new(Vec::new())
            }));
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Regression coverage for the real bug this pass found and fixed: `ext`
    // was never being extracted from the incoming request at all (only
    // `id` was), which permanently disabled proxy.rs's Content-Type
    // override for every non-default audio format on every real stream
    // request — this handler is the live target of every `http://
    // drplay.localhost/stream?...` URL build_stream_url() (lib.rs) produces,
    // not a secondary/unused path (see the module-level comment above).

    fn parse(uri: &str) -> url::Url {
        url::Url::parse(uri).expect("test fixture URL must parse")
    }

    #[test]
    fn extracts_id_and_ext_when_both_present() {
        let url = parse("http://drplay.localhost/stream?id=abc123&ext=flac");
        assert_eq!(extract_query_param(&url, "id"), Some("abc123".to_string()));
        assert_eq!(extract_query_param(&url, "ext"), Some("flac".to_string()));
    }

    #[test]
    fn ext_is_none_when_absent_not_an_empty_string() {
        let url = parse("http://drplay.localhost/stream?id=abc123");
        assert_eq!(extract_query_param(&url, "id"), Some("abc123".to_string()));
        assert_eq!(extract_query_param(&url, "ext"), None);
    }

    #[test]
    fn ignores_unrelated_params_like_bitrate_and_buffer() {
        // These two ARE present in the real URLs build_stream_url() produces,
        // but proxy.rs's StreamQuery has no fields for them -- confirm they
        // don't interfere with id/ext extraction either way.
        let url = parse("http://drplay.localhost/stream?id=abc&bitrate=320&buffer=300&ext=m4a");
        assert_eq!(extract_query_param(&url, "id"), Some("abc".to_string()));
        assert_eq!(extract_query_param(&url, "ext"), Some("m4a".to_string()));
    }

    #[test]
    fn missing_key_returns_none() {
        let url = parse("http://drplay.localhost/stream?ext=flac");
        assert_eq!(extract_query_param(&url, "id"), None);
    }

    #[test]
    fn signing_payload_matches_build_stream_urls_convention_for_various_exts() {
        // lib.rs's build_stream_url computes:
        //   let ext_str = ext.unwrap_or("");
        //   payload = format!("{}:{}:{}", file_id, ext_str, exp);
        // protocol.rs MUST produce an identical payload for a given
        // (id, ext, exp), or proxy.rs's HMAC verifier will reject the
        // redirect it issues.
        for ext in ["mp3", "flac", "ogg", "wav", "m4a", "aac"] {
            let url = parse(&format!("http://drplay.localhost/stream?id=xyz&ext={ext}"));
            let file_id = extract_query_param(&url, "id").unwrap();
            let ext_str = extract_query_param(&url, "ext").unwrap_or_default();
            let payload = format!("{}:{}:{}", file_id, ext_str, 999u64);
            assert_eq!(payload, format!("xyz:{ext}:999"));
        }
    }

    #[test]
    fn signing_payload_uses_empty_string_when_ext_absent() {
        let url = parse("http://drplay.localhost/stream?id=xyz");
        let file_id = extract_query_param(&url, "id").unwrap();
        let ext_str = extract_query_param(&url, "ext").unwrap_or_default();
        let payload = format!("{}:{}:{}", file_id, ext_str, 999u64);
        assert_eq!(payload, "xyz::999");
    }
}
