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
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{RwLock, Notify};

const CHUNK_SIZE: usize = 1024 * 1024; // 1MB chunks

#[derive(Clone)]
pub struct AppState {
    pub pool: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    pub client: Client,
    pub app_handle: AppHandle,
}

#[derive(Deserialize, Clone, serde::Serialize)]
struct BufferPayload {
    song_id: String,
    ranges: Vec<(usize, usize)>,
    total_size: usize,
}

#[derive(Deserialize)]
pub struct StreamQuery {
    pub id: String,
    #[serde(default)]
    pub token: String,
    pub duration: Option<f64>,
}

#[derive(Deserialize)]
pub struct CoverQuery {
    pub id: String,
    pub thumb: Option<bool>,
}

fn merge_ranges(ranges: &mut Vec<(usize, usize)>, new_start: usize, new_end: usize) {
    ranges.push((new_start, new_end));
    ranges.sort_by_key(|&(s, _)| s);
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
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

// Parses Range header safely. Returns (start, optional end, is_valid)
fn parse_range_header(range_str: &str, total_size: usize) -> (usize, Option<usize>, bool) {
    if !range_str.starts_with("bytes=") {
        return (0, None, false);
    }
    let parts: Vec<&str> = range_str["bytes=".len()..].split('-').collect();
    if parts.is_empty() {
        return (0, None, false);
    }
    
    // Handle suffix range (e.g., bytes=-500)
    if parts[0].is_empty() && parts.len() > 1 && !parts[1].is_empty() {
        if let Ok(suffix_len) = parts[1].parse::<usize>() {
            if total_size > 0 && suffix_len <= total_size {
                return (total_size - suffix_len, Some(total_size - 1), true);
            } else if total_size > 0 {
                return (0, Some(total_size - 1), true);
            }
            return (0, None, false); // Unknown total size for suffix
        }
    }
    
    let start_pos = parts[0].parse::<usize>().unwrap_or(0);
    let mut end_pos = None;
    if parts.len() > 1 && !parts[1].is_empty() {
        if let Ok(e) = parts[1].parse::<usize>() {
            end_pos = Some(e);
        }
    }
    
    // Validate underflow/inversions
    if let Some(e) = end_pos {
        if e < start_pos {
            return (0, None, false); // Invalid range
        }
    }
    
    (start_pos, end_pos, true)
}

async fn get_or_create_cache(
    state: &AppState,
    query: &StreamQuery,
    final_token: &str,
) -> Result<Arc<crate::SegmentedCache>, String> {
    let mut global_lock = crate::GLOBAL_STREAM_CACHE.lock().await;
    
    if let Some(cache) = global_lock.as_ref() {
        if cache.file_id == query.id {
            return Ok(cache.clone());
        } else {
            // Abort old task
            let mut task_guard = cache.current_task.lock().await;
            if let Some(task) = task_guard.take() {
                task.abort();
            }
        }
    }

    // Create new cache inside the Tokio Mutex (prevents TOCTOU)
    let req = state.client.get(format!("https://www.googleapis.com/drive/v3/files/{}?alt=media", query.id))
        .header("Authorization", format!("Bearer {}", final_token))
        .header("Range", "bytes=0-0");
        
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    
    if status.as_u16() == 401 { let _ = state.app_handle.emit("token-expired", ()); }
    if status.as_u16() == 403 || status.as_u16() == 429 { 
        let _ = state.app_handle.emit("drive-quota-exceeded", ()); 
    }
    
    let mut c_type = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if c_type.is_empty() || c_type == "application/json" {
        c_type = "audio/mpeg".to_string();
    }
    
    let mut t_size = 0;
    if let Some(cr) = resp.headers().get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()) {
        if let Some(slash_idx) = cr.find('/') {
            if let Ok(total) = cr[slash_idx + 1..].parse::<usize>() {
                t_size = total;
            }
        }
    }
    if t_size == 0 {
        if let Some(cl) = resp.headers().get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()) {
            if let Ok(total) = cl.parse::<usize>() {
                t_size = total;
            }
        }
    }
    if t_size == 0 {
        t_size = 100 * 1024 * 1024; // Fallback
    }
    
    crate::CURRENT_FILE_SIZE.store(t_size, std::sync::atomic::Ordering::SeqCst);
    
    let new_cache = Arc::new(crate::SegmentedCache {
        file_id: query.id.clone(),
        content_type: c_type,
        duration: query.duration,
        total_file_size: t_size,
        buffer: Arc::new(RwLock::new(std::collections::HashMap::new())),
        filled_ranges: Arc::new(RwLock::new(Vec::new())),
        download_state: Arc::new(RwLock::new(crate::DownloadState::Idle)),
        current_task: Arc::new(tokio::sync::Mutex::new(None)),
        active_download_pos: Arc::new(RwLock::new(0)),
        max_read_pos: Arc::new(RwLock::new(0)),
        data_ready: Arc::new(Notify::new()),
    });
    
    *global_lock = Some(new_cache.clone());
    Ok(new_cache)
}

