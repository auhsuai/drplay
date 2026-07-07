use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    routing::get,
    Router,
    http::{HeaderMap, StatusCode, header},
};
use reqwest::Client;
use serde::Deserialize;

use std::sync::atomic::{AtomicU64, AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
struct AppState {
    client: Client,
}

#[derive(Deserialize)]
pub struct StreamQuery {
    pub id: String,
    pub secret: String,
}

fn now_epoch_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
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
    headers: HeaderMap,
) -> Response {
    if query.id.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing ID").into_response();
    }

    if let Some(expected_secret) = crate::PROXY_SECRET.get() {
        if query.secret != *expected_secret {
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

    let final_token = if let Ok(t) = crate::GLOBAL_STREAM_TOKEN.lock() {
        t.clone()
    } else {
        String::new()
    };

    if final_token.is_empty() {
        return (StatusCode::UNAUTHORIZED, "No token").into_response();
    }

    let api_url = format!("https://www.googleapis.com/drive/v3/files/{}?alt=media&acknowledgeAbuse=true", query.id);

    // Parse multi-range
    let range_str = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let total_size = get_total_size(&state.client, &api_url, &final_token).await.unwrap_or(10_000_000);

    let ranges = range_str.map(|r| parse_multi_range(r, total_size)).unwrap_or_default();

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

    // Single-range or no-range (legacy path)
    let range_value = ranges.first().map(|(s, e)| format!("bytes={}-{}", s, e));

    let max_retries = 3;
    for attempt in 0..max_retries {
        let mut req_builder = state.client.get(&api_url)
            .header("Authorization", format!("Bearer {}", final_token));

        if let Some(ref r) = range_value {
            req_builder = req_builder.header(header::RANGE, r.as_str());
        }

        let resp_res = req_builder.send().await;
        match resp_res {
            Ok(resp) => {
                let status = resp.status();
                if status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::FORBIDDEN {
                    let retry_after = resp.headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(0);

                    let fail_count = FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                    let cooldown = if retry_after > 0 {
                        retry_after
                    } else {
                        let base = 30u64;
                        base.checked_shl(fail_count.min(4) as u32).unwrap_or(300).min(300)
                    };
                    GLOBAL_BACKOFF_UNTIL.store(now + cooldown, Ordering::Release);

                    if attempt < max_retries - 1 {
                        tokio::time::sleep(std::time::Duration::from_secs((1u64 << attempt).min(4))).await;
                        continue;
                    }
                    return (StatusCode::SERVICE_UNAVAILABLE, "Rate limited — backing off").into_response();
                }

                FAIL_COUNT.store(0, Ordering::Relaxed);

                let mut builder = Response::builder()
                    .status(status)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_TYPE, "audio/mpeg")
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

                if let Some(cl) = resp.headers().get(reqwest::header::CONTENT_LENGTH) {
                    builder = builder.header(header::CONTENT_LENGTH, cl);
                }
                if let Some(cr) = resp.headers().get(reqwest::header::CONTENT_RANGE) {
                    builder = builder.header(header::CONTENT_RANGE, cr);
                }

                let stream = resp.bytes_stream();
                let body = axum::body::Body::from_stream(stream);
                return builder.body(body).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build body").into_response());
            }
            Err(_) => {
                if attempt < max_retries - 1 {
                    tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                    continue;
                }
                return (StatusCode::BAD_GATEWAY, "Gateway Error").into_response();
            }
        }
    }

    (StatusCode::BAD_GATEWAY, "Gateway Error").into_response()
}

async fn get_total_size(client: &Client, api_url: &str, token: &str) -> Option<u64> {
    let resp = client.head(api_url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .ok()?;
    let len = resp.headers().get(reqwest::header::CONTENT_LENGTH)?
        .to_str().ok()?
        .parse::<u64>().ok()?;
    Some(len)
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
        };

        let app = Router::new()
            .route("/stream", get(handle_stream).head(handle_stream).options(handle_options))
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
