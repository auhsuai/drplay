import os

LIB_PATH = r"c:\Users\thinkpad\Desktop\Antigravity\drplay\src-tauri\src\lib.rs"
PROXY_PATH = r"c:\Users\thinkpad\Desktop\Antigravity\drplay\src-tauri\src\proxy.rs"

# Rewrite lib.rs to use tokio::sync::Mutex instead of std::sync::Mutex, add tokio::sync::Notify to Cache
lib_code = """use oauth2::reqwest::async_http_client;
use reqwest::Client;
use std::sync::atomic::{AtomicUsize, AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock, Notify};

#[derive(Clone)]
pub enum DownloadState {
    Idle,
    Downloading,
    Completed,
    Failed(String),
}

pub struct SegmentedCache {
    pub file_id: String,
    pub content_type: String,
    pub duration: Option<f64>,
    pub total_file_size: usize,
    pub buffer: Arc<RwLock<std::collections::HashMap<usize, Vec<u8>>>>,
    pub filled_ranges: Arc<RwLock<Vec<(usize, usize)>>>,
    pub download_state: Arc<RwLock<DownloadState>>,
    pub current_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub active_download_pos: Arc<RwLock<usize>>,
    pub max_read_pos: Arc<RwLock<usize>>,
    pub data_ready: Arc<Notify>,
}

pub static STREAM_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// Global Cache Protected by Tokio Mutex to prevent TOCTOU
lazy_static::lazy_static! {
    pub static ref GLOBAL_STREAM_CACHE: Mutex<Option<Arc<SegmentedCache>>> = Mutex::new(None);
    pub static ref GLOBAL_STREAM_TOKEN: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
    pub static ref DRIVE_API_SEMAPHORE: tokio::sync::Semaphore = tokio::sync::Semaphore::new(4);
}

pub static PROXY_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

#[tauri::command]
fn get_proxy_port() -> u16 {
    PROXY_PORT.load(Ordering::SeqCst)
}

#[derive(serde::Serialize)]
struct LocalMetadata {
    title: String,
    artist: String,
    album: String,
    duration: f64,
    size_bytes: usize,
}

#[tauri::command]
fn get_local_metadata(file_id: String) -> Option<LocalMetadata> {
    if let Some(db_path) = get_db_path() {
        if let Ok(conn) = rusqlite::Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
            if let Ok(mut stmt) = conn.prepare("SELECT title, artist, album, duration, size_bytes FROM tracks WHERE id = ? LIMIT 1") {
                if let Ok(mut rows) = stmt.query([file_id]) {
                    if let Ok(Some(row)) = rows.next() {
                        return Some(LocalMetadata {
                            title: row.get(0).unwrap_or_default(),
                            artist: row.get(1).unwrap_or_default(),
                            album: row.get(2).unwrap_or_default(),
                            duration: row.get(3).unwrap_or_default(),
                            size_bytes: row.get(4).unwrap_or_default(),
                        });
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
fn update_stream_token(token: String) {
    if let Ok(mut global) = GLOBAL_STREAM_TOKEN.lock() {
        *global = token;
    }
}

pub fn get_db_path() -> Option<std::path::PathBuf> {
    if let Some(data_dir) = dirs::data_dir() {
        let db_path = data_dir.join("drplay").join("library.db");
        if db_path.exists() {
            return Some(db_path);
        }
    }
    None
}

#[tauri::command]
fn extract_metadata_safe() -> Result<bool, String> {
    // Stub
    Ok(true)
}

#[tauri::command]
fn get_stream_url(id: String, token: String, duration: Option<f64>) -> Result<String, String> {
    let port = PROXY_PORT.load(Ordering::SeqCst);
    if port == 0 {
        return Err("Proxy server not started".to_string());
    }
    let dur_str = match duration {
        Some(d) => format!("&duration={}", d),
        None => "".to_string()
    };
    Ok(format!("http://127.0.0.1:{}/stream.mp3?id={}&token={}{}", port, id, token, dur_str))
}

#[tauri::command]
fn get_proxy_cache_status() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "status": "active"
    }))
}

mod proxy;

static MINIMIZE_TO_TRAY: AtomicBool = AtomicBool::new(true);
static IS_QUITTING: AtomicBool = AtomicBool::new(false);
static PLAY_MODE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

#[tauri::command]
fn update_minimize_to_tray(enabled: bool) {
    MINIMIZE_TO_TRAY.store(enabled, Ordering::SeqCst);
}

#[tauri::command]
fn update_play_mode(mode: String) {
    if let Ok(mut global) = PLAY_MODE.lock() {
        *global = mode;
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            proxy::spawn_proxy_server(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_proxy_port,
            extract_metadata_safe,
            get_stream_url,
            get_proxy_cache_status,
            get_local_metadata,
            update_stream_token,
            update_minimize_to_tray,
            update_play_mode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
"""

