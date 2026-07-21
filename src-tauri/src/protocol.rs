use tauri::http::{Response, StatusCode};
use hmac::Mac;

// This module proxies the Tauri custom URI scheme (`drplay://`) into the
// Drive-audio-streaming Axum proxy (see `proxy.rs`). The cover-art / SQLite
// metadata pipeline that used to live here (R2 lookups, in-RAM cover cache,
// the `/cover` route) has been removed: this app streams files directly from
// Google Drive with no local metadata database and no cover-art fetch.

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
                                eprintln!("[protocol] failed to build BAD_REQUEST (invalid URI) response: {e}");
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
                            eprintln!("[protocol] failed to build OPTIONS response: {e}");
                            Response::new(Vec::new())
                        })
                );
                return;
            }

            // GET /stream?id={id} — redirect to Axum proxy
            if path == "/stream" {
                let file_id = match parsed_url.query_pairs().find(|(k, _)| k == "id") {
                    Some((_, id)) => id.into_owned(),
                    None => {
                        responder.respond(Response::builder().status(StatusCode::BAD_REQUEST).body(b"Missing ID".to_vec()).unwrap_or_else(|_| Response::new(Vec::new())));
                        return;
                    }
                };
                let port = crate::PROXY_PORT.load(std::sync::atomic::Ordering::SeqCst);

                let exp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() + crate::STREAM_URL_TTL_SECS;
                let payload = format!("{}:{}:{}", file_id, "", exp);
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

                let redirect_url = format!("http://127.0.0.1:{}/stream?id={}&exp={}&sig={}", port, file_id, exp, sig);

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
                eprintln!("[protocol] failed to build 404 response: {e}");
                Response::new(Vec::new())
            }));
        });
    })
}
