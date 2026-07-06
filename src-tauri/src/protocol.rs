use tauri::http::{Response, StatusCode};
use moka::future::Cache;
use bytes::Bytes;
use once_cell::sync::Lazy;

use std::path::Path;
use r2d2_sqlite::SqliteConnectionManager;

pub fn fetch_cover_blocking(
    pool: Option<&r2d2::Pool<SqliteConnectionManager>>,
    file_id: &str,
    thumb: bool,
    thumb_dir: Option<&Path>,
) -> Result<(String, Bytes), String> {
    let mut final_image: Option<Vec<u8>> = None;
    
    if let Some(parent) = thumb_dir {
        if thumb {
            let thumb_path = parent.join(".thumbnails").join(format!("{}.jpg", file_id));
            if thumb_path.exists() {
                if let Ok(cached_cover) = std::fs::read(&thumb_path) {
                    final_image = Some(cached_cover);
                }
            }
        }
    }

    if final_image.is_none() {
        if let Some(pool) = pool {
            let conn = pool.get().map_err(|e| e.to_string())?;
            let has_thumb = *crate::HAS_THUMB.get_or_init(|| {
                conn.prepare("SELECT thumbnail FROM tracks LIMIT 1").is_ok()
            });
            let sql_query = if thumb && has_thumb {
                "SELECT thumbnail, cover_art FROM tracks WHERE id = ? LIMIT 1"
            } else {
                "SELECT cover_art FROM tracks WHERE id = ? AND cover_art IS NOT NULL LIMIT 1"
            };

            let mut stmt = conn.prepare(sql_query).map_err(|e| e.to_string())?;
            let mut rows = stmt.query([&file_id]).map_err(|e| e.to_string())?;
            
            if let Ok(Some(row)) = rows.next() {
                let mut cover_art: Vec<u8> = vec![];
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

    if let Some(image_bytes) = final_image {
        let etag = format!("\"{:x}\"", md5::compute(&image_bytes));
        Ok((etag, Bytes::from(image_bytes)))
    } else {
        Err("Not found".to_string())
    }
}

pub static ETAG_CACHE: Lazy<Cache<String, (String, Bytes)>> = Lazy::new(|| {
    Cache::builder()
        .max_capacity(50 * 1024 * 1024)
        .weigher(|_k, v: &(String, Bytes)| v.1.len() as u32)
        .build()
});

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
                let client_etag = request.headers().get("if-none-match").and_then(|h| h.to_str().map(|s| s.to_string()).ok());

                // Use get_with to prevent Cache Stampede
                let cache_key = format!("{}-{}", file_id, thumb);
                let fetch_result = ETAG_CACHE.try_get_with(cache_key, async move {
                    let db_path = crate::get_db_path();
                    let pool_state = app_handle.try_state::<r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>();
                    let pool = pool_state.map(|p| p.inner().clone());
                    let file_id_clone = file_id.clone();
                    
                    let spawn_res = tokio::task::spawn_blocking(move || {
                        let thumb_dir = db_path.as_deref().and_then(|p| p.parent());
                        fetch_cover_blocking(pool.as_ref(), &file_id_clone, thumb, thumb_dir)
                    }).await.map_err(|e| e.to_string())?;
                    
                    spawn_res
                }).await;

                match fetch_result {
                    Ok((etag, bytes_val)) => {
                        if client_etag.as_deref() == Some(etag.as_str()) {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::NOT_MODIFIED)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .body(Vec::new())
                                    .unwrap()
                            );
                        } else {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::OK)
                                    .header("Content-Type", "image/jpeg")
                                    .header("Access-Control-Allow-Origin", "*")
                                    .header("Cache-Control", "public, max-age=31536000, immutable")
                                    .header("ETag", etag)
                                    .body(bytes_val.to_vec()) // Since we must return Vec<u8> to responder, we can't easily avoid to_vec here unless we use a different HTTP server, but Tauri's uri scheme requires Vec<u8> body. 
                                    .unwrap()
                            );
                        }
                    },
                    Err(_) => {
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
                    }
                }
                return;
            }

            if parsed_url.path() == "/stream" {
                let port = crate::PROXY_PORT.load(std::sync::atomic::Ordering::SeqCst);
                let secret = crate::PROXY_SECRET.get().unwrap().clone();
                let redirect_url = format!("http://127.0.0.1:{}/stream?id={}&secret={}", port, file_id, secret);
                
                responder.respond(
                    Response::builder()
                        .status(StatusCode::FOUND)
                        .header("Location", redirect_url)
                        .header("Cache-Control", "private, max-age=3600")
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
