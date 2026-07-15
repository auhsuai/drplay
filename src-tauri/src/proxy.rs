use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    routing::get,
    Router,
    http::{HeaderMap, StatusCode, header},
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
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
const MAX_BG_RETRIES: u32 = 3;

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
    pub exp: u64,
    pub sig: String,
    pub ext: Option<String>,
}

fn now_epoch_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
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

/// Classified upstream failure. Distinguishing these lets the frontend react
/// correctly instead of treating every 403 as a transient rate limit.
#[derive(Clone, Copy, PartialEq, Debug)]
enum DriveErr {
    /// 429 / *rateLimitExceeded / dailyLimitExceeded — retry with backoff.
    Rate,
    /// 403 downloadQuotaExceeded — this file's download cap is exhausted.
    DownloadQuota,
    /// 403 insufficientFilePermissions / fileNotDownloadable — no access.
    AccessDenied,
    /// 404 notFound — file deleted or no longer visible.
    NotFound,
    /// 401 — OAuth token expired.
    Auth,
    /// 5xx / transport / malformed — retry a few times then give up.
    Upstream,
}

/// Extract Drive's machine-readable `error.errors[0].reason`, lowercased.
fn extract_drive_reason(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v.get("error")?
        .get("errors")?
        .as_array()?
        .first()?
        .get("reason")?
        .as_str()
        .map(|s| s.to_ascii_lowercase())
}

/// Map an upstream HTTP status + JSON body to a `DriveErr`.
/// The reason string is authoritative; status code is the fallback.
fn classify_drive_error(status: u16, body: &str) -> DriveErr {
    if let Some(reason) = extract_drive_reason(body) {
        // Exact matches first so downloadQuotaExceeded is not swallowed by the
        // generic "quotaexceeded" contains-check below.
        match reason.as_str() {
            "downloadquotaexceeded" => return DriveErr::DownloadQuota,
            "insufficientfilepermissions"
            | "filenotdownloadable"
            | "appnotauthorizedtofile"
            | "domainpolicy"
            | "cannotdownloadfile" => return DriveErr::AccessDenied,
            _ => {}
        }
        if reason.contains("notfound") {
            return DriveErr::NotFound;
        }
        if reason.contains("ratelimitexceeded")
            || reason.contains("dailylimitexceeded")
            || reason.contains("quotaexceeded")
        {
            return DriveErr::Rate;
        }
    }
    match status {
        401 => DriveErr::Auth,
        404 => DriveErr::NotFound,
        // Unknown 403/429 without a reason: stay conservative and back off
        // rather than skip a track that might just be throttled.
        403 | 429 => DriveErr::Rate,
        _ => DriveErr::Upstream,
    }
}

/// Build the terminal HTTP response for a non-retryable `DriveErr`.
fn drive_err_response(e: DriveErr) -> Response {
    match e {
        DriveErr::NotFound => (StatusCode::FORBIDDEN, [("X-Stream-Error-Type", "permanent")], "File not found").into_response(),
        DriveErr::AccessDenied => (StatusCode::FORBIDDEN, [("X-Stream-Error-Type", "access-denied")], "Access denied").into_response(),
        DriveErr::DownloadQuota => (StatusCode::FORBIDDEN, [("X-Stream-Error-Type", "download-quota")], "Download quota exceeded").into_response(),
        DriveErr::Auth => (StatusCode::UNAUTHORIZED, [("X-Stream-Error-Type", "auth-expired")], "Auth expired").into_response(),
        _ => (StatusCode::BAD_GATEWAY, "Upstream error").into_response(),
    }
}