// Free memory for pages that are far behind the max_read_pos
async fn evict_old_pages(cache: &Arc<crate::SegmentedCache>, max_read_pos: usize) {
    let current_page = max_read_pos / CHUNK_SIZE;
    if current_page > 5 {
        let evict_before = current_page - 5;
        let mut buf = cache.buffer.write().await;
        buf.retain(|&k, _| k >= evict_before);
    }
}

pub async fn handle_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<StreamQuery>,
) -> Response {
    let mut final_token = query.token.clone();
    if let Ok(global) = crate::GLOBAL_STREAM_TOKEN.lock() {
        if !global.is_empty() {
            final_token = global.clone();
        }
    }

    let mut start_pos = 0;
    let mut end_pos = None;
    let mut has_range = false;

    if let Some(range) = headers.get(header::RANGE) {
        let range_str = range.to_str().unwrap_or("");
        // Total size is unknown here, we parse it properly later if it's a suffix range
        let (s, e, valid) = parse_range_header(range_str, 0); 
        if valid {
            has_range = true;
            start_pos = s;
            end_pos = e;
        } else {
            return (StatusCode::RANGE_NOT_SATISFIABLE, "Invalid Range").into_response();
        }
    }

    let is_sniffing = has_range && end_pos.is_some() && (end_pos.unwrap().saturating_sub(start_pos) < 1024 * 1024);

    if is_sniffing {
        let fetch_end = end_pos.unwrap_or(start_pos + 512 * 1024);
        let req = state.client.get(format!("https://www.googleapis.com/drive/v3/files/{}?alt=media", query.id))
            .header("Authorization", format!("Bearer {}", final_token))
            .header(header::RANGE, format!("bytes={}-{}", start_pos, fetch_end));
        
        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.as_u16() == 401 { let _ = state.app_handle.emit("token-expired", ()); }
                
                let mut builder = Response::builder().status(status);
                for h in &[header::CONTENT_RANGE, header::CONTENT_LENGTH, header::ACCEPT_RANGES, header::CONTENT_TYPE] {
                    if let Some(v) = resp.headers().get(h) {
                        builder = builder.header(h, v);
                    }
                }
                builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
                let stream = resp.bytes_stream();
                return builder.body(axum::body::Body::from_stream(stream)).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Stream err").into_response());
            },
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Proxy error").into_response()
        }
    }

    let cache = match get_or_create_cache(&state, &query, &final_token).await {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };

    if let Some(range) = headers.get(header::RANGE) {
        let range_str = range.to_str().unwrap_or("");
        let (s, e, valid) = parse_range_header(range_str, cache.total_file_size);
        if valid {
            start_pos = s;
            end_pos = e;
        }
    }

    if start_pos >= cache.total_file_size {
        let mut builder = Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE);
        builder = builder.header(header::CONTENT_RANGE, format!("bytes */{}", cache.total_file_size));
        builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
        return builder.body(axum::body::Body::empty()).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Err").into_response());
    }

    let fetch_end = end_pos.unwrap_or(cache.total_file_size - 1).min(cache.total_file_size - 1);
    let content_length = fetch_end - start_pos + 1;

    // Check if we need to fetch, and if so, abort old and spawn new atomically
    {
        let mut current_task_guard = cache.current_task.lock().await;
        
        let mut needs_fetch = true;
        {
            let ranges = cache.filled_ranges.read().await;
            for &(r_start, r_end) in ranges.iter() {
                if start_pos >= r_start && start_pos <= r_end {
                    needs_fetch = false;
                    break;
                }
            }
            
            if needs_fetch {
                let state = cache.download_state.read().await;
                if matches!(*state, crate::DownloadState::Downloading) {
                    let active_dl = *cache.active_download_pos.read().await;
                    if active_dl > 0 && start_pos >= active_dl && start_pos <= active_dl + 5 * CHUNK_SIZE {
                        needs_fetch = false;
                    }
                }
            }
        }
        
        if needs_fetch {
            if let Some(task) = current_task_guard.take() {
                task.abort();
            }
            
            let client = state.client.clone();
            let file_id = cache.file_id.clone();
            let token = final_token.clone();
            let cache_clone = cache.clone();
            let app_handle = state.app_handle.clone();
            let target_start = start_pos;
            let target_end = cache.total_file_size - 1;
            
            *cache.download_state.write().await = crate::DownloadState::Downloading;
            
            let task = tokio::spawn(async move {
                let _permit = match crate::DRIVE_API_SEMAPHORE.acquire().await {
                    Ok(p) => p,
                    Err(_) => return,
                };
                
                let mut current_offset = target_start;
                let mut retries = 0;
                
                let mut max_buffer_bytes = 100 * 1024 * 1024;
                if let Some(dur) = cache_clone.duration {
                    if dur > 0.0 {
                        let bytes_per_sec = cache_clone.total_file_size as f64 / dur;
                        let buf_sec = 600.0;
                        max_buffer_bytes = (bytes_per_sec * buf_sec) as usize;
                        max_buffer_bytes = max_buffer_bytes.max(5 * 1024 * 1024);
                    }
                }
                
                loop {
                    let req = client.get(format!("https://www.googleapis.com/drive/v3/files/{}?alt=media", file_id))
                        .header("Authorization", format!("Bearer {}", token))
                        .header("Range", format!("bytes={}-{}", current_offset, target_end));
                    
                    match req.send().await {
                        Ok(resp) => {
                            let status = resp.status().as_u16();
                            if status == 401 { let _ = app_handle.emit("token-expired", ()); }
                            if !resp.status().is_success() {
                                *cache_clone.download_state.write().await = crate::DownloadState::Failed(format!("HTTP {}", status));
                                cache_clone.data_ready.notify_waiters();
                                return;
                            }
                            
                            use futures_util::StreamExt;
                            let mut stream = resp.bytes_stream();
                            let mut last_emit_time = tokio::time::Instant::now();
                            let mut stream_failed = false;
                            
                            while let Some(chunk_res) = stream.next().await {
                                // Throttle
                                loop {
                                    let max_pos = *cache_clone.max_read_pos.read().await;
                                    if current_offset > max_pos + max_buffer_bytes {
                                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                                    } else {
                                        // Evict old memory
                                        evict_old_pages(&cache_clone, max_pos).await;
                                        break;
                                    }
                                }
                                
                                match chunk_res {
                                    Ok(bytes) => {
                                        retries = 0;
                                        let len = bytes.len();
                                        if len == 0 { continue; }
                                        
                                        let mut b_offset = 0;
                                        let mut remaining = len;
                                        
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
                                        
                                        {
                                            let mut ranges = cache_clone.filled_ranges.write().await;
                                            merge_ranges(&mut ranges, current_offset, current_offset + len - 1);
                                        }
                                        
                                        *cache_clone.active_download_pos.write().await = current_offset + len;
                                        current_offset += len;
                                        
                                        // WAKE UP READER IMMEDIATELY
                                        cache_clone.data_ready.notify_waiters();
                                        
                                        let now = tokio::time::Instant::now();
                                        if now.duration_since(last_emit_time).as_millis() > 500 {
                                            let ranges_clone = cache_clone.filled_ranges.read().await.clone();
                                            let _ = app_handle.emit("buffer-progress", BufferPayload {
                                                song_id: cache_clone.file_id.clone(),
                                                ranges: ranges_clone,
                                                total_size: cache_clone.total_file_size,
                                            });
                                            last_emit_time = now;
                                        }
                                    },
                                    Err(_) => {
                                        stream_failed = true;
                                        break;
                                    }
                                }
                            }
                            
                            if !stream_failed {
                                let ranges = cache_clone.filled_ranges.read().await.clone();
                                let _ = app_handle.emit("buffer-progress", BufferPayload {
                                    song_id: cache_clone.file_id.clone(),
                                    ranges,
                                    total_size: cache_clone.total_file_size,
                                });
                                *cache_clone.download_state.write().await = crate::DownloadState::Completed;
                                cache_clone.data_ready.notify_waiters();
                                return;
                            }
                        },
                        Err(_) => {}
                    }
                    
                    retries += 1;
                    if retries > 3 {
                        *cache_clone.download_state.write().await = crate::DownloadState::Failed("Max retries exceeded".to_string());
                        cache_clone.data_ready.notify_waiters();
                        return;
                    }
                    tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
                }
            });
            
            *current_task_guard = Some(task);
        }
    }

    // Set correct HTTP Status: 206 only if Range is present, 200 otherwise
    let status_code = if has_range { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
    let mut builder = Response::builder().status(status_code);
    builder = builder.header(header::ACCEPT_RANGES, "bytes");
    builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    builder = builder.header(header::CONTENT_TYPE, cache.content_type.clone());
    builder = builder.header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start_pos, fetch_end, cache.total_file_size));
    builder = builder.header(header::CONTENT_LENGTH, content_length.to_string());

    {
        let mut cur_max = cache.max_read_pos.write().await;
        if start_pos > *cur_max {
            *cur_max = start_pos;
        }
    }

    let rx_stream = async_stream::stream! {
        let mut pos = start_pos;
        
        loop {
            if pos > fetch_end { break; }
            
            let mut chunk = None;
            let mut wait_for_data = false;
            let mut should_abort = false;
            let mut hit_eof = false;
            
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
                        }
                    }
                } else {
                    let state = cache.download_state.read().await;
                    match *state {
                        crate::DownloadState::Failed(_) => {
                            should_abort = true;
                        },
                        crate::DownloadState::Completed => {
                            hit_eof = true;
                        },
                        _ => {
                            wait_for_data = true;
                        }
                    }
                }
            }
            
            if hit_eof {
                break;
            }
            
            if should_abort {
                yield Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "Stream aborted"));
                break;
            }
            
            if let Some(c) = chunk {
                // Throttle max_read_pos updates to reduce lock contention
                if pos % (CHUNK_SIZE / 4) == 0 {
                    let mut cur_max = cache.max_read_pos.write().await;
                    if pos > *cur_max {
                        *cur_max = pos;
                    }
                }
                yield Ok::<_, std::io::Error>(c);
            } else if wait_for_data {
                // Wait for background task to notify!
                let _ = tokio::time::timeout(std::time::Duration::from_secs(30), cache.data_ready.notified()).await;
            }
        }
    };

    builder.body(axum::body::Body::from_stream(rx_stream)).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed").into_response())
}

