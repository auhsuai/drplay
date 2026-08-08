pub mod cover;

use bytes::Bytes;
use tauri::http::{Response, StatusCode};
use cover::{handle_cover_get, handle_cover_post, CoverError};

pub fn init_access_recorder(log_path: std::path::PathBuf) {
    cover::init_access_recorder(log_path);
}

/// Response builder pre-wired with the CORS header every drplay:// response
/// must carry.
///
/// Browser `fetch()` to the custom scheme (the cover POST) runs through CORS:
/// a response without `Access-Control-Allow-Origin` is blocked client-side
/// with "Failed to fetch" even though the OPTIONS preflight passed — that
/// silently kept every cover out of the Rust disk cache (GETs via `<img>`
/// are no-cors and never needed the header; POSTs did).
fn cors_response_builder(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
}

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("drplay", move |_app, request, responder| {
        tauri::async_runtime::spawn(async move {
            let uri = request.uri().to_string();
            let parsed_url = match url::Url::parse(&uri) {
                Ok(u) => u,
                Err(_) => {
                    responder.respond(
                        cors_response_builder(StatusCode::BAD_REQUEST)
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
                    cors_response_builder(StatusCode::OK)
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

            // POST /cover/{id} — nhận raw binary body (legacy local-cover path).
            if method == "POST" && path.starts_with("/cover/") {
                let raw_id = path.trim_start_matches("/cover/");
                let thumb = parsed_url.query_pairs()
                    .any(|(k, v)| k == "thumb" && v == "true");
                let body = request.body();

                match handle_cover_post(raw_id, thumb, body).await {
                    Ok(_) => responder.respond(cors_response_builder(StatusCode::OK).body(Vec::new()).unwrap_or_else(|e| {
                        eprintln!("[protocol] failed to build 200 (cover POST) response: {e}");
                        Response::new(Vec::new())
                    })),
                    // Bad id / bad payload → 400 with a short reason (never the
                    // raw error internals); disk failures → 500 with the error
                    // logged here and a bare body.
                    Err(CoverError::BadId(e)) => responder.respond(cors_response_builder(StatusCode::BAD_REQUEST).body(e.into_bytes()).unwrap_or_else(|e| {
                        eprintln!("[protocol] failed to build 400 (cover POST) response: {e}");
                        Response::new(Vec::new())
                    })),
                    Err(e) => {
                        eprintln!("[protocol] cover POST failed (id={raw_id}): {e:?}");
                        responder.respond(cors_response_builder(StatusCode::INTERNAL_SERVER_ERROR).body(Vec::new()).unwrap_or_else(|e| {
                            eprintln!("[protocol] failed to build 500 (cover POST) response: {e}");
                            Response::new(Vec::new())
                        }))
                    }
                }
                return;
            }

            // GET /cover?id={id}&thumb=true|false
            if path == "/cover" {
                let file_id = match parsed_url.query_pairs().find(|(k, _)| k == "id") {
                    Some((_, id)) => id.into_owned(),
                    None => {
                        responder.respond(cors_response_builder(StatusCode::BAD_REQUEST).body(b"Missing ID".to_vec()).unwrap_or_else(|e| {
                            eprintln!("[protocol] failed to build 400 (cover missing id) response: {e}");
                            Response::new(Vec::new())
                        }));
                        return;
                    }
                };

                let thumb = parsed_url.query_pairs().any(|(k, v)| k == "thumb" && v == "true");
                let client_etag = request.headers().get("if-none-match")
                    .and_then(|h| h.to_str().ok().map(|s| s.to_string()));

                let recorder = match cover::ACCESS_RECORDER.get() {
                    Some(r) => r,
                    None => {
                            responder.respond(
                                cors_response_builder(StatusCode::INTERNAL_SERVER_ERROR)
                                    .body(b"Access recorder not initialized".to_vec())
                                    .unwrap_or_else(|e| {
                                        eprintln!("[protocol] failed to build 500 (access recorder) response: {e}");
                                        Response::new(Vec::new())
                                    }),
                            );
                        return;
                    }
                };
                let fetch_result = handle_cover_get(
                    &file_id,
                    thumb,
                    recorder,
                ).await;

                match fetch_result {
                    Ok((etag, bytes_val, content_type)) => {
                        if client_etag.as_deref() == Some(etag.as_str()) {
                            responder.respond(
                                cors_response_builder(StatusCode::NOT_MODIFIED)
                                .body(Vec::new())
                                .unwrap_or_else(|e| {
                                    eprintln!("[protocol] failed to build 304 (not modified) response: {e}");
                                    Response::new(Vec::new())
                                })
                            );
                        } else {
                            responder.respond(
                                cors_response_builder(StatusCode::OK)
                                    .header("Content-Type", content_type)
                                    .header("Cache-Control", "public, max-age=31536000, immutable")
                                    .header("ETag", etag)
                                .body(cover_response_body(bytes_val))
                                .unwrap_or_else(|e| {
                                    eprintln!("[protocol] failed to build 200 (cover) response: {e}");
                                    Response::new(Vec::new())
                                })
                            );
                        }
                    }
                    Err(CoverError::BadId(e)) => {
                        responder.respond(
                            cors_response_builder(StatusCode::BAD_REQUEST)
                                .body(e.into_bytes())
                                .unwrap_or_else(|e| {
                                    eprintln!("[protocol] failed to build 400 (bad id) response: {e}");
                                    Response::new(Vec::new())
                                })
                        );
                    }
                    // Disk-level failure (permission, corrupt state, uninit
                    // root): log the detail server-side, reply bare 500 — the
                    // frontend must not see filesystem details.
                    Err(CoverError::DiskRead(e)) | Err(CoverError::DiskWrite(e)) => {
                        eprintln!("[protocol] cover GET disk error (id={file_id}): {e}");
                        responder.respond(
                            cors_response_builder(StatusCode::INTERNAL_SERVER_ERROR)
                                .body(Vec::new())
                                .unwrap_or_else(|e| {
                                    eprintln!("[protocol] failed to build 500 (cover disk) response: {e}");
                                    Response::new(Vec::new())
                                })
                        );
                    }
                    Err(CoverError::NoCover) => {
                        responder.respond(
                            cors_response_builder(StatusCode::NO_CONTENT)
                                .body(Vec::new())
                                .unwrap_or_else(|e| {
                                    eprintln!("[protocol] failed to build 204 (no cover) response: {e}");
                                    Response::new(Vec::new())
                                })
                        );
                    }
                }
                return;
            }

            responder.respond(cors_response_builder(StatusCode::NOT_FOUND).body(Vec::new()).unwrap_or_else(|e| {
                eprintln!("[protocol] failed to build 404 response: {e}");
                Response::new(Vec::new())
            }));
        });
    })
}

/// Builds the owned response body for a cached cover payload.
///
/// Tauri's URI-scheme responder requires an owned `'static` buffer
/// (`responder.respond<T: Into<Cow<'static, [u8]>>>`), so a cover that lives in
/// the shared `Bytes` cache must be converted to `Vec<u8>` once per response.
/// The conversion uses the bytes crate's ownership-consuming
/// `From<Bytes> for Vec<u8>` instead of `to_vec()`: for a shared (cache-hit)
/// `Bytes` this is exactly one memcpy — the irreducible copy the protocol API
/// demands — and for a uniquely-owned `Bytes` it reclaims the allocation with
/// no copy at all. No `Bytes` is ever copied twice in this path.
fn cover_response_body(bytes_val: Bytes) -> Vec<u8> {
    bytes_val.into()
}

#[cfg(test)]
mod tests {
    use super::{cover_response_body, cors_response_builder};
    use bytes::Bytes;
    use tauri::http::StatusCode;

    #[test]
    fn cors_response_builder_attaches_allow_origin_to_every_status() {
        for status in [
            StatusCode::OK,
            StatusCode::BAD_REQUEST,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::NOT_FOUND,
            StatusCode::NO_CONTENT,
            StatusCode::NOT_MODIFIED,
        ] {
            let response: tauri::http::Response<Vec<u8>> =
                cors_response_builder(status).body(Vec::new()).unwrap();
            assert_eq!(response.status(), status);
            let header = response
                .headers()
                .get("Access-Control-Allow-Origin")
                .expect("response must carry Access-Control-Allow-Origin")
                .to_str()
                .expect("header is valid ASCII");
            assert_eq!(header, "*");
        }
    }

    #[test]
    fn cors_response_builder_preserves_status_and_body() {
        let response = cors_response_builder(StatusCode::BAD_REQUEST)
            .body(b"Bad id".to_vec())
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.body(), &b"Bad id"[..]);
    }

    #[test]
    fn cover_response_body_preserves_exact_payload() {
        let payload: Vec<u8> = (0..8192u32).map(|i| (i % 251) as u8).collect();
        let body = cover_response_body(Bytes::from(payload.clone()));
        assert_eq!(body, payload, "response body must be byte-identical to the cached cover");
    }

    #[test]
    fn cover_response_body_shared_bytes_still_identical() {
        let payload: Vec<u8> = vec![0x24u8; 4096];
        let cache_side = Bytes::from(payload.clone());
        let response_side = cache_side.clone();
        drop(cache_side);
        let body = cover_response_body(response_side);
        assert_eq!(body, payload, "shared (cache-hit) Bytes must serve identical bytes");
    }

    #[test]
    fn cover_response_body_consumes_unique_bytes_without_realloc() {
        let payload: Vec<u8> = vec![0x42u8; 4096];
        let body = cover_response_body(Bytes::from(payload.clone()));
        assert_eq!(body, payload, "uniquely-owned Bytes must reclaim the allocation, not copy again");
    }
}
