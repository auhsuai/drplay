use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use reqwest::Client;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use lazy_static::lazy_static;

lazy_static! {
    static ref FILE_SIZE_LOCKS: tokio::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::OnceCell<Result<u64, String>>>>> = tokio::sync::Mutex::new(std::collections::HashMap::new());
}

async fn fetch_size_from_drive(
    file_id: &str,
    token: &str,
    client: &reqwest::Client,
) -> Result<u64, String> {
    let url = format!("https://www.googleapis.com/drive/v3/files/{}?fields=size", file_id);
    let resp = client.get(&url).header("Authorization", format!("Bearer {}", token)).send().await
        .map_err(|e| format!("Network error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Metadata API failed with status {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct FileMeta { size: Option<String> }

    let meta: FileMeta = resp.json().await.map_err(|_| "Invalid metadata JSON")?;
    if let Some(size_str) = meta.size {
        size_str.parse().map_err(|_| "Failed to parse size".to_string())
    } else {
        Err("File size not found in metadata".to_string())
    }
}

async fn get_authoritative_file_size(
    file_id: &str,
    token: &str,
    client: &reqwest::Client,
) -> Result<u64, String> {
    let cell = {
        let mut locks = FILE_SIZE_LOCKS.lock().await;
        locks.entry(file_id.to_string())
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::OnceCell::new()))
            .clone()
    };

    let file_id_owned = file_id.to_string();
    let token_owned = token.to_string();
    let client_owned = client.clone();
    
    let result = cell.get_or_init(|| async move {
        fetch_size_from_drive(&file_id_owned, &token_owned, &client_owned).await
    }).await.clone();

    if result.is_err() {
        let mut locks = FILE_SIZE_LOCKS.lock().await;
        locks.remove(file_id);
    }

    result
}

fn parse_range_header(range_str: &str, total_size: u64) -> (u64, u64) {
    let range_part = range_str.trim_start_matches("bytes=");
    let mut parts = range_part.splitn(2, '-');
    
    let start: u64 = parts.next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
        .min(total_size.saturating_sub(1));

    let end: u64 = parts.next()
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse().ok())
        .unwrap_or(total_size.saturating_sub(1))
        .min(total_size.saturating_sub(1))
        .max(start);

    (start, end)
}

#[derive(Clone)]
pub struct AppState {
    pub pool: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    pub client: Client,
    pub app_handle: AppHandle,
}

#[derive(Deserialize)]
pub struct StreamQuery {
    pub id: String,
    pub ext: Option<String>,
}

#[derive(Deserialize)]
pub struct CoverQuery {
    pub id: String,
    pub thumb: Option<bool>,
}

