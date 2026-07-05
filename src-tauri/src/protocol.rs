use tauri::http::{Response, StatusCode};

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("drplay", move |_app, request, responder| {
        let app_handle = _app.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            let uri = request.uri().to_string();
            let parsed_url = match url::Url::parse(&uri) {
                Ok(u) => u,
                Err(_) => {
                    responder.respond(Response::builder().status(StatusCode::BAD_REQUEST).body(Vec::new()).unwrap());
                    return;
                }
            };

            if request.method() == "OPTIONS" {
                responder.respond(
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                        .header("Access-Control-Allow-Headers", "*")
                        .body(Vec::new())
                        .unwrap()
                );
                return;
            }

            let file_id = match parsed_url.query_pairs().find(|(k, _)| k == "id") {
                Some((_, id)) => id.into_owned(),
                None => {
                    responder.respond(Response::builder().status(StatusCode::BAD_REQUEST).body(b"Missing ID".to_vec()).unwrap());
                    return;
                }
            };

            if parsed_url.path() == "/cover" {
                use tauri::Manager;
                let thumb = parsed_url.query_pairs().any(|(k, v)| k == "thumb" && v == "true");
                let mut final_image: Option<Vec<u8>> = None;

                if let Some(db_path) = crate::get_db_path() {
                    if let Some(parent) = db_path.parent() {
                        if thumb {
                            let thumb_dir = parent.join(".thumbnails");
                            let thumb_path = thumb_dir.join(format!("{}.jpg", file_id));
                            if thumb_path.exists() {
                                if let Ok(cached_cover) = std::fs::read(&thumb_path) {
                                    final_image = Some(cached_cover);
                                }
                            }
                        }
                    }
                }

                if final_image.is_none() {
                    let pool = app_handle.state::<r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>();
                    if let Ok(conn) = pool.get() {
                        let has_thumb = conn.prepare("SELECT thumbnail FROM tracks LIMIT 1").is_ok();
                        let sql_query = if thumb && has_thumb {
                            "SELECT thumbnail, cover_art FROM tracks WHERE id = ? LIMIT 1"
                        } else {
                            "SELECT cover_art FROM tracks WHERE id = ? AND cover_art IS NOT NULL LIMIT 1"
                        };

                        if let Ok(mut stmt) = conn.prepare(sql_query) {
                            if let Ok(mut rows) = stmt.query([&file_id]) {
                                if let Ok(Some(row)) = rows.next() {
                                    let cover_art: Vec<u8>;
                                    if thumb && has_thumb {
                                        let t: Vec<u8> = row.get(0).unwrap_or_default();
                                        if !t.is_empty() {
                                            cover_art = t;
                                        } else {
                                            cover_art = row.get(1).unwrap_or_default();
                                        }
                                    } else {
                                        cover_art = row.get(0).unwrap_or_default();
                                    }
                                    if !cover_art.is_empty() {
                                        final_image = Some(cover_art);
                                    }
                                }
                            }
                        }
                    }
                }

                if let Some(image_bytes) = final_image {
                    let expected_etag = format!("\"{:x}\"", md5::compute(&image_bytes));
                    
                    if let Some(if_none_match) = request.headers().get("if-none-match") {
                        if if_none_match.to_str().unwrap_or("") == expected_etag {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::NOT_MODIFIED)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .body(Vec::new())
                                    .unwrap()
                            );
                            return;
                        }
                    }

                    responder.respond(
                        Response::builder()
                            .status(StatusCode::OK)
                            .header("Content-Type", "image/jpeg")
                            .header("Access-Control-Allow-Origin", "*")
                            .header("Cache-Control", "public, max-age=31536000, immutable")
                            .header("ETag", expected_etag)
                            .body(image_bytes)
                            .unwrap()
                    );
                    return;
                }

                let transparent_pixel: Vec<u8> = vec![
                    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
                    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
                    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
                    0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
                    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
                    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
                ];
                
                responder.respond(
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "image/png")
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Cache-Control", "public, max-age=31536000, immutable")
                        .header("ETag", "\"transparent\"")
                        .body(transparent_pixel)
                        .unwrap()
                );
                return;
            }

            if parsed_url.path() == "/stream" {
                let port = crate::PROXY_PORT.load(std::sync::atomic::Ordering::SeqCst);
                let secret = crate::PROXY_SECRET.lock().unwrap().clone();
                let redirect_url = format!("http://127.0.0.1:{}/stream?id={}&secret={}", port, file_id, secret);
                
                responder.respond(
                    Response::builder()
                        .status(StatusCode::FOUND)
                        .header("Location", redirect_url)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Vec::new())
                        .unwrap()
                );
                return;
            }

            responder.respond(Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap());
        });
    })
}
