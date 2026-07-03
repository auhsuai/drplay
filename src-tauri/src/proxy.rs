use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use reqwest::Client;
use serde::Deserialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use url::Url;

#[derive(Clone)]
pub struct AppState {
    pub client: Client,
    pub app_handle: AppHandle,
}

#[derive(Deserialize)]
pub struct StreamQuery {
    pub id: String,
    pub token: String,
    pub bitrate: Option<f64>,
    pub buffer: Option<f64>,
}

#[derive(Deserialize)]
pub struct CoverQuery {
    pub size: i64,
    pub thumb: Option<bool>,
}

pub async fn handle_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<StreamQuery>,
) -> Response {
    let mut final_token = query.token;
    if let Ok(global) = crate::GLOBAL_STREAM_TOKEN.lock() {
        if !global.is_empty() {
            final_token = global.clone();
        }
    }

    let mut start_pos = 0;
    let mut end_pos = None;
    let mut has_range = false;

    if let Some(range) = headers.get(header::RANGE) {
        has_range = true;
        let range_str = range.to_str().unwrap_or("");
        if range_str.starts_with("bytes=") {
            let parts: Vec<&str> = range_str["bytes=".len()..].split('-').collect();
            if let Ok(s) = parts[0].parse::<usize>() {
                start_pos = s;
            }
            if parts.len() > 1 && !parts[1].is_empty() {
                if let Ok(e) = parts[1].parse::<usize>() {
                    end_pos = Some(e);
                }
            }
        }
    }

    let mut chunk_size = 2 * 1024 * 1024; // default 2MB chunk
    if let Some(buf_sec) = query.buffer {
        let bps = if let Some(b) = query.bitrate { b / 8.0 } else { 320000.0 / 8.0 };
        chunk_size = (bps * buf_sec) as usize;
        chunk_size = chunk_size.max(512 * 1024).min(50 * 1024 * 1024);
    }

    // --- SNIFFING DETECTION ---
    // A request is considered a metadata "sniff" if it explicitly requests an end_pos,
    // and the requested size is < 1MB. Chromium usually sniffs very small chunks at the end of the file.
    let is_sniffing = has_range && end_pos.is_some() && (end_pos.unwrap() - start_pos < 1024 * 1024);

    // --- CHECK CACHE ---
    let mut use_cache = false;
    let mut cache_clone = None;
    let mut c_type = String::new();
    let mut t_size = 0;
    let mut c_base = 0;
    let mut c_chunk = 0;
    let mut c_notify = None;
    let mut c_error = None;

    if !is_sniffing {
        if let Ok(guard) = crate::GLOBAL_STREAM_CACHE.lock() {
        if let Some(ref cache) = *guard {
            if cache.file_id == query.id && start_pos >= cache.base_pos {
                let cache_len = cache.data.lock().unwrap().len();
                let finished = crate::CURRENT_DOWNLOAD_FINISHED.load(std::sync::atomic::Ordering::SeqCst);
                
                // If download is finished, we can ONLY use the cache if we are strictly within the downloaded bytes.
                // Otherwise, the cache is exhausted and we MUST fetch a new chunk.
                // If the download is NOT finished, we can use the cache as long as it's within the expected chunk_size bounds.
                if (!finished && start_pos <= cache.base_pos + cache.chunk_size) || (finished && start_pos < cache.base_pos + cache_len) {
                    use_cache = true;
                    cache_clone = Some(cache.data.clone());
                    c_type = cache.content_type.clone();
                    t_size = cache.total_file_size;
                    c_base = cache.base_pos;
                    c_chunk = cache.chunk_size;
                    c_notify = Some(cache.notify.clone());
                    c_error = Some(cache.error.clone());
                }
            }
        }
        }
    }

    if use_cache {
        let mut builder = Response::builder().status(StatusCode::PARTIAL_CONTENT);
        builder = builder.header(header::ACCEPT_RANGES, "bytes");
        builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
        builder = builder.header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range");
        builder = builder.header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Length, Content-Range");
        if !c_type.is_empty() {
            builder = builder.header(header::CONTENT_TYPE, c_type);
        }
        
        // CRITICAL: We MUST cap fetch_end at the MAXIMUM POSSIBLE bytes this cache will ever hold!
        let actual_cache_len = cache_clone.as_ref().unwrap().lock().unwrap().len();
        let is_finished = crate::CURRENT_DOWNLOAD_FINISHED.load(std::sync::atomic::Ordering::SeqCst);
        let cache_max_end = if is_finished {
            if actual_cache_len > 0 { c_base + actual_cache_len - 1 } else { c_base }
        } else {
            c_base + c_chunk - 1
        };
        
        let requested_end = end_pos.unwrap_or(start_pos + chunk_size - 1);
        
        let fetch_end = requested_end.min(cache_max_end).min(if t_size > 0 { t_size - 1 } else { usize::MAX });
        let content_length = fetch_end - start_pos + 1;
        
        if t_size > 0 {
            builder = builder.header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start_pos, fetch_end, t_size));
        } else {
            builder = builder.header(header::CONTENT_RANGE, format!("bytes {}-{}/*", start_pos, fetch_end));
        }
        builder = builder.header(header::CONTENT_LENGTH, content_length.to_string());
        
        let rx_stream = async_stream::stream! {
            let mut pos = start_pos - c_base;
            let cache_data = cache_clone.unwrap();
            let notify = c_notify.unwrap();
            let error_flag = c_error.unwrap();
            let mut read_bytes = 0;
            loop {
                let mut chunk = None;
                let mut wait_for_data = false;

                if let Ok(cache) = cache_data.lock() {
                    if pos < cache.len() {
                        let available = cache.len() - pos;
                        let remaining = content_length - read_bytes;
                        let read_len = available.min(remaining).min(65536);
                        
                        if read_len > 0 {
                            let end = pos + read_len;
                            chunk = Some(axum::body::Bytes::copy_from_slice(&cache[pos..end]));
                            pos = end;
                            read_bytes += read_len;
                        }
                    } else {
                        let finished = crate::CURRENT_DOWNLOAD_FINISHED.load(std::sync::atomic::Ordering::SeqCst);
                        let error = error_flag.load(std::sync::atomic::Ordering::SeqCst);
                        if finished || error {
                            break;
                        }
                        wait_for_data = true;
                    }
                }
                
                if read_bytes >= content_length {
                    break;
                }
                
                if let Some(c) = chunk {
                    yield Ok::<_, std::io::Error>(c);
                } else if wait_for_data {
                    notify.notified().await;
                } else {
                    break;
                }
            }
        };
        
        let body = axum::body::Body::from_stream(rx_stream);
        return builder.body(body).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build body").into_response());
    }
    // --- END CACHE ---

    let mut req = state
        .client
        .get(format!(
            "https://www.googleapis.com/drive/v3/files/{}?alt=media",
            query.id
        ))
        .header("Authorization", format!("Bearer {}", final_token));

    if has_range {
        let fetch_end = end_pos.unwrap_or(start_pos + chunk_size - 1);
        req = req.header(header::RANGE, format!("bytes={}-{}", start_pos, fetch_end));
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            
            if status.as_u16() == 401 {
                let _ = state.app_handle.emit("token-expired", ());
            } else if status.as_u16() == 403 || status.as_u16() == 429 {
                let _ = state.app_handle.emit("drive-quota-exceeded", ());
            }

            let mut builder = Response::builder().status(status);

            builder = builder.header(header::ACCEPT_RANGES, "bytes");
            builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
            builder = builder.header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range");
            builder = builder.header(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "Content-Length, Content-Range",
            );

            let mut c_type = String::new();
            let mut t_size = 0;

            if let Some(ct) = resp.headers().get(header::CONTENT_TYPE) {
                builder = builder.header(header::CONTENT_TYPE, ct);
                if let Ok(ct_str) = ct.to_str() {
                    c_type = ct_str.to_string();
                }
            }
            if let Some(cr) = resp.headers().get(header::CONTENT_RANGE) {
                builder = builder.header(header::CONTENT_RANGE, cr);
                if let Ok(cr_str) = cr.to_str() {
                    if let Some(slash_idx) = cr_str.find('/') {
                        if let Ok(total) = cr_str[slash_idx + 1..].parse::<usize>() {
                            crate::CURRENT_FILE_SIZE.store(total, std::sync::atomic::Ordering::SeqCst);
                            t_size = total;
                        }
                    }
                }
            }
            if let Some(cl) = resp.headers().get(header::CONTENT_LENGTH) {
                builder = builder.header(header::CONTENT_LENGTH, cl);
                if t_size == 0 {
                    if let Ok(cl_str) = cl.to_str() {
                        if let Ok(total) = cl_str.parse::<usize>() {
                            crate::CURRENT_FILE_SIZE.store(total, std::sync::atomic::Ordering::SeqCst);
                            t_size = total;
                        }
                    }
                }
            }

            if is_sniffing {
                let body = axum::body::Body::from_stream(resp.bytes_stream());
                return builder.body(body).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build body").into_response());
            }

            // Create new cache
            use std::sync::{Arc, Mutex};
            use std::sync::atomic::AtomicBool;
            use tokio::sync::Notify;

            let cache_data = Arc::new(Mutex::new(Vec::with_capacity(chunk_size)));
            let cache_data_clone = cache_data.clone();
            
            let notify = Arc::new(Notify::new());
            let notify_clone = notify.clone();

            let error_flag = Arc::new(AtomicBool::new(false));
            let error_flag_clone = error_flag.clone();
            
            // Store it globally
            if let Ok(mut global) = crate::GLOBAL_STREAM_CACHE.lock() {
                *global = Some(crate::StreamCache {
                    file_id: query.id.clone(),
                    base_pos: start_pos,
                    data: cache_data.clone(),
                    content_type: c_type,
                    total_file_size: t_size,
                    chunk_size: chunk_size,
                    notify: notify.clone(),
                    error: error_flag.clone(),
                });
            }

            crate::CURRENT_BUFFER_BASE.store(start_pos, std::sync::atomic::Ordering::SeqCst);
            crate::CURRENT_BUFFER_LEN.store(0, std::sync::atomic::Ordering::SeqCst);
            crate::CURRENT_DOWNLOAD_FINISHED.store(false, std::sync::atomic::Ordering::SeqCst);

            let mut stream = resp.bytes_stream();
            tokio::spawn(async move {
                use futures_util::StreamExt;
                let mut current_len = 0;
                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(bytes) => {
                            let len = bytes.len();
                            if let Ok(mut cache) = cache_data_clone.lock() {
                                cache.extend_from_slice(&bytes);
                            }
                            current_len += len;
                            crate::CURRENT_BUFFER_LEN.store(current_len, std::sync::atomic::Ordering::SeqCst);
                            notify_clone.notify_waiters();
                        },
                        Err(_) => {
                            error_flag_clone.store(true, std::sync::atomic::Ordering::SeqCst);
                            break;
                        }
                    }
                }
                crate::CURRENT_DOWNLOAD_FINISHED.store(true, std::sync::atomic::Ordering::SeqCst);
                notify_clone.notify_waiters();
            });

            let rx_stream = async_stream::stream! {
                let mut pos = 0;
                loop {
                    let mut chunk = None;
                    let mut wait_for_data = false;

                    if let Ok(cache) = cache_data.lock() {
                        if pos < cache.len() {
                            let end = (pos + 65536).min(cache.len());
                            chunk = Some(axum::body::Bytes::copy_from_slice(&cache[pos..end]));
                            pos = end;
                        } else {
                            let finished = crate::CURRENT_DOWNLOAD_FINISHED.load(std::sync::atomic::Ordering::SeqCst);
                            let error = error_flag.load(std::sync::atomic::Ordering::SeqCst);
                            if finished || error {
                                break;
                            }
                            wait_for_data = true;
                        }
                    }
                    
                    if let Some(c) = chunk {
                        yield Ok::<_, std::io::Error>(c);
                    } else if wait_for_data {
                        notify.notified().await;
                    } else {
                        break;
                    }
                }
            };

            let body = axum::body::Body::from_stream(rx_stream);
            builder.body(body).unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build body").into_response()
            })
        }
        Err(e) => {
            println!("Proxy stream error: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Proxy error").into_response()
        }
    }
}

