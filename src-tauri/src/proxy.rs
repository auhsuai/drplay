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

// --- Named constants: no magic numbers / strings on the production path ---
// Reqwest total per-request timeout (conn + read). Bounds every Drive call so a
// stalled socket cannot hang a stream task forever (reqwest docs: Client::builder().timeout).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
// Bounded wait for a fresh OAuth token via the global Notify.
const TOKEN_RECOVERY_TIMEOUT: Duration = Duration::from_secs(8);
// Retry attempts for a transient Drive batch fetch before giving up.
const FETCH_RETRY_ATTEMPTS: u32 = 3;
// Base (seconds) for exponential backoff between fetch retries: 1 << attempt.
const FETCH_RETRY_BASE_BACKOFF_SECS: u64 = 1;
// Bounded mpsc buffer between the fetch task and the streaming response.
const STREAM_CHANNEL_BOUND: usize = 8;
// Consecutive slices fetched/looked-up in one batch (find_missing_run count).
const PREFETCH_BATCH_SLICES: usize = 4;
// Global rate-limit cooldown: base seconds, hard cap, and shift exponent cap.
const COOLDOWN_BASE_SECS: u64 = 30;
const COOLDOWN_MAX_SECS: u64 = 300;
const COOLDOWN_EXP_CAP: u32 = 4;
// Overall transient-retry budget for one stream (not per-attempt).
const RETRY_DEADLINE_SECS: u64 = 5;
// Sleep when a background prefetch hits a rate limit.
const PREFETCH_RATE_LIMIT_SLEEP_SECS: u64 = 5;
// Delay between transient retry attempts in the main fetch loop.
const STREAM_RETRY_DELAY_MS: u64 = 500;
// Poll interval / yield for the background prefetch task.
const PREFETCH_POLL_INTERVAL_MS: u64 = 1;
const PREFETCH_YIELD_MS: u64 = 50;
// Fallback total size (10 MB) and Content-Type used only when Drive cannot be
// probed (network down). Never forwarded as a real value to the WebView logic.
const DEFAULT_TOTAL_SIZE_FALLBACK: u64 = 10_000_000;
const FALLBACK_CONTENT_TYPE: &str = "audio/mpeg";

/// Exponential backoff (seconds) for the global rate-limit cooldown, hard-capped.
/// `fail_count` is the post-increment value of `FAIL_COUNT`.
fn compute_cooldown_secs(fail_count: u32) -> u64 {
    COOLDOWN_BASE_SECS
        .checked_shl(fail_count.min(COOLDOWN_EXP_CAP) as u32)
        .unwrap_or(COOLDOWN_MAX_SECS)
        .min(COOLDOWN_MAX_SECS)
}

/// Trim a cached slice to the requested byte window: drop `skip` leading bytes
/// on the very first slice, then truncate to `remaining` bytes at the tail.
/// Used identically on both the cache-hit and batch-send paths.
fn trim_cached_slice(chunk: &mut Vec<u8>, skip: usize, remaining: usize) {
    if skip < chunk.len() {
        chunk.drain(..skip);
    }
    if remaining < chunk.len() {
        chunk.truncate(remaining);
    }
}

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

