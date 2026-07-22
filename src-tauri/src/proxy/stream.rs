use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    http::{HeaderMap, StatusCode, header},
};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use reqwest::Client;
use sha2::Sha256;
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use super::backoff::{compute_cooldown_secs, equal_jitter, full_jitter};
use super::cache::{CacheStore, TrackMeta};
use super::constants::{
    DEFAULT_TOTAL_SIZE_FALLBACK, FALLBACK_CONTENT_TYPE,
    FETCH_RETRY_ATTEMPTS, FETCH_RETRY_BASE_BACKOFF_SECS,
    PREFETCH_BATCH_SLICES, PREFETCH_POLL_INTERVAL_MS,
    PREFETCH_RATE_LIMIT_SLEEP_SECS, PREFETCH_YIELD_MS,
    RETRY_DEADLINE_SECS, STREAM_CHANNEL_BOUND, STREAM_RETRY_DELAY_MS,
    TOKEN_RECOVERY_TIMEOUT,
};
use super::content_type::{content_type_for_ext, trim_cached_slice};
use super::drive_error::{classify_drive_error, drive_err_response, DriveErr};
use super::range::parse_multi_range;
use super::types::{AppState, BufferState, StreamQuery};

pub fn now_epoch_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

pub async fn fetch_range_from_drive(
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

pub async fn recover_stream_token(old_token: &str) -> Option<String> {
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

pub async fn get_total_size(
    client: &Client,
    api_url: &str,
    token: &str,
) -> Result<(u64, String), DriveErr> {
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

pub async fn handle_rate_limit(now: u64) -> Response {
    let fail_count = super::FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
    let cooldown = equal_jitter(Duration::from_secs(compute_cooldown_secs(fail_count))).as_secs();
    super::GLOBAL_BACKOFF_UNTIL.store(now + cooldown, Ordering::Release);
    (StatusCode::SERVICE_UNAVAILABLE, [("X-Stream-Error-Type", "rate-limited")], "Rate limited — backing off").into_response()
}

pub async fn handle_options() -> Response {
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

pub async fn handle_stream(
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
    let backoff_until = super::GLOBAL_BACKOFF_UNTIL.load(Ordering::Acquire);
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

    // Look up the per-track meta in the bounded cache.
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

    // Override Drive's Content-Type using extension from signed URL
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

    // Store metadata in bounded cache
    {
        state.cache_store.insert(query.id.clone(), Arc::new(Mutex::new(TrackMeta {
            total_size,
            content_type: resolved_content_type.clone(),
        }))).await;
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

    let (disconnect_tx, mut disconnect_rx) = tokio::sync::watch::channel(false);
    let mut main_disconnect_rx = disconnect_tx.subscribe();

    tokio::spawn(async move {
        let mut current_offset = slice_start;
        let mut buffer_status_emitted = false;
        let mut bytes_sent = 0usize;
        let mut retry_deadline: Option<Instant> = None;
        while current_offset < slice_last {
            tokio::select! {
                biased;
                _ = main_disconnect_rx.changed() => break,
                _ = async {} => {}
            }
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
                        let delay = Duration::from_secs(FETCH_RETRY_BASE_BACKOFF_SECS.checked_shl(attempt).unwrap_or(FETCH_RETRY_BASE_BACKOFF_SECS));
                        tokio::time::sleep(full_jitter(delay)).await;
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
                        let delay = Duration::from_secs(FETCH_RETRY_BASE_BACKOFF_SECS.checked_shl(attempt).unwrap_or(FETCH_RETRY_BASE_BACKOFF_SECS));
                        tokio::time::sleep(full_jitter(delay)).await;
                        last_err = Some(e);
                    }
                }
            }

            match batch_data {
                Some(data) => {
                    slice_cache.batch_insert(&track_id, fetch_start, data).await;

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

                    if !buffer_status_emitted {
                        buffer_status_emitted = true;
                        let first_batch_end = (fetch_start + (count as u64) * crate::slice_cache::SLICE_SIZE).min(total_size);
                        if let Some(app) = crate::APP_HANDLE.get() {
                            let _ = app.emit("buffer-status", BufferState {
                                track_id: track_id.clone(),
                                buffer_start_byte: 0,
                                buffer_end_byte: first_batch_end,
                                total_size_byte: total_size,
                            });
                        }
                    }

                    retry_deadline = None;
                    super::GLOBAL_BACKOFF_UNTIL.store(0, Ordering::Release);
                    super::FAIL_COUNT.store(0, Ordering::Relaxed);
                    current_offset = fetch_end_slice;
                }
                None => {
                    let err = last_err.unwrap_or(DriveErr::Upstream);
                    eprintln!("[proxy] batch-fetch-fail: {:?}", err);

                    match err {
                        DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota => {
                            break;
                        }
                        DriveErr::Auth => {
                            break;
                        }
                        _ => {
                            if err == DriveErr::Rate {
                                let fail_count = super::FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                let cooldown = equal_jitter(Duration::from_secs(compute_cooldown_secs(fail_count))).as_secs();
                                super::GLOBAL_BACKOFF_UNTIL.store(
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

    let cancel = Arc::new(tokio::sync::Notify::new());
    {
        let mut guards = super::PREFETCH_CANCEL.lock().await;
        if let Some(old) = guards.insert(bg_id.clone(), cancel.clone()) {
            old.notify_waiters();
        }
    }
    let cancel_for_task = cancel.clone();
    let bg_id_for_task = bg_id.clone();

    let sema = super::PREFETCH_SEMAPHORE.clone();

    tokio::spawn(async move {
        let _permit = tokio::select! {
            biased;
            _ = cancel_for_task.notified() => return,
            _ = disconnect_rx.changed() => return,
            result = sema.acquire_owned() => match result {
                Ok(permit) => permit,
                Err(_) => return,
            },
        };

        struct CancelGuard {
            id: String,
            signal: Arc<tokio::sync::Notify>,
        }
        impl Drop for CancelGuard {
            fn drop(&mut self) {
                let id = self.id.clone();
                let signal = self.signal.clone();
                tauri::async_runtime::spawn(async move {
                    let mut guards = super::PREFETCH_CANCEL.lock().await;
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
            tokio::select! {
                _ = cancel_for_task.notified() => break,
                _ = disconnect_rx.changed() => break,
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
                        tokio::time::sleep(full_jitter(Duration::from_secs(PREFETCH_RATE_LIMIT_SLEEP_SECS))).await;
                    }
                }
            }
            offset = batch_end;
            tokio::time::sleep(std::time::Duration::from_millis(PREFETCH_YIELD_MS)).await;
        }
    });

    // Build streaming response
    let stream = ReceiverStream::new(rx)
        .map(move |chunk| {
            let _ = &disconnect_tx;
            Ok::<Bytes, std::convert::Infallible>(Bytes::from(chunk))
        });
    let body = axum::body::Body::from_stream(stream);

    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, resolved_content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", actual_start, actual_end, total_size))
        .header(header::CONTENT_LENGTH, desired_total.to_string())
        .body(body)
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build response body").into_response())
}
