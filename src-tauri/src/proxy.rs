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

use tokio::sync::{RwLock, Mutex, Notify};
use crate::{DownloadState, SegmentedCache};

#[derive(Clone)]
pub struct AppState {
    pub client: Client,
    pub app_handle: AppHandle,
}

#[derive(Deserialize)]
#[derive(Clone, serde::Serialize)]
struct BufferPayload {
    song_id: String,
    ranges: Vec<(usize, usize)>,
    total_size: usize,
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

fn merge_ranges(ranges: &mut Vec<(usize, usize)>, new_start: usize, new_end: usize) {
    ranges.push((new_start, new_end));
    ranges.sort_by_key(|&(s, _)| s);
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for range in ranges.drain(..) {
        if merged.is_empty() {
            merged.push(range);
        } else {
            let last_idx = merged.len() - 1;
            let last = &mut merged[last_idx];
            if range.0 <= last.1 + 1 {
                last.1 = last.1.max(range.1);
            } else {
                merged.push(range);
            }
        }
    }
    *ranges = merged;
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

    let is_sniffing = has_range && end_pos.is_some() && (end_pos.unwrap() - start_pos < 1024 * 1024);

    if is_sniffing {
        let mut req = state
            .client
            .get(format!(
                "https://www.googleapis.com/drive/v3/files/{}?alt=media",
                query.id
            ))
            .header("Authorization", format!("Bearer {}", final_token));

        let fetch_end = end_pos.unwrap_or(start_pos + 512 * 1024);
        req = req.header(header::RANGE, format!("bytes={}-{}", start_pos, fetch_end));
        
        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.as_u16() == 401 { let _ = state.app_handle.emit("token-expired", ()); }
                let mut builder = Response::builder().status(status);
                for h in &[header::CONTENT_TYPE, header::CONTENT_RANGE, header::CONTENT_LENGTH, header::ACCEPT_RANGES] {
                    if let Some(v) = resp.headers().get(h) {
                        builder = builder.header(h, v);
                    }
                }
                return builder.body(axum::body::Body::from_stream(resp.bytes_stream())).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed").into_response());
            },
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Proxy error").into_response()
        }
    }

    let mut need_new_cache = false;
    let mut cache_opt: Option<Arc<crate::SegmentedCache>> = None;

    if let Ok(mut global) = crate::GLOBAL_STREAM_CACHE.lock() {
        if let Some(ref cache) = *global {
            if cache.file_id == query.id {
                cache_opt = Some(cache.clone());
            } else {
                if let Ok(mut task_guard) = cache.current_task.lock() {
                    if let Some(task) = task_guard.take() {
                        task.abort();
                        println!("drplay: Aborted previous download task for file {}", cache.file_id);
                    }
                }
                need_new_cache = true;
            }
        } else {
            need_new_cache = true;
        }
    }

    if need_new_cache {
        let req = state.client.get(format!("https://www.googleapis.com/drive/v3/files/{}?alt=media", query.id))
            .header("Authorization", format!("Bearer {}", final_token))
            .header("Range", "bytes=0-0");
            
        if let Ok(resp) = req.send().await {
            if resp.status().as_u16() == 401 { let _ = state.app_handle.emit("token-expired", ()); }
            let c_type = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            let mut t_size = 0;
            if let Some(cr) = resp.headers().get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()) {
                if let Some(slash_idx) = cr.find('/') {
                    if let Ok(total) = cr[slash_idx + 1..].parse::<usize>() {
                        t_size = total;
                    }
                }
            }
            crate::CURRENT_FILE_SIZE.store(t_size, std::sync::atomic::Ordering::SeqCst);
            
            if t_size > 0 {
                let new_cache = Arc::new(crate::SegmentedCache {
                    file_id: query.id.clone(),
                    content_type: c_type,
                    bitrate: query.bitrate,
                    total_file_size: t_size,
                    buffer: Arc::new(RwLock::new(std::collections::HashMap::new())),
                    filled_ranges: Arc::new(RwLock::new(Vec::new())),
                    download_state: Arc::new(RwLock::new(crate::DownloadState::Idle)),
                    notify: Arc::new(Notify::new()),
                    current_task: Arc::new(std::sync::Mutex::new(None)),
                });
                
                if let Ok(mut global) = crate::GLOBAL_STREAM_CACHE.lock() {
                    *global = Some(new_cache.clone());
                }
                cache_opt = Some(new_cache);
            }
        }
    }

    let cache = match cache_opt {
        Some(c) => c,
        None => return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to initialize cache").into_response(),
    };

    let fetch_end = end_pos.unwrap_or(cache.total_file_size - 1).min(cache.total_file_size - 1);
    let content_length = fetch_end - start_pos + 1;

    let mut needs_fetch = true;
    {
        let ranges = cache.filled_ranges.read().await;
        for &(r_start, r_end) in ranges.iter() {
            if start_pos >= r_start && start_pos <= r_end {
                if fetch_end <= r_end {
                    needs_fetch = false;
                }
            }
        }
    }

    if needs_fetch {
        {
            if let Ok(mut task_guard) = cache.current_task.lock() {
                if let Some(task) = task_guard.take() {
                    task.abort();
                }
            }
        }
        
        let client = state.client.clone();
        let file_id = cache.file_id.clone();
        let token = final_token.clone();
        let cache_clone = cache.clone();
        let app_handle = state.app_handle.clone();
        let target_start = start_pos;
        let target_end = cache.total_file_size - 1; // Fetch to the end, abort handles cancellation later
        
        *cache.download_state.write().await = crate::DownloadState::Downloading;

        let task = tokio::spawn(async move {
            let _permit = match crate::DRIVE_API_SEMAPHORE.acquire().await {
                Ok(p) => p,
                Err(_) => return,
            };

            let req = client.get(format!("https://www.googleapis.com/drive/v3/files/{}?alt=media", file_id))
                .header("Authorization", format!("Bearer {}", token))
                .header("Range", format!("bytes={}-{}", target_start, target_end));
            
            match req.send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if status == 401 { let _ = app_handle.emit("token-expired", ()); }
                    if status == 403 || status == 429 { let _ = app_handle.emit("drive-quota-exceeded", ()); }
                    
                    if !resp.status().is_success() {
                        *cache_clone.download_state.write().await = crate::DownloadState::Failed(format!("HTTP {}", status));
                        cache_clone.notify.notify_waiters();
                        return;
                    }
                    
                    if let Some(cr) = resp.headers().get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()) {
                        if !cr.starts_with(&format!("bytes {}-", target_start)) {
                            *cache_clone.download_state.write().await = crate::DownloadState::Failed("Invalid Content-Range".into());
                            cache_clone.notify.notify_waiters();
                            return;
                        }
                    }

                    use futures_util::StreamExt;
                    let mut stream = resp.bytes_stream();
                    let mut current_offset = target_start;
                    const CHUNK_SIZE: usize = 1024 * 1024; // 1MB chunks
                    
                    while let Some(chunk) = stream.next().await {
                        match chunk {
                            Ok(bytes) => {
                                let mut b_offset = 0;
                                let mut remaining = bytes.len();
                                
                                {
                                    let mut buf = cache_clone.buffer.write().await;
                                    while remaining > 0 {
                                        let page_idx = (current_offset + b_offset) / CHUNK_SIZE;
                                        let page_offset = (current_offset + b_offset) % CHUNK_SIZE;
                                        let write_len = remaining.min(CHUNK_SIZE - page_offset);
                                        
                                        let page = buf.entry(page_idx).or_insert_with(|| vec![0u8; CHUNK_SIZE]);
                                        page[page_offset..page_offset + write_len].copy_from_slice(&bytes[b_offset..b_offset + write_len]);
                                        
                                        b_offset += write_len;
                                        remaining -= write_len;
                                    }
                                }
                                
                                let len = bytes.len();
                                {
                                    let mut ranges = cache_clone.filled_ranges.write().await;
                                    merge_ranges(&mut ranges, current_offset, current_offset + len - 1);
                                }
                                current_offset += len;
                                cache_clone.notify.notify_waiters();
                            },
                            Err(e) => {
                                *cache_clone.download_state.write().await = crate::DownloadState::Failed(e.to_string());
                                cache_clone.notify.notify_waiters();
                                return;
                            }
                        }
                    }
                    let ranges = cache_clone.filled_ranges.read().await.clone();
                    let _ = app_handle.emit("buffer-progress", BufferPayload {
                        song_id: cache_clone.file_id.clone(),
                        ranges,
                        total_size: cache_clone.total_file_size,
                    });
                    *cache_clone.download_state.write().await = crate::DownloadState::Completed;
                    cache_clone.notify.notify_waiters();
                },
                Err(e) => {
                    *cache_clone.download_state.write().await = crate::DownloadState::Failed(e.to_string());
                    cache_clone.notify.notify_waiters();
                }
            }
        });
        
        if let Ok(mut task_guard) = cache.current_task.lock() {
            *task_guard = Some(task);
        }
    }

    let mut builder = Response::builder().status(StatusCode::PARTIAL_CONTENT);
    builder = builder.header(header::ACCEPT_RANGES, "bytes");
    builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    builder = builder.header(header::CONTENT_TYPE, cache.content_type.clone());
    builder = builder.header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start_pos, fetch_end, cache.total_file_size));
    builder = builder.header(header::CONTENT_LENGTH, content_length.to_string());

    let rx_stream = async_stream::stream! {
        let mut pos = start_pos;
        const CHUNK_SIZE: usize = 1024 * 1024;
        
        loop {
            if pos > fetch_end { break; }
            
            let mut chunk = None;
            let mut wait_for_data = false;
            let mut should_abort = false;
            let mut error_msg = None;
            
            {
                let ranges = cache.filled_ranges.read().await;
                let mut available_end = pos;
                for &(r_start, r_end) in ranges.iter() {
                    if pos >= r_start && pos <= r_end {
                        available_end = r_end + 1;
                        break;
                    }
                }
                
                if available_end > pos {
                    let page_idx = pos / CHUNK_SIZE;
                    let page_offset = pos % CHUNK_SIZE;
                    let max_read_in_page = CHUNK_SIZE - page_offset;
                    let read_len = (available_end - pos).min(65536).min(max_read_in_page).min(fetch_end - pos + 1);
                    
                    if read_len > 0 {
                        let buf = cache.buffer.read().await;
                        if let Some(page) = buf.get(&page_idx) {
                            chunk = Some(axum::body::Bytes::copy_from_slice(&page[page_offset..page_offset + read_len]));
                            pos += read_len;
                        } else {
                            should_abort = true;
                            error_msg = Some("Missing page in cache despite filled_ranges".to_string());
                        }
                    }
                } else {
                    let state = cache.download_state.read().await;
                    match *state {
                        crate::DownloadState::Failed(ref err) => {
                            should_abort = true;
                            error_msg = Some(err.clone());
                        },
                        crate::DownloadState::Completed => {
                            should_abort = true;
                        },
                        _ => {
                            wait_for_data = true;
                        }
                    }
                }
            }
            
            if should_abort {
                println!("Abort stream: {:?}", error_msg);
                yield Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "Stream aborted"));
                break;
            }
            
            if let Some(c) = chunk {
                yield Ok::<_, std::io::Error>(c);
            } else if wait_for_data {
                cache.notify.notified().await;
            }
        }
    };

    builder.body(axum::body::Body::from_stream(rx_stream)).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed").into_response())
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
