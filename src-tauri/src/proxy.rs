use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    routing::get,
    Router,
    http::{HeaderMap, StatusCode, header},
};
use reqwest::Client;
use serde::Deserialize;
use tauri::Emitter;

use std::sync::atomic::{AtomicU64, AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use std::sync::Arc;
use tokio::sync::Mutex;
use std::collections::HashMap;
use tokio::task::JoinHandle;

// Maximum buffer size allowed across all tracks (prevents unbounded memory use)
const ABSOLUTE_MAX_BUFFER: u64 = 500 * 1024 * 1024; // 500MB

fn buffer_size_limit() -> u64 {
    let seconds = crate::GLOBAL_BUFFER_SECONDS.load(Ordering::Relaxed) as u64;
    let bytes = seconds * 320_000 / 8; // 320kbps → bytes
    bytes.clamp(5 * 1024 * 1024, ABSOLUTE_MAX_BUFFER)
}

#[derive(serde::Serialize, Clone)]
struct BufferState {
    track_id: String,
    buffer_start_byte: u64,
    buffer_end_byte: u64,
    total_size_byte: u64,
}

struct TrackCache {
    buffer: Vec<u8>,
    window_start: u64,
    fetch_task: Option<JoinHandle<()>>,
    total_size: u64,
    content_type: String,
    accessed_at: u64,
}

type CacheStore = Arc<Mutex<HashMap<String, Arc<Mutex<TrackCache>>>>>;

#[derive(Clone)]
struct AppState {
    client: Client,
    cache_store: CacheStore,
}

#[derive(Deserialize)]
pub struct StreamQuery {
    pub id: String,
    pub secret: String,
}

fn now_epoch_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    if a_bytes.len() != b_bytes.len() {
        return false;
    }
    let mut result = 0;
    for (byte_a, byte_b) in a_bytes.iter().zip(b_bytes.iter()) {
        result |= byte_a ^ byte_b;
    }
    result == 0
}

static GLOBAL_BACKOFF_UNTIL: AtomicU64 = AtomicU64::new(0);
static FAIL_COUNT: AtomicU32 = AtomicU32::new(0);

fn parse_multi_range(range_str: &str, total_size: u64) -> Vec<(u64, u64)> {
    let prefix = "bytes=";
    let body = if let Some(s) = range_str.strip_prefix(prefix) { s } else { return vec![] };
    let mut ranges = Vec::new();
    for segment in body.split(',') {
        let seg = segment.trim();
        if let Some((start_str, end_str)) = seg.split_once('-') {
            let start: u64 = start_str.trim().parse().unwrap_or(0);
            let end: u64 = if end_str.trim().is_empty() {
                total_size.saturating_sub(1)
            } else {
                end_str.trim().parse().unwrap_or(total_size.saturating_sub(1))
            };
            if start <= end && start < total_size {
                ranges.push((start, end.min(total_size.saturating_sub(1))));
            }
        }
    }
    ranges
}

