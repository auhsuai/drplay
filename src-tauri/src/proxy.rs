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
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;
use bytes::Bytes;

use std::sync::atomic::{AtomicU64, AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::sync::Arc;
use tokio::sync::Mutex;
use std::collections::HashMap;
use once_cell::sync::Lazy;



#[derive(serde::Serialize, Clone)]
struct BufferState {
    track_id: String,
    buffer_start_byte: u64,
    buffer_end_byte: u64,
    total_size_byte: u64,
}

struct TrackMeta {
    total_size: u64,
    content_type: String,
}

type CacheStore = Arc<Mutex<HashMap<String, Arc<Mutex<TrackMeta>>>>>;

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

/// Per-track cancel signal for background prefetch tasks. When a new stream
/// request arrives for a track, the previous prefetch task (if any) is
/// signalled to stop so it stops filling the slice cache.
static PREFETCH_CANCEL: Lazy<Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

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

/// Called when a Drive request fails with 401 (expired OAuth token). Signals the
/// frontend to refresh the token, then waits (bounded) for `update_stream_token`
/// to publish a new one and returns it. Returns None on timeout / no change so
/// the caller can surface an explicit auth error instead of a generic 502.
async fn recover_stream_token(old_token: &str) -> Option<String> {
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

    // For HEAD always re-validate against Drive
    let (total_size, content_type) = if total_size == 0 || method == axum::http::Method::HEAD {
        match get_total_size(&state.client, &api_url, &final_token).await {
            Ok(v) => v,
            Err(DriveErr::Auth) => {
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

    // Multipart ranges → fall through to serve the full file as a single range
    let (start, end) = if ranges.len() > 1 {
        (0u64, total_size.saturating_sub(1))
    } else {
        let r = ranges.first().cloned().unwrap_or((0, total_size.saturating_sub(1)));
        (r.0, r.1.min(total_size.saturating_sub(1)))
    };

    // Store metadata
    {
        let mut store = state.cache_store.lock().await;
        store.insert(query.id.clone(), Arc::new(Mutex::new(TrackMeta {
            total_size,
            content_type: content_type.clone(),
        })));
        FAIL_COUNT.store(0, Ordering::Relaxed);
    }

    let slice_cache = match crate::GLOBAL_SLICE_CACHE.get() {
        Some(c) => c,
        None => return (StatusCode::INTERNAL_SERVER_ERROR, "Cache not initialized").into_response(),
    };

    // Align to SLICE_SIZE boundaries
    let slice_start = (start / crate::slice_cache::SLICE_SIZE) * crate::slice_cache::SLICE_SIZE;
    let slice_last = ((end / crate::slice_cache::SLICE_SIZE) + 1) * crate::slice_cache::SLICE_SIZE;
    let desired_total = (end - start + 1) as usize;

    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    let track_id = query.id.clone();
    let fetch_client = state.client.clone();
    let fetch_api_url = api_url.clone();
    let fetch_token = final_token.clone();
    let actual_start = start;
    let actual_end = end;

    tokio::spawn(async move {
        let mut current_offset = slice_start;
        let mut buffer_status_emitted = false;
        let mut bytes_sent = 0usize;
        let mut retry_deadline: Option<Instant> = None;

        while current_offset < slice_last {
            // Cache hit path
            if let Some(data) = slice_cache.try_get(&track_id, current_offset).await {
                let mut chunk = (*data).clone();

                // Front trim for first slice
                if current_offset == slice_start && actual_start > slice_start {
                    let skip = (actual_start - slice_start) as usize;
                    if skip < chunk.len() {
                        chunk.drain(..skip);
                    }
                }

                // End trim to match exact requested range
                let remaining = desired_total.saturating_sub(bytes_sent);
                if remaining < chunk.len() {
                    chunk.truncate(remaining);
                }

                bytes_sent += chunk.len();
                if !chunk.is_empty() {
                    if tx.send(chunk).await.is_err() {
                        break;
                    }
                }
                current_offset += crate::slice_cache::SLICE_SIZE;
                continue;
            }

            // Cache miss: find consecutive missing slices
            let (fetch_start, count) = slice_cache.find_missing_run(
                &track_id, current_offset, 4,
            ).await;

            if count == 0 {
                current_offset += crate::slice_cache::SLICE_SIZE;
                continue;
            }

            let fetch_end_slice = fetch_start + (count as u64) * crate::slice_cache::SLICE_SIZE;
            let fetch_end_byte = fetch_end_slice.min(total_size).saturating_sub(1);

            // Fetch batch from Drive (with retry)
            let mut last_err = None;
            let mut batch_data = None;
            for attempt in 0..3 {
                match fetch_range_from_drive(
                    &fetch_client, &fetch_api_url, &fetch_token,
                    fetch_start, fetch_end_byte,
                ).await {
                    Ok(data) => {
                        batch_data = Some(data);
                        break;
                    }
                    Err(DriveErr::Rate) => {
                        tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                        last_err = Some(DriveErr::Rate);
                    }
                    Err(DriveErr::Auth) => {
                        last_err = Some(DriveErr::Auth);
                        break;
                    }
                    Err(e @ (DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota)) => {
                        last_err = Some(e);
                        break;
                    }
                    Err(e) => {
                        tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                        last_err = Some(e);
                    }
                }
            }

            match batch_data {
                Some(data) => {
                    slice_cache.batch_insert(&track_id, fetch_start, data).await;

                    // Send each cached slice with trimming
                    for i in 0..count {
                        let slice_offset = fetch_start + (i as u64) * crate::slice_cache::SLICE_SIZE;
                        if slice_offset > actual_end {
                            break;
                        }
                        if let Some(cached) = slice_cache.try_get(&track_id, slice_offset).await {
                            let mut chunk = (*cached).clone();

                            // Front trim for first requested slice
                            if slice_offset == slice_start && actual_start > slice_start {
                                let skip = (actual_start - slice_start) as usize;
                                if skip < chunk.len() {
                                    chunk.drain(..skip);
                                }
                            }

                            // End trim to match exact range
                            let remaining = desired_total.saturating_sub(bytes_sent);
                            if remaining < chunk.len() {
                                chunk.truncate(remaining);
                            }

                            bytes_sent += chunk.len();
                            if !chunk.is_empty() {
                                if tx.send(chunk).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }

                    // Emit buffer-status once after first successful batch
                    if !buffer_status_emitted {
                        buffer_status_emitted = true;
                        if let Some(app) = crate::APP_HANDLE.get() {
                            let _ = app.emit("buffer-status", BufferState {
                                track_id: track_id.clone(),
                                buffer_start_byte: 0,
                                buffer_end_byte: total_size,
                                total_size_byte: total_size,
                            });
                        }
                    }

                    current_offset = fetch_end_slice;
                }
                None => {
                    let err = last_err.unwrap_or(DriveErr::Upstream);
                    eprintln!("[proxy] batch-fetch-fail: {:?}", err);

                    match err {
                        // Permanent errors — give up immediately
                        DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota => {
                            break;
                        }
                        // Auth exhaustion — give up
                        DriveErr::Auth => {
                            break;
                        }
                        // Transient errors (Rate, Upstream) — retry with 5s cap
                        _ => {
                            if err == DriveErr::Rate {
                                let fail_count = FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                let cooldown = {
                                    let base = 30u64;
                                    base.checked_shl(fail_count.min(4) as u32).unwrap_or(300).min(300)
                                };
                                GLOBAL_BACKOFF_UNTIL.store(
                                    now_epoch_secs() + cooldown,
                                    Ordering::Release,
                                );
                            }
                            let deadline = retry_deadline.get_or_insert_with(|| Instant::now() + Duration::from_secs(5));
                            if Instant::now() >= *deadline {
                                eprintln!("[proxy] batch-fetch-retry-exhausted (5s)");
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(500)).await;
                            continue;
                        }
                    }
                }
            }
        }
    });

    // Spawn background prefetch for slices ahead of requested range
    let bg_client = state.client.clone();
    let bg_url = api_url.clone();
    let bg_token = final_token.clone();
    let bg_id = query.id.clone();
    let bg_total = total_size;
    let bg_start = actual_end + 1;

    // Cancel any previously-running prefetch for this track, then register a
    // fresh cancel signal so the next request for this track stops this one.
    let cancel = Arc::new(tokio::sync::Notify::new());
    {
        let mut guards = PREFETCH_CANCEL.lock().await;
        if let Some(old) = guards.insert(bg_id.clone(), cancel.clone()) {
            old.notify_waiters();
        }
    }
    let cancel_for_task = cancel.clone();
    let bg_id_for_task = bg_id.clone();

    tokio::spawn(async move {
        // Remove this task's cancel entry from the global map when it exits,
        // but only if it is still the current entry (a newer request replaces it).
        struct CancelGuard {
            id: String,
            signal: Arc<tokio::sync::Notify>,
        }
        impl Drop for CancelGuard {
            fn drop(&mut self) {
                let id = self.id.clone();
                let signal = self.signal.clone();
                tauri::async_runtime::spawn(async move {
                    let mut guards = PREFETCH_CANCEL.lock().await;
                    if guards.get(&id).map(|s| Arc::ptr_eq(s, &signal)).unwrap_or(false) {
                        guards.remove(&id);
                    }
                });
            }
        }
        let _guard = CancelGuard { id: bg_id_for_task.clone(), signal: cancel_for_task.clone() };

        let slice_cache = match crate::GLOBAL_SLICE_CACHE.get() {
            Some(c) => c,
            None => return,
        };
        let max_bytes = {
            let seconds = crate::GLOBAL_BUFFER_SECONDS.load(Ordering::Relaxed) as u64;
            crate::buffer_bytes_for_seconds(seconds)
        };
        let max_offset = bg_start + max_bytes;
        let mut offset = bg_start;

        while offset < bg_total && offset < max_offset {
            // Stop early if a newer request cancelled this prefetch.
            tokio::select! {
                _ = cancel_for_task.notified() => break,
                _ = tokio::time::sleep(std::time::Duration::from_millis(1)) => {}
            }
            let (first_missing, count) = slice_cache.find_missing_run(&bg_id_for_task, offset, 4).await;
            if count == 0 {
                offset += crate::slice_cache::SLICE_SIZE;
                continue;
            }
            let batch_end = (first_missing + (count as u64) * crate::slice_cache::SLICE_SIZE).min(bg_total);
            match fetch_range_from_drive(&bg_client, &bg_url, &bg_token, first_missing, batch_end - 1).await {
                Ok(data) => {
                    slice_cache.batch_insert(&bg_id_for_task, first_missing, data).await;
                    if let Some(app) = crate::APP_HANDLE.get() {
                        let _ = app.emit("buffer-status", BufferState {
                            track_id: bg_id_for_task.clone(),
                            buffer_start_byte: 0,
                            buffer_end_byte: batch_end,
                            total_size_byte: bg_total,
                        });
                    }
                }
                Err(e) => {
                    eprintln!("[proxy] prefetch-batch-fail at {first_missing}: {e:?}");
                    if matches!(e, DriveErr::Rate) {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                }
            }
            offset = batch_end;
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });

    // Build streaming response
    let stream = ReceiverStream::new(rx)
        .map(|chunk| Ok::<Bytes, std::convert::Infallible>(Bytes::from(chunk)));
    let body = axum::body::Body::from_stream(stream);

    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", actual_start, actual_end, total_size))
        .body(body)
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build response body").into_response())
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

#[cfg(test)]
mod tests {
    fn assemble_chunks_in_order(chunks: &[(u64, u64, Vec<u8>)]) -> Vec<u8> {
        let mut buffer = Vec::with_capacity(chunks.iter().map(|c| c.2.len()).sum());
        for (_, _, data) in chunks {
            buffer.extend_from_slice(data);
        }
        buffer
    }

    #[tokio::test]
    async fn test_parallel_chunks_maintain_order() {
        let chunks = vec![
            (0, 1999, vec![1u8; 2000]),
            (2000, 3999, vec![2u8; 2000]),
            (4000, 5999, vec![3u8; 2000]),
        ];
        let buffer = assemble_chunks_in_order(&chunks);
        assert_eq!(buffer.len(), 6000);
        assert_eq!(buffer[0], 1);
        assert_eq!(buffer[2000], 2);
        assert_eq!(buffer[4000], 3);
    }
}
