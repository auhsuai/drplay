//! Proxy engine: hyper 1.x HTTP/1 server + reqwest upstream fetch with manual
//! redirect following (Authorization sent only to the configured base origin,
//! non-https hops refused) and retry/backoff on retryable upstream statuses.
//!
//! Why hyper: a body-stream error makes hyper abort the connection (the h1
//! dispatcher maps it to `new_user_body`; the socket is dropped with the
//! connection future), so mpv sees a read error and reconnects. tiny_http
//! 0.12 could not close keep-alive connections from the server side (its
//! close decision came only from the REQUEST header) — that is why vòng-1's
//! idle timeout alone left mpv on a silent socket (incident 2026-09-13).
//! Each connection is its own tokio task; no worker threads to starve.

use std::{convert::Infallible, net::TcpListener, sync::Arc, time::Duration};

use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{header, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;

use super::response::{message_response, stream_response};
use super::types::{ProxyBody, ProxyContext};
use super::upstream::{build_upstream_url, fetch_upstream, is_valid_file_id};
use super::TokenSource;

/// Re-exported so the call sites outside this module (`stream_proxy::mod`,
/// `mpv::video_lifecycle::{drive, proxy}`) keep using
/// `crate::stream_proxy::server::ErrorSink`; the definition lives in `types`
/// because `response` shares it.
pub(crate) use super::types::ErrorSink;

/// Pause before retrying after an accept() failure, to avoid a hot error loop.
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(200);

pub(crate) fn spawn_proxy(
    sink: ErrorSink,
    drive_base_url: String,
    tokens: Arc<dyn TokenSource>,
    upstream_headers_timeout: Duration,
    upstream_body_idle_timeout: Duration,
) -> Result<u16, String> {
    // Bind synchronously so the port is live the moment spawn_proxy returns.
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("stream proxy: failed to bind 127.0.0.1:0: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| format!("stream proxy: set_nonblocking: {e}"))?;
    let port = listener.local_addr().map_err(|e| format!("stream proxy: local_addr: {e}"))?.port();
    let listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|e| format!("stream proxy: register with tokio: {e}"))?;
    // Redirects are followed by hand (see fetch_upstream): automatic following
    // strips the Authorization header on cross-origin hops.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("stream proxy: upstream client: {e}"))?;
    let context = Arc::new(ProxyContext {
        client, base_url: drive_base_url, tokens, sink,
        headers_timeout: upstream_headers_timeout, body_idle_timeout: upstream_body_idle_timeout,
    });
    // Ambient runtime: callers (the Tauri command, tests) are always inside
    // one, and it keeps hyper's I/O driver alive for the process lifetime.
    tokio::spawn(accept_loop(listener, context));
    log::info!("[stream-proxy] listening on 127.0.0.1:{port}");
    Ok(port)
}

async fn accept_loop(listener: tokio::net::TcpListener, context: Arc<ProxyContext>) {
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _peer)) => stream,
            Err(accept_error) => {
                log::error!("[stream-proxy] failed to accept connection: {accept_error}");
                tokio::time::sleep(ACCEPT_RETRY_DELAY).await;
                continue;
            }
        };
        let context = Arc::clone(&context);
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let context = Arc::clone(&context);
                async move { Ok::<_, Infallible>(handle_request(request, context).await) }
            });
            // Errors are routine: the client may hang up, or the idle abort
            // below closes the connection on purpose.
            if let Err(e) = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await {
                log::debug!("[stream-proxy] connection ended: {e}");
            }
        });
    }
}

async fn handle_request(request: Request<Incoming>, context: Arc<ProxyContext>) -> Response<ProxyBody> {
    if request.method() != Method::GET {
        return message_response(StatusCode::METHOD_NOT_ALLOWED, "only GET is supported");
    }
    // uri().path() already excludes the query string.
    let Some(file_id) = request.uri().path().strip_prefix("/stream/") else {
        return message_response(StatusCode::NOT_FOUND, "unknown path; expected /stream/{fileId}");
    };
    if !is_valid_file_id(file_id) {
        return message_response(StatusCode::BAD_REQUEST, "invalid file id");
    }
    let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    match fetch_stream(&context, file_id, range).await {
        Ok(response) => response,
        Err((status, message)) => {
            log::warn!("[stream-proxy] file {file_id}: responding {status}: {message}");
            if matches!(status, 502 | 504) {
                (context.sink)(file_id.to_string(), status);
            }
            let status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
            message_response(status, &message)
        }
    }
}

async fn fetch_stream(
    context: &ProxyContext,
    file_id: &str,
    range: Option<String>,
) -> Result<Response<ProxyBody>, (u16, String)> {
    // Seed a token up front (single-flight when several requests start cold).
    let token = match context.tokens.current() {
        Some(token) => token,
        None => Arc::clone(&context.tokens).refresh(false).await
            .map_err(|e| (502u16, format!("failed to obtain access token: {e}")))?,
    };
    let url = build_upstream_url(&context.base_url, file_id)?;
    let mut upstream = fetch_upstream(context, url.clone(), Some(&token), range.as_deref()).await?;
    if upstream.status() == reqwest::StatusCode::UNAUTHORIZED {
        // Exactly one refresh, then one retry; a second 401 is terminal (502).
        let fresh = Arc::clone(&context.tokens).refresh(true).await
            .map_err(|e| (502u16, format!("token refresh failed after upstream 401: {e}")))?;
        upstream = fetch_upstream(context, url.clone(), Some(&fresh), range.as_deref()).await?;
        if upstream.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err((502, "upstream rejected the request again after a token refresh".to_string()));
        }
    }
    Ok(stream_response(context, file_id, upstream))
}

#[cfg(test)]
mod spike_tests;

#[cfg(test)]
mod tests;