async fn fetch_range_from_drive(
    client: &Client,
    api_url: &str,
    token: &str,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, u16> {
    let range = format!("bytes={}-{}", start, end);
    let resp = client.get(api_url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Range", &range)
        .send()
        .await
          .map_err(|_| 502u16)?;

    let status = resp.status();
    if status == 429 || status == 403 {
        return Err(429);
    }
    if !status.is_success() && status != 206 {
        return Err(status.as_u16());
    }
    
    let expected_len = (end - start + 1) as usize;
    let bytes = resp.bytes().await.map_err(|_| 502u16)?;
    
    if bytes.len() != expected_len && end != u64::MAX {
        return Err(502);
    }
    
    Ok(bytes.to_vec())
}

async fn forward_multipart_range(
    client: &Client,
    api_url: &str,
    token: &str,
    ranges: &[(u64, u64)],
    total_size: u64,
) -> Result<Response, u16> {
    let boundary = format!("drplay_{}", uuid::Uuid::new_v4());
    let mut body = Vec::new();

    for &(start, end) in ranges {
        let chunk = fetch_range_from_drive(client, api_url, token, start, end).await?;
        let header = format!(
            "\r\n--{}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes {}-{}/{}\r\n\r\n",
            boundary, start, end, total_size
        );
        body.extend_from_slice(header.as_bytes());
        body.extend_from_slice(&chunk);
    }
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());

    Ok(Response::builder()
        .status(206)
        .header(header::CONTENT_TYPE, format!("multipart/byteranges; boundary={}", boundary))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(axum::body::Body::from(body))
        .unwrap())
}

async fn handle_stream(
    State(state): State<AppState>,
    Query(query): Query<StreamQuery>,
    method: axum::http::Method,
    headers: HeaderMap,
) -> Response {
    if query.id.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing ID").into_response();
    }

    if !query.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return (StatusCode::BAD_REQUEST, "Invalid file ID").into_response();
    }

    if let Some(expected_secret) = crate::PROXY_SECRET.get() {
        if !constant_time_eq(&query.secret, expected_secret) {
            return (StatusCode::UNAUTHORIZED, "Invalid secret").into_response();
        }
    } else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Not initialized").into_response();
    }

    // Global cooldown gate
    let now = now_epoch_secs();
    let backoff_until = GLOBAL_BACKOFF_UNTIL.load(Ordering::Acquire);
    if now < backoff_until {
        return (StatusCode::SERVICE_UNAVAILABLE, "Rate limited — cooldown active").into_response();
    }

    let final_token = crate::GLOBAL_STREAM_TOKEN.lock().await.clone();

    if final_token.is_empty() {
        return (StatusCode::UNAUTHORIZED, "No token").into_response();
    }

    let api_url = format!("https://www.googleapis.com/drive/v3/files/{}?alt=media&acknowledgeAbuse=true", query.id);

    let (total_size, content_type) = {
        let store = state.cache_store.lock().await;
        if let Some(arc) = store.get(&query.id) {
            let tc = arc.lock().await;
            (tc.total_size, tc.content_type.clone())
        } else {
            (0, String::new())
        }
    };

    let (total_size, content_type) = if total_size == 0 {
        get_total_size(&state.client, &api_url, &final_token)
            .await
            .unwrap_or((10_000_000, "audio/mpeg".to_string()))
    } else {
        (total_size, content_type)
    };

    let range_str = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let ranges = range_str.map(|r| parse_multi_range(r, total_size)).unwrap_or_default();

    if method == axum::http::Method::HEAD {
        let (start, end) = ranges.first().cloned().unwrap_or((0, total_size.saturating_sub(1)));
        let real_end = end.min(total_size.saturating_sub(1));
        let status = if range_str.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
        
        return Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, real_end, total_size))
            .header(header::CONTENT_LENGTH, (real_end - start + 1).to_string())
            .body(axum::body::Body::empty())
            .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build HEAD body").into_response());
    }

    if ranges.len() > 1 {
        match forward_multipart_range(&state.client, &api_url, &final_token, &ranges, total_size).await {
            Ok(r) => {
                FAIL_COUNT.store(0, Ordering::Relaxed);
                return r;
            }
            Err(429) => {
                return handle_rate_limit(now).await;
            }
            Err(_) => {
                return (StatusCode::BAD_GATEWAY, "Upstream error").into_response();
            }
        }
    }

    // Single-range or no-range path
    let range_value = ranges.first().cloned().unwrap_or((0, total_size.saturating_sub(1)));
    let start = range_value.0;
    let end = range_value.1.min(total_size.saturating_sub(1));

    let mut store = state.cache_store.lock().await;
    
    // LRU Cleanup: Keep up to 3 tracks in memory to avoid thrashing
    if store.len() >= 3 && !store.contains_key(&query.id) {
        let mut oldest_key = String::new();
        let mut oldest_time = u64::MAX;
        for (k, arc) in store.iter() {
            if let Ok(tc) = arc.try_lock() {
                if tc.accessed_at < oldest_time {
                    oldest_time = tc.accessed_at;
                    oldest_key = k.clone();
                }
            }
        }
        if !oldest_key.is_empty() {
            if let Some(arc) = store.remove(&oldest_key) {
                // Ensure we reliably abort the task
                let mut tc = arc.lock().await;
                if let Some(task) = tc.fetch_task.take() {
                    task.abort();
                }
            }
        }
    }

    let track_cache_arc = store.entry(query.id.clone()).or_insert_with(|| {
        Arc::new(Mutex::new(TrackCache {
            buffer: Vec::with_capacity(2 * 1024 * 1024),
            window_start: 0,
            fetch_task: None,
            total_size,
            content_type: content_type.clone(),
            accessed_at: now_epoch_secs(),
        }))
    }).clone();
    
    // Drop the global store lock so other requests can proceed
    drop(store);

    let mut track_cache = track_cache_arc.lock().await;
    track_cache.accessed_at = now_epoch_secs();
    let window_end = track_cache.window_start + track_cache.buffer.len() as u64;

    if start >= track_cache.window_start && start < window_end {
        // Cache Hit!
        let offset = (start - track_cache.window_start) as usize;
        let mut read_end = (end.saturating_sub(track_cache.window_start) + 1) as usize;
        read_end = read_end.min(track_cache.buffer.len());
        let mut chunk_size = read_end.saturating_sub(offset);
        
        // Limit chunk size to 2MB to keep browser requests flowing
        let max_chunk = 2 * 1024 * 1024;
        if chunk_size > max_chunk {
            chunk_size = max_chunk;
            read_end = offset + chunk_size;
        }

        let chunk = track_cache.buffer[offset..read_end].to_vec();
        let real_end = start + chunk.len() as u64 - 1;
        let body = axum::body::Body::from(chunk);
        
        FAIL_COUNT.store(0, Ordering::Relaxed);
        
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, content_type.clone())
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, real_end, total_size))
            .header(header::CONTENT_LENGTH, (real_end - start + 1).to_string())
            .body(body)
            .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build body").into_response());
    } else {
        // Cache Miss!
        if let Some(task) = track_cache.fetch_task.take() {
            task.abort();
        }

        // Fetch first 2MB synchronously
        let initial_fetch_end = (start + 2 * 1024 * 1024 - 1).min(total_size.saturating_sub(1));
        // DO NOT drop lock before network call to prevent concurrent identical fetches!
        // This ensures the first request fetches and others wait to get a Cache Hit.
        
        let mut chunk = vec![];
        let max_retries = 3;
        for attempt in 0..max_retries {
            match fetch_range_from_drive(&state.client, &api_url, &final_token, start, initial_fetch_end).await {
                Ok(c) => {
                    chunk = c;
                    FAIL_COUNT.store(0, Ordering::Relaxed);
                    break;
                }
                Err(429) => {
                    if attempt == max_retries - 1 {
                        return handle_rate_limit(now).await;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                }
                Err(_) => {
                    if attempt == max_retries - 1 {
                        return (StatusCode::BAD_GATEWAY, "Gateway Error").into_response();
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                }
            }
        }

        track_cache.window_start = start;
        track_cache.buffer = chunk.clone();
        
        if let Some(app) = crate::APP_HANDLE.get() {
            let _ = app.emit("buffer-status", BufferState {
                track_id: query.id.clone(),
                buffer_start_byte: start,
                buffer_end_byte: start + chunk.len() as u64,
                total_size_byte: total_size,
            });
        }
        
        // Spawn background task to fetch remaining up to 100MB
        let background_start = start + chunk.len() as u64;
        if background_start < total_size {
            let bg_client = state.client.clone();
            let bg_url = api_url.clone();
            let bg_token = final_token.clone();
            let bg_arc = track_cache_arc.clone();
            let bg_total = total_size;

            let track_id_bg = query.id.clone();
            let task = tokio::spawn(async move {
                let mut current = background_start;
                let limit = buffer_size_limit();
                while current < bg_total && current < start + limit {
                    let next_end = (current + 2 * 1024 * 1024 - 1).min(bg_total.saturating_sub(1)).min(start + limit - 1);
                    if let Ok(data) = fetch_range_from_drive(&bg_client, &bg_url, &bg_token, current, next_end).await {
                        let mut tc = bg_arc.lock().await;
                        // verify window hasn't changed
                        if tc.window_start != start {
                            break; // User seeked, this task is obsolete
                        }
                        tc.buffer.extend_from_slice(&data);
                        current += data.len() as u64;
                        
                        // Emit event via Tauri IPC
                        if let Some(app) = crate::APP_HANDLE.get() {
                            let _ = app.emit("buffer-status", BufferState {
                                track_id: track_id_bg.clone(),
                                buffer_start_byte: tc.window_start,
                                buffer_end_byte: tc.window_start + tc.buffer.len() as u64,
                                total_size_byte: bg_total,
                            });
                        }
                    } else {
                        break;
                    }
                }
            });
            track_cache.fetch_task = Some(task);
        }
        
        // Return initial chunk
        let real_end = start + chunk.len() as u64 - 1;
        let body = axum::body::Body::from(chunk);
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, real_end, total_size))
            .header(header::CONTENT_LENGTH, (real_end - start + 1).to_string())
            .body(body)
            .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build body").into_response());
    }
}