pub async fn handle_cover(
    State(state): State<AppState>,
    Query(query): Query<CoverQuery>,
    headers: HeaderMap,
) -> Response {
    let thumb = query.thumb.unwrap_or(false);
    let id_str = query.id;

    if id_str.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing ID").into_response();
    }

    let mut final_image: Option<Vec<u8>> = None;

    if let Some(db_path) = crate::get_db_path() {
        if let Some(parent) = db_path.parent() {
            if thumb {
                let thumb_dir = parent.join(".thumbnails");
                let thumb_path = thumb_dir.join(format!("{}.jpg", id_str));
                if thumb_path.exists() {
                    if let Ok(cached_cover) = std::fs::read(&thumb_path) {
                        final_image = Some(cached_cover);
                    }
                }
            }
        }
    }

    if final_image.is_none() {
        if let Ok(conn) = state.pool.get() {
            let has_thumb = conn.prepare("SELECT thumbnail FROM tracks LIMIT 1").is_ok();
            let sql_query = if thumb && has_thumb {
                "SELECT thumbnail, cover_art FROM tracks WHERE id = ? LIMIT 1"
            } else {
                "SELECT cover_art FROM tracks WHERE id = ? AND cover_art IS NOT NULL LIMIT 1"
            };

            if let Ok(mut stmt) = conn.prepare(sql_query) {
                if let Ok(mut rows) = stmt.query([&id_str]) {
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
        
        if let Some(if_none_match) = headers.get(header::IF_NONE_MATCH) {
            if if_none_match.to_str().unwrap_or("") == expected_etag {
                return Response::builder()
                    .status(StatusCode::NOT_MODIFIED)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(axum::body::Body::empty())
                    .unwrap();
            }
        }

        return Response::builder()
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .header(header::ETAG, expected_etag)
            .body(axum::body::Body::from(image_bytes))
            .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed").into_response());
    }

    let transparent_pixel: Vec<u8> = vec![
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    
    Response::builder()
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(header::ETAG, "\"transparent\"")
        .body(axum::body::Body::from(transparent_pixel))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed").into_response())
}

pub fn spawn_proxy_server(app_handle: AppHandle) {
    let pool = app_handle.state::<r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>().inner().clone();
    let state = AppState {
        pool,
        client: Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
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
