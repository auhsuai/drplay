use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    routing::get,
    Router,
    http::{HeaderMap, StatusCode, header},
};
use reqwest::Client;
use serde::Deserialize;

#[derive(Clone)]
struct AppState {
    client: Client,
}

#[derive(Deserialize)]
pub struct StreamQuery {
    pub id: String,
    pub secret: String,
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

    let final_token = if let Ok(t) = crate::GLOBAL_STREAM_TOKEN.lock() {
        t.clone()
    } else {
        String::new()
    };

    if final_token.is_empty() {
        return (StatusCode::UNAUTHORIZED, "No token").into_response();
    }

    let api_url = format!("https://www.googleapis.com/drive/v3/files/{}?alt=media&acknowledgeAbuse=true", query.id);
    let mut req_builder = state.client.get(&api_url)
        .header("Authorization", format!("Bearer {}", final_token));

    if let Some(range) = headers.get(header::RANGE) {
        req_builder = req_builder.header(header::RANGE, range);
    }

    let resp_res = req_builder.send().await;
    match resp_res {
        Ok(resp) => {
            let mut builder = Response::builder()
                .status(resp.status())
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
            builder.body(body).unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build body").into_response())
        }
        Err(_) => {
            (StatusCode::BAD_GATEWAY, "Gateway Error").into_response()
        }
    }
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