async fn get_total_size(client: &Client, api_url: &str, token: &str) -> Option<(u64, String)> {
    let resp = client.head(api_url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .ok()?;
    let len = resp.headers().get(reqwest::header::CONTENT_LENGTH)?
        .to_str().ok()?
        .parse::<u64>().ok()?;
    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/mpeg")
        .to_string();
    Some((len, ctype))
}

async fn handle_rate_limit(now: u64) -> Response {
    let fail_count = FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
    let cooldown = {
        let base = 30u64;
        base.checked_shl(fail_count.min(4) as u32).unwrap_or(300).min(300)
    };
    GLOBAL_BACKOFF_UNTIL.store(now + cooldown, Ordering::Release);
    (StatusCode::SERVICE_UNAVAILABLE, "Rate limited — backing off").into_response()
}

async fn handle_options() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .body(axum::body::Body::empty())
        .unwrap()
}

pub fn start_proxy() {
    tauri::async_runtime::spawn(async move {
        let state = AppState {
            client: Client::new(),
            cache_store: Arc::new(Mutex::new(HashMap::new())),
        };

        let app = Router::new()
            .route("/stream", get(handle_stream).head(handle_stream).options(handle_options))
            .with_state(state);

        if let Ok(listener) = tokio::net::TcpListener::bind("127.0.0.1:0").await {
            if let Ok(addr) = listener.local_addr() {
                crate::PROXY_PORT.store(addr.port(), std::sync::atomic::Ordering::SeqCst);
                println!("Proxy server bound to port {}", addr.port());
            }
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("Proxy server error: {}", e);
            }
        }
    });
}
