pub mod auth;
pub mod drive;
pub mod fetcher;
pub mod prefetch;

use std::sync::Arc;
use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    http::{HeaderMap, StatusCode, header},
};
use bytes::Bytes;
use tokio::sync::Mutex;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use crate::proxy::cache::TrackMeta;
use crate::proxy::constants::{
    DEFAULT_TOTAL_SIZE_FALLBACK, FALLBACK_CONTENT_TYPE,
    STREAM_CHANNEL_BOUND,
};
use crate::proxy::content_type::content_type_for_ext;
use crate::proxy::drive_error::{DriveErr, drive_err_response};
use crate::proxy::range::parse_multi_range;
use crate::proxy::types::{AppState, StreamQuery};
use crate::proxy::stream::auth::{recover_stream_token, handle_rate_limit, verify_signature, now_epoch_secs};
use crate::proxy::stream::drive::get_total_size;

pub async fn handle_options() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .body(axum::body::Body::empty())
        .unwrap_or_else(|e| {
            log::error!("[proxy] failed to build OPTIONS response: {e}");
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

    if let Some(expected_secret) = crate::PROXY_SECRET.get() {
        if let Err(err_resp) = verify_signature(&query, expected_secret) {
            return err_resp;
        }
    } else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Not initialized").into_response();
    }

    let now = now_epoch_secs();
    let backoff_until = crate::proxy::GLOBAL_BACKOFF_UNTIL.load(std::sync::atomic::Ordering::Acquire);
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

    let cached_meta = state.cache_store.get(&query.id).await;
    let (total_size, content_type) = match cached_meta {
        Some(arc) => {
            let tc = arc.lock().await;
            (tc.total_size, tc.content_type.clone())
        }
        None => (0, String::new()),
    };

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

    let resolved_content_type = match query.ext.as_deref().and_then(content_type_for_ext) {
        Some(ct) => {
            log::debug!("[proxy] content-type override: ext={} -> {}", query.ext.as_deref().unwrap_or(""), ct);
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

        let mut head_builder = Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, resolved_content_type)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CONTENT_LENGTH, (real_end - start + 1).to_string());
        if status == StatusCode::PARTIAL_CONTENT {
            head_builder = head_builder.header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, real_end, total_size));
        }
        return head_builder.body(axum::body::Body::empty())
            .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build HEAD body").into_response());
    }

    let (start, end) = if ranges.len() > 1 {
        (0u64, total_size.saturating_sub(1))
    } else {
        let r = ranges.first().cloned().unwrap_or((0, total_size.saturating_sub(1)));
        (r.0, r.1.min(total_size.saturating_sub(1)))
    };

    {
        state.cache_store.insert(query.id.clone(), Arc::new(Mutex::new(TrackMeta {
            total_size,
            content_type: resolved_content_type.clone(),
        }))).await;
    }

    let slice_start = (start / crate::slice_cache::SLICE_SIZE) * crate::slice_cache::SLICE_SIZE;
    let slice_last = ((end / crate::slice_cache::SLICE_SIZE) + 1) * crate::slice_cache::SLICE_SIZE;
    let desired_total = (end - start + 1) as usize;

    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(STREAM_CHANNEL_BOUND);
    let (disconnect_tx, disconnect_rx) = tokio::sync::watch::channel(false);

    // Spawn the active fetcher
    fetcher::spawn_fetcher(
        state.client.clone(),
        api_url.clone(),
        final_token.clone(),
        query.id.clone(),
        total_size,
        start,
        end,
        slice_start,
        slice_last,
        desired_total,
        state.slice_cache.clone(),
        tx,
        disconnect_rx.clone(),
    );

    // Spawn the background prefetcher
    prefetch::spawn_prefetcher(
        state.client.clone(),
        api_url.clone(),
        final_token.clone(),
        query.id.clone(),
        total_size,
        end + 1,
        state.slice_cache.clone(),
        state.buffer_seconds.clone(),
        disconnect_rx,
    );

    let stream = ReceiverStream::new(rx)
        .map(move |chunk| {
            let _ = &disconnect_tx;
            Ok::<Bytes, std::convert::Infallible>(Bytes::from(chunk))
        });
    let body = axum::body::Body::from_stream(stream);

    let get_status = if range_str.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };

    let mut resp_builder = Response::builder()
        .status(get_status)
        .header(header::CONTENT_TYPE, resolved_content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CONTENT_LENGTH, desired_total.to_string());
    if get_status == StatusCode::PARTIAL_CONTENT {
        resp_builder = resp_builder.header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, total_size));
    }
    resp_builder.body(body)
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build response body").into_response())
}
