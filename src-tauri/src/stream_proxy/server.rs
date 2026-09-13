//! Proxy engine: hyper 1.x HTTP/1 server + reqwest upstream fetch with manual
//! redirect following (Authorization re-applied per hop).
//!
//! Why hyper: a body-stream error makes hyper abort the connection (the h1
//! dispatcher maps it to `new_user_body`; the socket is dropped with the
//! connection future), so mpv sees a read error and reconnects. tiny_http
//! 0.12 could not close keep-alive connections from the server side (its
//! close decision came only from the REQUEST header) — that is why vòng-1's
//! idle timeout alone left mpv on a silent socket (incident 2026-09-13).
//! Each connection is its own tokio task; no worker threads to starve.

use std::{
    convert::Infallible, future::Future, io, net::TcpListener, pin::Pin, sync::Arc,
    task::{Context, Poll}, time::Duration,
};

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{header, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::time::{Instant, Sleep};

use super::TokenSource;

/// Notified once per synthesized terminal failure (502/504) with the fileId.
pub(crate) type ErrorSink = Arc<dyn Fn(String, u16) + Send + Sync>;

/// Redirect hops we are willing to follow manually before giving up (502).
const MAX_REDIRECTS: usize = 5;
/// Pause before retrying after an accept() failure, to avoid a hot error loop.
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(200);
/// A poll gap this much longer than the idle deadline counts as consumer
/// backpressure (hyper stops polling us while the client is not reading).
const BACKPRESSURE_GRACE: Duration = Duration::from_millis(100);
/// Upstream response headers mirrored to the client untouched. Content-Length
/// is included on purpose: hyper then frames the response with that length,
/// so an aborted body reaches the client as an incomplete message.
const PASSTHROUGH_HEADERS: [header::HeaderName; 6] = [
    header::CONTENT_TYPE, header::CONTENT_RANGE, header::ACCEPT_RANGES,
    header::ETAG, header::LAST_MODIFIED, header::CONTENT_LENGTH,
];

struct ProxyContext {
    client: reqwest::Client,
    base_url: String,
    tokens: Arc<dyn TokenSource>,
    headers_timeout: Duration,
    body_idle_timeout: Duration,
    sink: ErrorSink,
}

/// Fixed-message or streamed upstream body. Un-sync because reqwest's byte
/// stream is `Send` but not provably `Sync`; hyper only needs `Send`.
type ProxyBody = UnsyncBoxBody<Bytes, io::Error>;

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

/// Mirror the upstream response to the client: status, media headers, and the
/// upstream body wrapped in the idle-deadline stream. An error from that
/// stream is what makes hyper close the connection and release the player.
fn stream_response(context: &ProxyContext, file_id: &str, upstream: reqwest::Response) -> Response<ProxyBody> {
    let mut builder = Response::builder().status(upstream.status().as_u16());
    for name in PASSTHROUGH_HEADERS {
        if let Some(value) = upstream.headers().get(&name) {
            builder = builder.header(name, value.clone());
        }
    }
    let frames = upstream.bytes_stream().map(|chunk| match chunk {
        Ok(bytes) => Ok(Frame::data(bytes)),
        Err(body_error) => Err(io::Error::other(format!("upstream body error: {body_error}"))),
    });
    let body =
        StreamBody::new(IdleTimeoutStream::new(frames, context.body_idle_timeout, file_id.to_string())).boxed_unsync();
    builder.body(body).expect("hyper response builder always accepts this body")
}

/// Fails once the wrapped stream has been silent longer than `idle_timeout`
/// (a gap between chunks, not the total duration). The clock restarts on
/// every item and on a poll arriving more than `BACKPRESSURE_GRACE` after
/// its deadline — such a gap is consumer backpressure, not upstream silence.
struct IdleTimeoutStream<S> {
    inner: S,
    idle_timeout: Duration,
    file_id: String,
    deadline: Pin<Box<Sleep>>,
    last_poll: Instant,
    tripped: bool,
}

impl<S> IdleTimeoutStream<S> {
    fn new(inner: S, idle_timeout: Duration, file_id: String) -> Self {
        let deadline = Box::pin(tokio::time::sleep(idle_timeout));
        Self { inner, idle_timeout, file_id, deadline, last_poll: Instant::now(), tripped: false }
    }
}

impl<S> Stream for IdleTimeoutStream<S>
where
    S: Stream<Item = Result<Frame<Bytes>, io::Error>> + Unpin,
{
    type Item = Result<Frame<Bytes>, io::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.tripped {
            return Poll::Ready(None);
        }
        match this.inner.poll_next_unpin(cx) {
            Poll::Ready(Some(item)) => {
                this.deadline.as_mut().reset(Instant::now() + this.idle_timeout);
                Poll::Ready(Some(item))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => {
                let now = Instant::now();
                let poll_gap = now.duration_since(this.last_poll);
                let deadline_ready = this.deadline.as_mut().poll(cx).is_ready();
                this.last_poll = now;
                if !deadline_ready {
                    return Poll::Pending;
                }
                if poll_gap > this.idle_timeout + BACKPRESSURE_GRACE {
                    // That gap was consumer backpressure: restart the clock.
                    this.deadline.as_mut().reset(now + this.idle_timeout);
                    return Poll::Pending;
                }
                log::warn!(
                    "[stream-proxy] upstream body idle for {:?} (file {}) — aborting response",
                    this.idle_timeout, this.file_id
                );
                this.tripped = true;
                Poll::Ready(Some(Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("upstream body idle for {:?}", this.idle_timeout),
                ))))
            }
        }
    }
}