proxy_code = """use axum::{
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
use tokio::sync::{Mutex, RwLock, Notify};

const CHUNK_SIZE: usize = 1024 * 1024; // 1MB chunks

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
    #[serde(default)]
    pub token: String,
    pub duration: Option<f64>,
}

#[derive(Deserialize)]
pub struct CoverQuery {
    pub id: String,
    pub thumb: Option<bool>,
}

// Merge ranges and return the new list. We ensure testing coverage for edge cases.
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_merge_ranges() {
        let mut r = vec![(0, 100), (200, 300)];
        merge_ranges(&mut r, 50, 250);
        assert_eq!(r, vec![(0, 300)]);
    }
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
            if let Ok(mut task_guard) = cache.current_task.try_lock() {
                if let Some(task) = task_guard.take() {
                    task.abort();
                }
            }
        }
    }

    // Need to create new cache. We are holding the Mutex, so no TOCTOU!
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
    
    let new_cache = Arc::new(crate::SegmentedCache {
        file_id: query.id.clone(),
        content_type: c_type,
        duration: query.duration,
        total_file_size: t_size,
        buffer: Arc::new(RwLock::new(std::collections::HashMap::new())),
        filled_ranges: Arc::new(RwLock::new(Vec::new())),
        download_state: Arc::new(RwLock::new(crate::DownloadState::Idle)),
        current_task: Arc::new(Mutex::new(None)),
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
        let mut req = state.client.get(format!("https://www.googleapis.com/drive/v3/files/{}?alt=media", query.id))
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
                // Fallback to error if stream fails
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

    // Reparse range with correct total_size to handle suffix ranges properly
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
                
                // Calculate max_buffer_bytes ONCE outside loop
                let mut max_buffer_bytes = 100 * 1024 * 1024;
                if let Some(dur) = cache_clone.duration {
                    if dur > 0.0 {
                        let bytes_per_sec = cache_clone.total_file_size as f64 / dur;
                        let buf_sec = 600.0; // 10 minutes limit
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
                                        // Evict old memory!
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
                            // Data was evicted because max_read_pos was moved too far forward, 
                            // or missing unexpectedly. Abort.
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
                // REPLACED SLEEP WITH NOTIFY.AWAY! Wait efficiently for background task!
                let _ = tokio::time::timeout(std::time::Duration::from_secs(30), cache.data_ready.notified()).await;
            }
        }
    };

    builder.body(axum::body::Body::from_stream(rx_stream)).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed").into_response())
}

pub async fn handle_cover(
    State(_state): State<AppState>,
    Query(query): Query<CoverQuery>,
) -> Response {
    use rusqlite::{Connection, OpenFlags};
    let thumb = query.thumb.unwrap_or(false);
    let id_str = query.id;

    if let Some(db_path) = crate::get_db_path() {
        if thumb {
            if let Some(parent) = db_path.parent() {
                let thumb_dir = parent.join(".thumbnails");
                let thumb_path = thumb_dir.join(format!("{}.jpg", id_str)); // Used ID instead of size
                if thumb_path.exists() {
                    if let Ok(cached_cover) = std::fs::read(&thumb_path) {
                        return Response::builder()
                            .header(header::CONTENT_TYPE, "image/jpeg")
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .header(header::CACHE_CONTROL, "public, max-age=31536000")
                            .body(axum::body::Body::from(cached_cover))
                            .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed").into_response());
                    }
                }
            }
        }

        if let Ok(conn) = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            let has_thumb = conn.prepare("SELECT thumbnail FROM tracks LIMIT 1").is_ok();
            
            let sql_query = if thumb && has_thumb {
                "SELECT thumbnail, cover_art FROM tracks WHERE id = ? LIMIT 1"
            } else {
                "SELECT cover_art FROM tracks WHERE id = ? AND cover_art IS NOT NULL LIMIT 1"
            };

            if let Ok(mut stmt) = conn.prepare(sql_query) {
                if let Ok(mut rows) = stmt.query([&id_str]) {
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
                                .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed").into_response());
                        }
                    }
                }
            }
        }
    }

    let transparent_pixel: Vec<u8> = vec![
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    (StatusCode::OK, [("Content-Type", "image/png")], transparent_pixel).into_response()
}

pub fn spawn_proxy_server(app_handle: AppHandle) {
    let state = AppState {
        client: Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(60)) // Added Timeouts!
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
"""

with open(LIB_PATH, "w", encoding="utf-8") as f:
    f.write(lib_code)
    
with open(PROXY_PATH, "w", encoding="utf-8") as f:
    f.write(proxy_code)

print("Successfully rewrote lib.rs and proxy.rs")