pub async fn handle_stream(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Query(query): axum::extract::Query<StreamQuery>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    use axum::http::StatusCode;
    use axum::http::header;

    let mut final_token = String::new();
    if let Ok(global) = crate::GLOBAL_STREAM_TOKEN.lock() {
        if !global.is_empty() {
            final_token = global.clone();
        }
    }
    
    if final_token.is_empty() {
        return axum::response::Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(axum::body::Body::empty())
            .unwrap();
    }

    let total_size = match get_authoritative_file_size(&query.id, &final_token, &state.client).await {
        Ok(s) => s,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("Cannot determine file size: {}", e)).into_response();
        }
    };

    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let (start, end, is_partial) = match range {
        Some(r) => {
            let (s, e) = parse_range_header(r, total_size);
            (s, e, true)
        }
        None => (0, total_size.saturating_sub(1), false),
    };

    if start >= total_size && total_size > 0 {
        return axum::response::Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{}", total_size))
            .body(axum::body::Body::empty())
            .unwrap();
    }

    let url = format!("https://www.googleapis.com/drive/v3/files/{}?alt=media&acknowledgeAbuse=true", query.id);
    
    let mut req_builder = state.client.get(&url)
        .header("Authorization", format!("Bearer {}", final_token));
        
    if is_partial {
        let drive_range_header = format!("bytes={}-{}", start, end);
        req_builder = req_builder.header(header::RANGE, drive_range_header);
    }

    let resp_res = req_builder.send().await;
    
    let resp = match resp_res {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("Failed to connect to Drive: {}", e)).into_response();
        }
    };

    let status = resp.status();
    
    if status.as_u16() == 401 { 
        let _ = state.app_handle.emit("token-expired", ()); 
        
        let wait_result = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            crate::GLOBAL_TOKEN_NOTIFY.notified()
        ).await;
        
        if wait_result.is_ok() {
            let mut fresh_token = String::new();
            if let Ok(global) = crate::GLOBAL_STREAM_TOKEN.lock() {
                fresh_token = global.clone();
            }
            
            let mut retry_req_builder = state.client.get(&url)
                .header("Authorization", format!("Bearer {}", fresh_token));
                
            if is_partial {
                let drive_range_header = format!("bytes={}-{}", start, end);
                retry_req_builder = retry_req_builder.header(header::RANGE, drive_range_header);
            }
            
            if let Ok(retry_resp) = retry_req_builder.send().await {
                let retry_status = retry_resp.status();
                if retry_status.is_success() || retry_status == StatusCode::PARTIAL_CONTENT {
                    let content_length = end - start + 1;
                    let mut builder = axum::response::Response::builder();
                    if is_partial {
                        builder = builder.status(StatusCode::PARTIAL_CONTENT)
                            .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, total_size));
                    } else {
                        builder = builder.status(StatusCode::OK);
                    }
                    builder = builder
                        .header(header::CONTENT_LENGTH, content_length.to_string())
                        .header(header::ACCEPT_RANGES, "bytes")
                        .header(header::CONTENT_TYPE, "audio/mpeg")
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

                    let stream = retry_resp.bytes_stream();
                    let body = axum::body::Body::from_stream(stream);
                    return builder.body(body).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build retry body").into_response());
                }
            }
        }
        
        return axum::response::Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header("X-Stream-Error-Type", "token_expired")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(axum::body::Body::empty())
            .unwrap();
    }
    
    if status == StatusCode::NOT_FOUND || status == StatusCode::FORBIDDEN {
        return axum::response::Response::builder()
            .status(status)
            .header("X-Stream-Error-Type", "permanent")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(axum::body::Body::empty())
            .unwrap();
    }
    
    if status == StatusCode::TOO_MANY_REQUESTS {
        let _ = state.app_handle.emit("drive-quota-exceeded", ());
        return axum::response::Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("X-Stream-Error-Type", "rate_limited")
            .header("Retry-After", "5")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(axum::body::Body::empty())
            .unwrap();
    }
    
    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        return axum::response::Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header("X-Stream-Error-Type", "transient")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(axum::body::Body::empty())
            .unwrap();
    }

    let drive_ct = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok());

    let final_cl = (end - start + 1).to_string();
    
    let mut final_ct = drive_ct.unwrap_or("audio/mpeg").to_string();
    if let Some(ref e) = query.ext {
        let e_lower = e.to_lowercase();
        if e_lower == "m4a" || e_lower == "mp4" {
            final_ct = "audio/mp4".to_string();
        } else if e_lower == "flac" {
            final_ct = "audio/flac".to_string();
        } else if e_lower == "wav" {
            final_ct = "audio/wav".to_string();
        } else if e_lower == "mp3" {
            final_ct = "audio/mpeg".to_string();
        } else if e_lower == "opus" {
            final_ct = "audio/opus".to_string();
        } else if e_lower == "ogg" || e_lower == "oga" {
            final_ct = "audio/ogg".to_string();
        } else if e_lower == "webm" {
            final_ct = "audio/webm".to_string();
        } else if e_lower == "aac" {
            final_ct = "audio/aac".to_string();
        }
    }

    let mut builder = axum::response::Response::builder();
    if status == StatusCode::PARTIAL_CONTENT || is_partial {
        builder = builder.status(StatusCode::PARTIAL_CONTENT);
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, total_size));
    } else {
        builder = builder.status(StatusCode::OK);
    }
    
    builder = builder
        .header(header::CONTENT_LENGTH, final_cl)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, final_ct)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

    let stream = resp.bytes_stream();
    let body = axum::body::Body::from_stream(stream);

    builder.body(body).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build body").into_response())
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
            .pool_max_idle_per_host(2) // Chỉ giữ tối đa 2 connection rảnh rỗi cho mỗi host
            .pool_idle_timeout(std::time::Duration::from_secs(15)) // Đóng connection nếu rảnh quá 15s
            .tcp_keepalive(std::time::Duration::from_secs(30)) // Dọn dẹp ở tầng OS TCP
            .build()
            .unwrap(),
        app_handle,
    };

    tauri::async_runtime::spawn(async move {
        let app = Router::new()
            .route("/stream", get(handle_stream).head(handle_stream))
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