fn build_upstream_url(base_url: &str, file_id: &str) -> Result<url::Url, (u16, String)> {
    url::Url::parse(&format!("{base_url}/drive/v3/files/{file_id}?alt=media"))
        .map_err(|e| (400u16, format!("failed to build upstream URL: {e}")))
}

/// Drive file ids are `[A-Za-z0-9_-]+`; rejecting anything else keeps hostile
/// strings out of the upstream URL without needing percent-encoding.
fn is_valid_file_id(file_id: &str) -> bool {
    !file_id.is_empty()
        && file_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

async fn fetch_upstream(
    context: &ProxyContext,
    mut url: url::Url,
    token: Option<&str>,
    range: Option<&str>,
) -> Result<reqwest::Response, (u16, String)> {
    for _ in 0..MAX_REDIRECTS {
        let mut request = context.client.get(url.clone());
        if let Some(token) = token {
            // Re-applied on every hop: this is why redirects are manual.
            request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(range) = range {
            request = request.header(reqwest::header::RANGE, range);
        }
        let sent = match tokio::time::timeout(context.headers_timeout, request.send()).await {
            Err(_elapsed) => return Err((504, format!("upstream did not respond within {:?}", context.headers_timeout))),
            Ok(Err(send_error)) => return Err((502, format!("upstream request failed: {send_error}"))),
            Ok(Ok(sent)) => sent,
        };
        if sent.status().is_redirection() {
            let location = sent.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok())
                .ok_or_else(|| (502u16, "upstream redirect without Location header".to_string()))?;
            url = url.join(location)
                .map_err(|e| (502u16, format!("upstream redirect has invalid Location: {e}")))?;
            continue;
        }
        return Ok(sent);
    }
    Err((502, format!("upstream exceeded {MAX_REDIRECTS} redirects")))
}

fn message_response(status: StatusCode, message: &str) -> Response<ProxyBody> {
    let body = Full::new(Bytes::from(message.to_string()))
        .map_err(|never: Infallible| -> io::Error { match never {} })
        .boxed_unsync();
    Response::builder().status(status).body(body).expect("static response always builds")
}
#[cfg(test)]
mod spike_tests {
    //! Manual spike against the real Google Drive API (mirrors the Task 1
    //! `mpv_real_pipeline_spike` pattern). Run with:
    //! `cargo test real_drive_range_spike -- --ignored --nocapture`
    //! Requires a signed-in refresh token in the OS credential vault; it uses
    //! the stored credential only — no secrets are hard-coded or printed.

    use super::*;
    use crate::stream_proxy::DriveTokenSource;

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "spike against the real Google Drive API"]
    async fn real_drive_range_spike() {
        let tokens: Arc<dyn TokenSource> = Arc::new(DriveTokenSource::default());
        let access = Arc::clone(&tokens)
            .refresh(false)
            .await
            .expect("access token must be mintable (sign in via the app first)");
        println!("access token minted (length {})", access.len());

        // Pick one real audio file through the Drive listing API.
        let client = reqwest::Client::new();
        let list = client
            .get("https://www.googleapis.com/drive/v3/files")
            .query(&[
                ("pageSize", "5"),
                ("q", "mimeType contains 'audio/'"),
                ("fields", "files(id,name)"),
                ("orderBy", "modifiedTime desc"),
            ])
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {access}"))
            .send()
            .await
            .expect("files.list request must succeed");
        assert_eq!(list.status(), 200, "files.list failed");
        let listing: serde_json::Value = list.json().await.expect("files.list must return JSON");
        let files = listing["files"].as_array().cloned().unwrap_or_default();
        assert!(!files.is_empty(), "no audio files found in this Drive");
        let file_id = files[0]["id"].as_str().expect("file id must be a string").to_string();
        let file_name = files[0]["name"].as_str().unwrap_or("?").to_string();
        println!("spiking with file: {file_name} ({file_id})");

        // Raw upstream probe with redirects disabled: does Drive answer 200
        // directly or 302 to googleusercontent.com (the manual-follow case)?
        let no_follow = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("probe client must build");
        let direct = no_follow
            .get(format!("https://www.googleapis.com/drive/v3/files/{file_id}"))
            .query(&[("alt", "media")])
            .header(reqwest::header::RANGE, "bytes=0-1023")
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {access}"))
            .send()
            .await
            .expect("direct upstream probe must succeed");
        println!("direct upstream status (Policy::none): {}", direct.status());

        // Start the production proxy (real base URL, real token source).
        let sink: ErrorSink = Arc::new(|file_id: String, status: u16| {
            println!("[spike] stream-proxy-error {file_id} {status}");
        });
        let port = spawn_proxy(
            sink,
            "https://www.googleapis.com".to_string(),
            tokens,
            Duration::from_secs(15),
            crate::stream_proxy::UPSTREAM_BODY_IDLE_TIMEOUT,
        )
        .expect("proxy must start");

        // Range request through the proxy, exactly like mpv will issue.
        let response = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/stream/{file_id}"))
            .header(reqwest::header::RANGE, "bytes=0-1023")
            .send()
            .await
            .expect("proxy request must succeed");
        let status = response.status().as_u16();
        let content_range = response
            .headers()
            .get("content-range")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = response.bytes().await.expect("body must stream");
        println!("proxy status: {status}");
        println!("proxy content-range: {:?}", content_range);
        println!("proxy body bytes: {}", body.len());

        assert_eq!(status, 206, "expected 206 Partial Content through the proxy");
        assert_eq!(body.len(), 1024, "expected exactly 1024 body bytes");
        assert!(
            content_range
                .as_deref()
                .map(|value| value.starts_with("bytes 0-1023/"))
                .unwrap_or(false),
            "Content-Range must cover bytes 0-1023"
        );
        println!("SPIKE OK: 206 + 1024 bytes + Content-Range through the localhost proxy");
    }
}
