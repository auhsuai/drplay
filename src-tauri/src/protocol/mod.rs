pub mod cover;

use tauri::http::{Response, StatusCode};
use cover::{handle_cover_get, handle_cover_post, CoverError};

pub fn init_access_recorder(log_path: std::path::PathBuf) {
    cover::init_access_recorder(log_path);
}

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("drplay", move |_app, request, responder| {
        let app_handle = _app.app_handle().clone();
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

            // POST /cover/{id} — nhận raw binary body (legacy local-cover path).
            if method == "POST" && path.starts_with("/cover/") {
                let raw_id = path.trim_start_matches("/cover/");
                let thumb = parsed_url.query_pairs()
                    .any(|(k, v)| k == "thumb" && v == "true");
                let body = request.body();

                match handle_cover_post(raw_id, thumb, body) {
                    Ok(_) => responder.respond(Response::builder().status(StatusCode::OK).body(Vec::new()).unwrap_or_else(|e| {
                        eprintln!("[protocol] failed to build 200 (cover POST) response: {e}");
                        Response::new(Vec::new())
                    })),
                    Err(e) => responder.respond(Response::builder().status(StatusCode::BAD_REQUEST).body(e.into_bytes()).unwrap_or_else(|e| {
                        eprintln!("[protocol] failed to build 400 (cover POST) response: {e}");
                        Response::new(Vec::new())
                    })),
                }
                return;
            }

            // GET /cover?id={id}&thumb=true|false
            if path == "/cover" {
                let file_id = match parsed_url.query_pairs().find(|(k, _)| k == "id") {
                    Some((_, id)) => id.into_owned(),
                    None => {
                        responder.respond(Response::builder().status(StatusCode::BAD_REQUEST).body(b"Missing ID".to_vec()).unwrap_or_else(|e| {
                            eprintln!("[protocol] failed to build 400 (cover missing id) response: {e}");
                            Response::new(Vec::new())
                        }));
                        return;
                    }
                };

                let thumb = parsed_url.query_pairs().any(|(k, v)| k == "thumb" && v == "true");
                let client_etag = request.headers().get("if-none-match")
                    .and_then(|h| h.to_str().ok().map(|s| s.to_string()));

                use tauri::Manager;
                let pool_state = app_handle.try_state::<r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>();
                let pool = pool_state.map(|p| p.inner().clone());

                let recorder = match cover::ACCESS_RECORDER.get() {
                    Some(r) => r,
                    None => {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::INTERNAL_SERVER_ERROR)
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
                    pool.as_ref(),
                    recorder,
                    Some(&app_handle),
                ).await;

                match fetch_result {
                    Ok((etag, bytes_val, content_type)) => {
                        if client_etag.as_deref() == Some(etag.as_str()) {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::NOT_MODIFIED)
                                    .header("Access-Control-Allow-Origin", "*")
                                .body(Vec::new())
                                .unwrap_or_else(|e| {
                                    eprintln!("[protocol] failed to build 304 (not modified) response: {e}");
                                    Response::new(Vec::new())
                                })
                            );
                        } else {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::OK)
                                    .header("Content-Type", content_type)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .header("Cache-Control", "public, max-age=31536000, immutable")
                                    .header("ETag", etag)
                                .body(bytes_val.to_vec())
                                .unwrap_or_else(|e| {
                                    eprintln!("[protocol] failed to build 200 (cover) response: {e}");
                                    Response::new(Vec::new())
                                })
                            );
                        }
                    }
                    Err(CoverError::BadId(e)) => {
                        responder.respond(
                            Response::builder()
                                .status(StatusCode::BAD_REQUEST)
                                .body(e.into_bytes())
                                .unwrap_or_else(|e| {
                                    eprintln!("[protocol] failed to build 400 (bad id) response: {e}");
                                    Response::new(Vec::new())
                                })
                        );
                    }
                    Err(CoverError::NoCover) => {
                        responder.respond(
                            Response::builder()
                                .status(StatusCode::NO_CONTENT)
                                .header("Access-Control-Allow-Origin", "*")
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

            responder.respond(Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap_or_else(|e| {
                eprintln!("[protocol] failed to build 404 response: {e}");
                Response::new(Vec::new())
            }));
        });
    })
}
