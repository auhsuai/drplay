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

#[derive(Clone)]
pub struct AppState {
    pub pool: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    pub client: Client,
    pub app_handle: AppHandle,
}

#[derive(Deserialize)]
pub struct StreamQuery {
    pub id: String,
    pub duration: Option<f64>,
}

#[derive(Deserialize)]
pub struct CoverQuery {
    pub id: String,
    pub thumb: Option<bool>,
}

pub async fn handle_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<StreamQuery>,
) -> Response {
    let mut final_token = String::new();
    if let Ok(global) = crate::GLOBAL_STREAM_TOKEN.lock() {
        if !global.is_empty() {
            final_token = global.clone();
        }
    }
    
    if final_token.is_empty() {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(axum::body::Body::empty())
            .unwrap();
    }

    let url = format!("https://www.googleapis.com/drive/v3/files/{}?alt=media&acknowledgeAbuse=true", query.id);
    let mut req_builder = state.client.get(&url).header("Authorization", format!("Bearer {}", final_token));

    // Forward the Range header if provided by the client (browser)
    if let Some(range) = headers.get(header::RANGE) {
        req_builder = req_builder.header(header::RANGE, range.clone());
    }

    let resp_res = req_builder.send().await;
    
    let resp = match resp_res {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("Failed to connect to Drive: {}", e)).into_response();
        }
    };

    let status = resp.status();
    
    // Handle specific Google Drive API Errors transparently
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
            
            let mut retry_req_builder = state.client.get(&url).header("Authorization", format!("Bearer {}", fresh_token));
            if let Some(range) = headers.get(header::RANGE) {
                retry_req_builder = retry_req_builder.header(header::RANGE, range.clone());
            }
            
            if let Ok(retry_resp) = retry_req_builder.send().await {
                let retry_status = retry_resp.status();
                if retry_status.is_success() || retry_status == StatusCode::PARTIAL_CONTENT {
                    let mut builder = Response::builder().status(retry_status);
                    
                    if let Some(ct) = retry_resp.headers().get(header::CONTENT_TYPE) {
                        let mut ct_str = ct.to_str().unwrap_or("").to_string();
                        if ct_str.is_empty() || ct_str == "application/json" {
                            ct_str = "audio/mpeg".to_string();
                        }
                        builder = builder.header(header::CONTENT_TYPE, ct_str);
                    } else {
                        builder = builder.header(header::CONTENT_TYPE, "audio/mpeg");
                    }

                    if let Some(cl) = retry_resp.headers().get(header::CONTENT_LENGTH) {
                        builder = builder.header(header::CONTENT_LENGTH, cl.clone());
                    }
                    if let Some(cr) = retry_resp.headers().get(header::CONTENT_RANGE) {
                        builder = builder.header(header::CONTENT_RANGE, cr.clone());
                    }
                    
                    builder = builder.header(header::ACCEPT_RANGES, "bytes");
                    builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

                    let stream = retry_resp.bytes_stream();
                    let body = axum::body::Body::from_stream(stream);

                    return builder.body(body).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build retry body").into_response());
                }
            }
        }
        
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header("X-Stream-Error-Type", "token_expired")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(axum::body::Body::empty())
            .unwrap();
    }
    
    if status == StatusCode::NOT_FOUND || status == StatusCode::FORBIDDEN {
        return Response::builder()
            .status(status)
            .header("X-Stream-Error-Type", "permanent")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(axum::body::Body::empty())
            .unwrap();
    }
    
    if status == StatusCode::TOO_MANY_REQUESTS {
        let _ = state.app_handle.emit("drive-quota-exceeded", ());
        return Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("X-Stream-Error-Type", "rate_limited")
            .header("Retry-After", "5")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(axum::body::Body::empty())
            .unwrap();
    }
    
    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        return Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header("X-Stream-Error-Type", "transient")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(axum::body::Body::empty())
            .unwrap();
    }

    // Build the Axum response, copying necessary headers from Google Drive's response
    let mut builder = Response::builder().status(status);
    
    if let Some(ct) = resp.headers().get(header::CONTENT_TYPE) {
        let mut ct_str = ct.to_str().unwrap_or("").to_string();
        if ct_str.is_empty() || ct_str == "application/json" {
            ct_str = "audio/mpeg".to_string();
        }
        builder = builder.header(header::CONTENT_TYPE, ct_str);
    } else {
        builder = builder.header(header::CONTENT_TYPE, "audio/mpeg");
    }

    if let Some(cl) = resp.headers().get(header::CONTENT_LENGTH) {
        builder = builder.header(header::CONTENT_LENGTH, cl.clone());
    }
    
    if let Some(cr) = resp.headers().get(header::CONTENT_RANGE) {
        builder = builder.header(header::CONTENT_RANGE, cr.clone());
    }
    
    builder = builder.header(header::ACCEPT_RANGES, "bytes");
    builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

    // Convert Reqwest Stream into Axum Body
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
            .build()
            .unwrap(),
        app_handle,
    };

    tauri::async_runtime::spawn(async move {
        let app = Router::new()
            .route("/stream.mp3", get(handle_stream).head(handle_stream))
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