type CacheStore = moka::future::Cache<String, Arc<Mutex<TrackMeta>>>;

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
        _ = tokio::time::sleep(TOKEN_RECOVERY_TIMEOUT) => {
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

/// Map a file extension to its canonical audio MIME type.
///
/// Google Drive frequently returns `application/octet-stream` (or a stale type)
/// for FLAC and other lossless files. The `ext` query param is already part of
/// the signed URL, so when it maps to a known type we OVERRIDE Drive's
/// Content-Type. Without this, the WebView cannot pick a demuxer for an
/// `octet-stream` FLAC stream and rejects it with `MEDIA_ERR_SRC_NOT_SUPPORTED`,
/// causing the frontend to wrongly skip a perfectly playable track as a
/// "format error". Chromium/WebView2 decode FLAC natively when served as
/// `audio/flac` (see MDN: Chrome/Edge FLAC = Yes; chromium.org audio codecs).
fn content_type_for_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "flac" => Some("audio/flac"),
        "ogg" | "oga" => Some("audio/ogg"),
        "opus" => Some("audio/ogg"),
        "wav" => Some("audio/wav"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "mp3" => Some("audio/mpeg"),
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("audio/webm"),
        "caf" => Some("audio/x-caf"),
        "aiff" | "aif" => Some("audio/aiff"),
        _ => None,
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

    // Look up the per-track meta in the bounded cache. A miss (entry not present
    // or already evicted) is a graceful cache miss — the caller re-probes Drive
    // below, exactly like the original "no entry" path. No panic, no 500.
    let cached_meta = state.cache_store.get(&query.id).await;
    let (total_size, content_type) = match cached_meta {
        Some(arc) => {
            let tc = arc.lock().await;
            (tc.total_size, tc.content_type.clone())
        }
        None => (0, String::new()),
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
                            Err(_) => (DEFAULT_TOTAL_SIZE_FALLBACK, FALLBACK_CONTENT_TYPE.to_string()),
                        }
                    }
                    None => return drive_err_response(DriveErr::Auth),
                }
            }
            Err(DriveErr::Rate) => return handle_rate_limit(now).await,
            Err(e @ (DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota)) => return drive_err_response(e),
            Err(_) => (DEFAULT_TOTAL_SIZE_FALLBACK, FALLBACK_CONTENT_TYPE.to_string()),
        }
    } else {
        (total_size, content_type)
    };

    // Override Drive's (often wrong) Content-Type using the extension carried in
    // the signed URL. This is what lets lossless formats like FLAC actually play
    // in the WebView instead of being rejected as a "format error".
    let resolved_content_type = match query.ext.as_deref().and_then(content_type_for_ext) {
        Some(ct) => {
            eprintln!("[proxy] content-type override: ext={} -> {}", query.ext.as_deref().unwrap_or(""), ct);
            ct.to_string()
        }
        None => content_type,
    };

    let range_str = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let ranges = range_str.map(|r| parse_multi_range(r, total_size)).unwrap_or_default();

    if method == axum::http::Method::HEAD {
        let (start, end) = ranges.first().cloned().unwrap_or((0, total_size.saturating_sub(1)));
        let real_end = end.min(total_size.saturating_sub(1));
        let status = if range_str.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
        
        return Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, resolved_content_type)
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

    // Store metadata in the bounded cache. The cache self-evicts (LRU + TinyLFU
    // admission once `max_capacity` is reached) so the native process RSS stays
    // bounded regardless of how many distinct tracks are streamed.
    {
        state.cache_store.insert(query.id.clone(), Arc::new(Mutex::new(TrackMeta {
            total_size,
            content_type: resolved_content_type.clone(),
        }))).await;
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

    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(STREAM_CHANNEL_BOUND);
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
                    let skip = if current_offset == slice_start && actual_start > slice_start {
                        (actual_start - slice_start) as usize
                    } else {
                        0
                    };
                    let remaining = desired_total.saturating_sub(bytes_sent);
                    trim_cached_slice(&mut chunk, skip, remaining);

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
                &track_id, current_offset, PREFETCH_BATCH_SLICES,
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
            for attempt in 0..FETCH_RETRY_ATTEMPTS {
                match fetch_range_from_drive(
                    &fetch_client, &fetch_api_url, &fetch_token,
                    fetch_start, fetch_end_byte,
                ).await {
                    Ok(data) => {
                        batch_data = Some(data);
                        break;
                    }
                    Err(DriveErr::Rate) => {
                        tokio::time::sleep(std::time::Duration::from_secs(FETCH_RETRY_BASE_BACKOFF_SECS.checked_shl(attempt).unwrap_or(FETCH_RETRY_BASE_BACKOFF_SECS))).await;
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
                        tokio::time::sleep(std::time::Duration::from_secs(FETCH_RETRY_BASE_BACKOFF_SECS.checked_shl(attempt).unwrap_or(FETCH_RETRY_BASE_BACKOFF_SECS))).await;
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
                            let skip = if slice_offset == slice_start && actual_start > slice_start {
                                (actual_start - slice_start) as usize
                            } else {
                                0
                            };
                            let remaining = desired_total.saturating_sub(bytes_sent);
                            trim_cached_slice(&mut chunk, skip, remaining);

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

                    retry_deadline = None;
                    // A successful batch means Drive recovered — clear any stale
                    // global rate-limit cooldown so subsequent requests (e.g. an
                    // auto-skip to the next track) are not immediately 503'd.
                    GLOBAL_BACKOFF_UNTIL.store(0, Ordering::Release);
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
                            let cooldown = compute_cooldown_secs(fail_count);
                            GLOBAL_BACKOFF_UNTIL.store(
                                    now_epoch_secs() + cooldown,
                                    Ordering::Release,
                                );
                            }
                            let deadline = retry_deadline.get_or_insert_with(|| Instant::now() + Duration::from_secs(RETRY_DEADLINE_SECS));
                            if Instant::now() >= *deadline {
                                eprintln!("[proxy] batch-fetch-retry-exhausted (5s)");
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(STREAM_RETRY_DELAY_MS)).await;
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
                _ = tokio::time::sleep(std::time::Duration::from_millis(PREFETCH_POLL_INTERVAL_MS)) => {}
            }
            let (first_missing, count) = slice_cache.find_missing_run(&bg_id_for_task, offset, PREFETCH_BATCH_SLICES).await;
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
                        tokio::time::sleep(std::time::Duration::from_secs(PREFETCH_RATE_LIMIT_SLEEP_SECS)).await;
                    }
                }
            }
            offset = batch_end;
            tokio::time::sleep(std::time::Duration::from_millis(PREFETCH_YIELD_MS)).await;
        }
    });

    // Build streaming response
    let stream = ReceiverStream::new(rx)
        .map(|chunk| Ok::<Bytes, std::convert::Infallible>(Bytes::from(chunk)));
    let body = axum::body::Body::from_stream(stream);

    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, resolved_content_type)
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
        .unwrap_or(FALLBACK_CONTENT_TYPE)
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
        .unwrap_or_else(|e| {
            eprintln!("[proxy] failed to build OPTIONS response: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "").into_response()
        })
}