pub async fn handle_cover(
    State(state): State<AppState>,
    Query(query): Query<CoverQuery>,
) -> Response {
    use rusqlite::{Connection, OpenFlags};
    let thumb = query.thumb.unwrap_or(false);
    let s = query.size;

    if let Some(db_path) = crate::get_db_path() {
        if thumb {
            if let Some(parent) = db_path.parent() {
                let thumb_dir = parent.join(".thumbnails");
                let thumb_path = thumb_dir.join(format!("{}.jpg", s));
                if thumb_path.exists() {
                    if let Ok(cached_cover) = std::fs::read(&thumb_path) {
                        return Response::builder()
                            .header(header::CONTENT_TYPE, "image/jpeg")
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .header(header::CACHE_CONTROL, "public, max-age=31536000")
                            .body(axum::body::Body::from(cached_cover))
                            .unwrap();
                    }
                }
            }
        }

        if let Ok(conn) = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            let has_thumb = conn.prepare("SELECT thumbnail FROM tracks LIMIT 1").is_ok();
            
            let sql_query = if thumb && has_thumb {
                "SELECT thumbnail, cover_art FROM tracks WHERE size_bytes = ? LIMIT 1"
            } else {
                "SELECT cover_art FROM tracks WHERE size_bytes = ? AND cover_art IS NOT NULL LIMIT 1"
            };

            if let Ok(mut stmt) = conn.prepare(sql_query) {
                if let Ok(mut rows) = stmt.query([s]) {
                    if let Ok(Some(row)) = rows.next() {
                        let mut cover_art: Vec<u8> = Vec::new();
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
                            return Response::builder()
                                .header(header::CONTENT_TYPE, "image/jpeg")
                                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                                .header(header::CACHE_CONTROL, "public, max-age=31536000")
                                .body(axum::body::Body::from(cover_art))
                                .unwrap();
                        }
                    }
                }
            }
        }
    }

    (StatusCode::NOT_FOUND, "Not Found").into_response()
}

pub fn spawn_proxy_server(app_handle: AppHandle) {
    let state = AppState {
        client: Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap(),
        app_handle,
    };

    tauri::async_runtime::spawn(async move {
        let app = Router::new()
            .route("/stream.mp3", get(handle_stream))
            .route("/cover", get(handle_cover))
            .with_state(state);

        if let Ok(listener) = tokio::net::TcpListener::bind("127.0.0.1:0").await {
            if let Ok(addr) = listener.local_addr() {
                crate::PROXY_PORT.store(addr.port(), std::sync::atomic::Ordering::SeqCst);
                println!("Proxy server bound to port {}", addr.port());
            }
            let _ = axum::serve(listener, app).await;
        }
    });
}