async fn fetch_range_from_drive(
    client: &Client,
    api_url: &str,
    token: &str,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, DriveErr> {
    let range = format!("bytes={}-{}", start, end);
    let resp = client.get(api_url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Range", &range)
        .send()
        .await
          .map_err(|_| DriveErr::Upstream)?;

    let status = resp.status();
    if !status.is_success() && status != 206 {
        let code = status.as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(classify_drive_error(code, &body));
    }
    
    let expected_len = (end - start + 1) as usize;
    let bytes = resp.bytes().await.map_err(|_| DriveErr::Upstream)?;
    
    if bytes.len() != expected_len && end != u64::MAX {
        return Err(DriveErr::Upstream);
    }
    
    Ok(bytes.to_vec())
}

async fn forward_multipart_range(
    client: &Client,
    api_url: &str,
    token: &str,
    ranges: &[(u64, u64)],
    total_size: u64,
) -> Result<Response, DriveErr> {
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

/// Called when a Drive request fails with 401 (expired OAuth token). Signals the
/// frontend to refresh the token, then waits (bounded) for `update_stream_token`
/// to publish a new one and returns it. Returns None on timeout / no change so
/// the caller can surface an explicit auth error instead of a generic 502.
async fn recover_stream_token(old_token: &str) -> Option<String> {
    // Register interest on the notify BEFORE emitting, otherwise a fast frontend
    // refresh could call notify_waiters() before we start waiting -> lost wakeup.
    let notify = crate::GLOBAL_TOKEN_NOTIFY.clone();
    let notified = notify.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();

    if let Some(app) = crate::APP_HANDLE.get() {
        let _ = app.emit("token-expired", ());
    }

    tokio::select! {
        _ = &mut notified => {}
        _ = tokio::time::sleep(std::time::Duration::from_secs(8)) => {
            return None;
        }
    }

    let new_token = crate::GLOBAL_STREAM_TOKEN.lock().await.clone();
    if new_token.is_empty() || new_token == old_token {
        None
    } else {
        Some(new_token)
    }
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

    // HMAC signature verification
    if let Some(expected_secret) = crate::PROXY_SECRET.get() {
        let now = now_epoch_secs();
        if now > query.exp {
            return (StatusCode::FORBIDDEN, [("X-Stream-Error-Type", "url-expired")], "URL expired").into_response();
        }

        let ext_str = query.ext.clone().unwrap_or_default();
        let payload = format!("{}:{}:{}", query.id, ext_str, query.exp);
        let mut mac = match Hmac::<Sha256>::new_from_slice(expected_secret.as_bytes()) {
            Ok(m) => m,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "HMAC init error").into_response(),
        };
        mac.update(payload.as_bytes());
        let expected_sig = mac.finalize().into_bytes()
            .iter().map(|b| format!("{:02x}", b)).collect::<String>();

        if expected_sig.len() != query.sig.len() {
            return (StatusCode::UNAUTHORIZED, "Invalid signature").into_response();
        }
        let mut diff = 0u8;
        for (a, b) in expected_sig.bytes().zip(query.sig.bytes()) {
            diff |= a ^ b;
        }
        if diff != 0 {
            return (StatusCode::UNAUTHORIZED, "Invalid signature").into_response();
        }
    } else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Not initialized").into_response();
    }

    // Global cooldown gate
    let now = now_epoch_secs();
    let backoff_until = GLOBAL_BACKOFF_UNTIL.load(Ordering::Acquire);
    if now < backoff_until {
        return (StatusCode::SERVICE_UNAVAILABLE, [("X-Stream-Error-Type", "rate-limited")], "Rate limited — cooldown active").into_response();
    }

    let mut final_token = crate::GLOBAL_STREAM_TOKEN.lock().await.clone();

    if final_token.is_empty() {
        // No token yet (e.g. play attempted before the frontend seeded it, or it
        // was cleared). Ask the frontend to (re)publish a token before giving up.
        match recover_stream_token(&final_token).await {
            Some(t) => { final_token = t; }
            None => return (StatusCode::UNAUTHORIZED, [("X-Stream-Error-Type", "auth-expired")], "No token").into_response(),
        }
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

    // For HEAD (the frontend's classification probe) always re-validate against
    // Drive so a file deleted / access-revoked *after* its size was cached is
    // still surfaced with the correct X-Stream-Error-Type header.
    let (total_size, content_type) = if total_size == 0 || method == axum::http::Method::HEAD {
        match get_total_size(&state.client, &api_url, &final_token).await {
            Ok(v) => v,
            Err(DriveErr::Auth) => {
                // Expired token on the probe. Recover once before deciding.
                match recover_stream_token(&final_token).await {
                    Some(t) => {
                        final_token = t;
                        match get_total_size(&state.client, &api_url, &final_token).await {
                            Ok(v) => v,
                            Err(DriveErr::Rate) => return handle_rate_limit(now).await,
                            Err(e @ (DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota | DriveErr::Auth)) => return drive_err_response(e),
                            Err(_) => (10_000_000, "audio/mpeg".to_string()),
                        }
                    }
                    None => return drive_err_response(DriveErr::Auth),
                }
            }
            Err(DriveErr::Rate) => return handle_rate_limit(now).await,
            Err(e @ (DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota)) => return drive_err_response(e),
            Err(_) => (10_000_000, "audio/mpeg".to_string()),
        }
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
        for attempt in 0..2 {
            match forward_multipart_range(&state.client, &api_url, &final_token, &ranges, total_size).await {
                Ok(r) => {
                    FAIL_COUNT.store(0, Ordering::Relaxed);
                    return r;
                }
                Err(DriveErr::Rate) => {
                    return handle_rate_limit(now).await;
                }
                Err(DriveErr::Auth) if attempt == 0 => {
                    match recover_stream_token(&final_token).await {
                        Some(t) => { final_token = t; continue; }
                        None => return drive_err_response(DriveErr::Auth),
                    }
                }
                Err(e @ (DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota)) => {
                    return drive_err_response(e);
                }
                Err(_) => {
                    return (StatusCode::BAD_GATEWAY, "Upstream error").into_response();
                }
            }
        }
        return (StatusCode::BAD_GATEWAY, "Upstream error").into_response();
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
                Err(DriveErr::Rate) => {
                    if attempt == max_retries - 1 {
                        return handle_rate_limit(now).await;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                }
                Err(DriveErr::Auth) => {
                    // Expired token mid-stream. Signal the frontend, wait for a
                    // fresh token, then retry with it (no fixed backoff needed).
                    match recover_stream_token(&final_token).await {
                        Some(t) => { final_token = t; continue; }
                        None => return drive_err_response(DriveErr::Auth),
                    }
                }
                Err(e @ (DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota)) => {
                    // Non-retryable: file gone / no access / per-file quota spent.
                    return drive_err_response(e);
                }
                Err(_) => {
                    if attempt == max_retries - 1 {
                        return (StatusCode::BAD_GATEWAY, "Gateway Error").into_response();
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                }
            }
        }

        if chunk.is_empty() {
            // Exhausted retries (e.g. repeated token expiry) without any data.
            return (StatusCode::BAD_GATEWAY, "Gateway Error").into_response();
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
                    let data = match bg_fetch_with_retry(
                        |s, e| fetch_range_from_drive(&bg_client, &bg_url, &bg_token, s, e),
                        current, next_end, MAX_BG_RETRIES,
                    ).await {
                        Ok(d) => d,
                        Err(DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota) => break,
                        Err(_) => break,
                    };
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

/// Probe a file's total size + content type. Uses a 1-byte ranged GET (not HEAD)
/// so that on failure we can read Drive's JSON error body and classify the
/// reason (deleted vs. access revoked vs. quota vs. throttled).
async fn get_total_size(client: &Client, api_url: &str, token: &str) -> Result<(u64, String), DriveErr> {
    let resp = client.get(api_url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Range", "bytes=0-0")
        .send()
        .await
        .map_err(|_| DriveErr::Upstream)?;
    let status = resp.status();
    if !status.is_success() && status != 206 {
        let code = status.as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(classify_drive_error(code, &body));
    }
    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/mpeg")
        .to_string();
    // A 206 response carries the true total in Content-Range: "bytes 0-0/<TOTAL>".
    let total = resp.headers().get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.rsplit('/').next())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .or_else(|| resp.headers().get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok()))
        .ok_or(DriveErr::Upstream)?;
    Ok((total, ctype))
}

async fn handle_rate_limit(now: u64) -> Response {
    let fail_count = FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
    let cooldown = {
        let base = 30u64;
        base.checked_shl(fail_count.min(4) as u32).unwrap_or(300).min(300)
    };
    GLOBAL_BACKOFF_UNTIL.store(now + cooldown, Ordering::Release);
    (StatusCode::SERVICE_UNAVAILABLE, [("X-Stream-Error-Type", "rate-limited")], "Rate limited — backing off").into_response()
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

async fn bg_fetch_with_retry<F, Fut>(
    fetch: F,
    current: u64,
    next_end: u64,
    max_retries: u32,
) -> Result<Vec<u8>, DriveErr>
where
    F: Fn(u64, u64) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u8>, DriveErr>>,
{
    let mut last_err = DriveErr::Upstream;
    for attempt in 0..=max_retries {
        match fetch(current, next_end).await {
            Ok(data) => return Ok(data),
            Err(DriveErr::Rate) => {
                tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                last_err = DriveErr::Rate;
            }
            Err(DriveErr::Auth) => {
                last_err = DriveErr::Auth;
                break;
            }
            Err(e @ (DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota)) => {
                return Err(e);
            }
            Err(e) => {
                tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                last_err = e;
            }
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;
    use std::sync::Arc;

    async fn simulate_background_prefetch<F, Fut>(
        start: u64,
        total_size: u64,
        chunk_size: u64,
        fetch: F,
    ) -> Result<(), DriveErr>
    where
        F: Fn(u64, u64) -> Fut,
        Fut: std::future::Future<Output = Result<Vec<u8>, DriveErr>>,
    {
        let end = (start + chunk_size - 1).min(total_size.saturating_sub(1));
        bg_fetch_with_retry(|s, e| fetch(s, e), start, end, MAX_BG_RETRIES).await?;
        Ok(())
    }

    #[tokio::test]
    async fn test_background_prefetch_retries_on_transient_error() {
        let attempts = Arc::new(AtomicU32::new(0));
        let max_ok_after = 3u32;
        let att = Arc::clone(&attempts);
        let flaky_fetch = move |start, end| {
            let a = Arc::clone(&att);
            async move {
                let n = a.fetch_add(1, Ordering::SeqCst);
                if n < max_ok_after {
                    Err(DriveErr::Rate)
                } else {
                    Ok(vec![0u8; (end - start + 1) as usize])
                }
            }
        };
        let result = simulate_background_prefetch(0, 1024 * 1024 * 4, 2 * 1024 * 1024, flaky_fetch).await;
        assert!(result.is_ok());
        assert_eq!(attempts.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn test_background_prefetch_hard_error_no_retry() {
        let attempts = Arc::new(AtomicU32::new(0));
        let att = Arc::clone(&attempts);
        let hard_fetch = move |_, _| {
            let a = Arc::clone(&att);
            async move {
                a.fetch_add(1, Ordering::SeqCst);
                Err(DriveErr::NotFound)
            }
        };
        let result = simulate_background_prefetch(0, 1024 * 1024 * 4, 2 * 1024 * 1024, hard_fetch).await;
        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }
}