pub fn start_proxy() {
    tauri::async_runtime::spawn(async move {
        let client = match Client::builder().timeout(REQUEST_TIMEOUT).build() {
            Ok(c) => c,
            Err(e) => {
                // A bare Client::new() is the safe fallback (it never times out,
                // but the proxy still boots). Log so the missing timeout is visible.
                eprintln!("[proxy] reqwest client build failed (timeout={REQUEST_TIMEOUT:?}): {e}");
                Client::new()
            }
        };
        let state = AppState {
            client,
            cache_store: new_cache_store(),
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

/// Bounded track-metadata cache.
///
/// Root cause (P0-1): the original `cache_store` was an unbounded
/// `Arc<Mutex<HashMap<String, ...>>>` that inserted a fresh `TrackMeta` for
/// every track ever streamed and NEVER evicted. With a ~12 000-track library
/// the native Rust process RSS grew without bound on every play.
///
/// This replaces it with a `moka` bounded cache: `max_capacity` keeps the
/// entry count bounded (LRU + TinyLFU admission), and `time_to_idle` drops
/// entries that have not been touched in a while. The async `moka::future`
/// API matches the `COVER_CACHE`/`ETAG_CACHE` pattern already used in
/// `protocol.rs`. A missing entry is simply a cache miss (graceful fallback,
/// never a panic or a 500) — callers re-probe Drive on miss.
const TRACK_CACHE_MAX_ENTRIES: u64 = 2000;
const TRACK_CACHE_IDLE_TTL: Duration = Duration::from_secs(30 * 60); // 30 min

fn new_cache_store() -> CacheStore {
    moka::future::Cache::builder()
        .max_capacity(TRACK_CACHE_MAX_ENTRIES)
        .time_to_idle(TRACK_CACHE_IDLE_TTL)
        .build()
}

#[cfg(test)]
mod tests {
    use super::content_type_for_ext;
    use super::{new_cache_store, TrackMeta, TRACK_CACHE_MAX_ENTRIES};
    use std::sync::Arc;
    use tokio::sync::Mutex;

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

    #[test]
    fn test_content_type_for_ext_maps_flac_and_is_case_insensitive() {
        // The root-cause fix: FLAC must be served as audio/flac, not Drive's
        // application/octet-stream, otherwise the WebView rejects it with
        // MEDIA_ERR_SRC_NOT_SUPPORTED and the track is wrongly skipped.
        assert_eq!(content_type_for_ext("flac"), Some("audio/flac"));
        assert_eq!(content_type_for_ext("FLAC"), Some("audio/flac"));
        assert_eq!(content_type_for_ext("Ogg"), Some("audio/ogg"));
        assert_eq!(content_type_for_ext("wav"), Some("audio/wav"));
        assert_eq!(content_type_for_ext("m4a"), Some("audio/mp4"));
        assert_eq!(content_type_for_ext("aac"), Some("audio/aac"));
        assert_eq!(content_type_for_ext("mp3"), Some("audio/mpeg"));
        // Unknown extensions are NOT overridden — proxy keeps Drive's content type.
        assert_eq!(content_type_for_ext("xyz"), None);
        assert_eq!(content_type_for_ext(""), None);
    }

    // Regression for P0-1 (RAM leak): the track-metadata cache must be bounded.
    // The old implementation used an unbounded `HashMap` and inserted a fresh
    // `TrackMeta` for every track ever streamed with NO eviction, so RSS grew
    // without bound across a ~12k-track library. This test inserts far more
    // than the cap and asserts the cache stays bounded — which fails (compile
    // error / unbounded growth) on the old code and passes on the bounded cache.
    #[tokio::test]
    async fn test_track_cache_is_bounded_and_evicts() {
        // Re-create the same bounded cache the proxy uses in production.
        let cache = new_cache_store();
        let cap = TRACK_CACHE_MAX_ENTRIES;

        // Insert 5x the cap in distinct keys — simulating repeated plays across
        // a large library.
        for i in 0..(cap * 5) {
            let meta = Arc::new(Mutex::new(TrackMeta {
                total_size: 1_000_000,
                content_type: "audio/mpeg".to_string(),
            }));
            cache.insert(format!("track-{i}"), meta).await;
        }

        // Drive moka's admission/eviction so the count reflects the cap.
        cache.run_pending_tasks().await;

        let count = cache.entry_count();
        assert!(
            count <= cap,
            "track cache must stay bounded (<= {cap}), but held {count} entries"
        );
    }
}
