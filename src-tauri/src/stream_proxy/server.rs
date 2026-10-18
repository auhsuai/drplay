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

use std::{
    convert::Infallible, future::Future, io, net::TcpListener, pin::Pin,
    sync::{atomic::{AtomicBool, Ordering}, Arc},
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

/// Notified exactly once per failed file request with the fileId and a status:
/// a synthesized 502/504, the real upstream status for a non-2xx pass-through,
/// `BODY_ERROR_STATUS` when the upstream body fails mid-stream (the client has
/// already received its headers), or `IDLE_ABORT_STATUS` when the upstream body
/// stalls and the response is aborted. Never fired for 405/404-path/400 (not
/// file failures).
pub(crate) type ErrorSink = Arc<dyn Fn(String, u16) + Send + Sync>;

/// Status reported to the error sink when the upstream body errors mid-stream
/// (connection reset / early EOF after 200/206 already went on the wire): the
/// response is truncated, same class of client-visible failure as the idle
/// abort, so it is reported as a synthesized 502.
const BODY_ERROR_STATUS: u16 = 502;

/// Status reported to the error sink when the upstream body goes idle
/// mid-stream and the response is aborted. The client has already received
/// 200/206 and sees a broken body instead; 499 never appears on the wire.
/// `pub(crate)` so stream_proxy's own tests can assert the exact reported status
/// instead of hardcoding 499 next to the constant.
pub(crate) const IDLE_ABORT_STATUS: u16 = 499;

/// Redirect hops we are willing to follow manually before giving up (502).
const MAX_REDIRECTS: usize = 5;
/// Backoff before each status retry: ~250ms, then ~1s. No jitter: a single
/// local player does not herd, and fixed delays keep the fixture exact.
const STATUS_RETRY_BACKOFFS: [Duration; 2] = [Duration::from_millis(250), Duration::from_secs(1)];
/// Retries after the initial attempt for a retryable status (3 requests max).
const MAX_STATUS_RETRIES: usize = STATUS_RETRY_BACKOFFS.len();
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
    let status = upstream.status();
    // The sink must observe each request at most once: a non-2xx body that
    // later stalls is already accounted for here, so the idle abort stays
    // quiet for it.
    let notified = Arc::new(AtomicBool::new(!status.is_success()));
    if !status.is_success() {
        (context.sink)(file_id.to_string(), status.as_u16());
    }
    let mut builder = Response::builder().status(status.as_u16());
    for name in PASSTHROUGH_HEADERS {
        if let Some(value) = upstream.headers().get(&name) {
            builder = builder.header(name, value.clone());
        }
    }
    let frames = upstream.bytes_stream().map(|chunk| match chunk {
        Ok(bytes) => Ok(Frame::data(bytes)),
        // reqwest attaches the request URL to stream errors (Display ends with
        // "for url (...)") — redact before the text reaches any log.
        Err(body_error) => Err(io::Error::other(
            redact_urls(format!("upstream body error: {body_error}")),
        )),
    });
    let body = StreamBody::new(IdleTimeoutStream::new(
        frames,
        context.body_idle_timeout,
        file_id.to_string(),
        Arc::clone(&context.sink),
        notified,
    ))
    .boxed_unsync();
    builder.body(body).expect("hyper response builder always accepts this body")
}

/// Fails once the wrapped stream has been silent longer than `idle_timeout`
/// (a gap between chunks, not the total duration). The clock restarts on
/// every item and on a poll arriving more than `BACKPRESSURE_GRACE` after
/// its deadline — such a gap is consumer backpressure, not upstream silence.
/// On trip it reports `IDLE_ABORT_STATUS` to the sink exactly once (via
/// `notified`), unless this response was already reported as a non-2xx
/// pass-through.
struct IdleTimeoutStream<S> {
    inner: S,
    idle_timeout: Duration,
    file_id: String,
    sink: ErrorSink,
    notified: Arc<AtomicBool>,
    deadline: Pin<Box<Sleep>>,
    last_poll: Instant,
    tripped: bool,
}

impl<S> IdleTimeoutStream<S> {
    fn new(inner: S, idle_timeout: Duration, file_id: String, sink: ErrorSink, notified: Arc<AtomicBool>) -> Self {
        let deadline = Box::pin(tokio::time::sleep(idle_timeout));
        Self { inner, idle_timeout, file_id, sink, notified, deadline, last_poll: Instant::now(), tripped: false }
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
            Poll::Ready(Some(Err(body_error))) => {
                // A mid-stream body error (reset/truncation) is terminal for
                // this response: the client keeps an incomplete body. Report it
                // like the idle abort — same `notified` dedupe, so a non-2xx
                // that already reported its real status stays single-shot.
                if !this.notified.swap(true, Ordering::SeqCst) {
                    (this.sink)(this.file_id.clone(), BODY_ERROR_STATUS);
                }
                Poll::Ready(Some(Err(body_error)))
            }
            Poll::Ready(Some(Ok(frame))) => {
                this.deadline.as_mut().reset(Instant::now() + this.idle_timeout);
                Poll::Ready(Some(Ok(frame)))
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
                if !this.notified.swap(true, Ordering::SeqCst) {
                    (this.sink)(this.file_id.clone(), IDLE_ABORT_STATUS);
                }
                Poll::Ready(Some(Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("upstream body idle for {:?}", this.idle_timeout),
                ))))
            }
        }
    }
}

/// KNOWN LIMITATION (verified 2026-10-07 by grep: `resourceKey` appears nowhere
/// in this crate): a link-shared file that needs `?resourceKey=` cannot be
/// streamed. `handle_request` takes `uri().path()` only, so a client cannot even
/// pass one through, and the upstream URL below is built from the file id alone.
/// That matches R7 in the investigation report and is deliberately NOT fixed
/// here: wiring resourceKey means changing the Drive/auth layer, which is out of
/// this slice's scope. Consequence: a Shared-Drive or link-shared movie shows up
/// in the library but fails to play with a 404/403 from the proxy.
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

/// Strips the query string from every `http(s)://…` URL in a message so a
/// signed upstream URL (its query carries credential-like params such as
/// Drive's `Signature`/`Expires`) can never reach the log or a response body.
/// Each URL keeps its scheme, authority and path; its query becomes
/// `?<redacted>`. Text without a URL passes through unchanged.
fn redact_urls(message: String) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message.as_str();
    while let Some((index, scheme)) = ["https://", "http://"]
        .iter()
        .filter_map(|scheme| rest.find(scheme).map(|index| (index, *scheme)))
        .min_by_key(|(index, _)| *index)
    {
        out.push_str(&rest[..index]);
        // The URL ends at whitespace or ')': reqwest wraps it as
        // "error sending request for url (https://…)".
        let tail = &rest[index + scheme.len()..];
        let end = tail.find(|c: char| c.is_whitespace() || c == ')').unwrap_or(tail.len());
        out.push_str(scheme);
        let url = &tail[..end];
        match url.find('?') {
            Some(query_start) => {
                out.push_str(&url[..query_start]);
                out.push_str("?<redacted>");
            }
            None => out.push_str(url),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

async fn fetch_upstream(
    context: &ProxyContext,
    mut url: url::Url,
    token: Option<&str>,
    range: Option<&str>,
) -> Result<reqwest::Response, (u16, String)> {
    // The first URL is built from the configured Drive base URL: its origin is
    // the only origin ever trusted with the Authorization header (see
    // plan_redirect_hop; reqwest auto-follow is disabled on purpose).
    let base = url.clone();
    for _ in 0..MAX_REDIRECTS {
        let plan = plan_redirect_hop(&base, &url).map_err(|refusal| (502u16, refusal))?;
        // Retry a retryable status up to MAX_STATUS_RETRIES times, reusing the
        // exact URL/token/Range; retries do not consume the redirect budget.
        // Nothing has been mirrored to the client yet here, so re-requesting
        // cannot corrupt a partial body.
        let mut attempt = 0usize;
        let sent = loop {
            let mut request = context.client.get(url.clone());
            if let (Some(token), HopPlan::WithCredentials) = (token, plan) {
                request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
            }
            if let Some(range) = range {
                request = request.header(reqwest::header::RANGE, range);
            }
            let sent = match tokio::time::timeout(context.headers_timeout, request.send()).await {
                Err(_elapsed) => return Err((504, format!("upstream did not respond within {:?}", context.headers_timeout))),
                Ok(Err(send_error)) => {
                    return Err((502, redact_urls(format!("upstream request failed: {send_error}"))))
                }
                Ok(Ok(sent)) => sent,
            };
            if !is_retryable_status(sent.status()) || attempt >= MAX_STATUS_RETRIES {
                // Final attempt (or a non-retryable status): pass the response
                // through; the sink sees exactly this status, once.
                break sent;
            }
            log::warn!(
                "[stream-proxy] upstream returned {} — retrying in {:?} (retry {}/{})",
                sent.status().as_u16(), STATUS_RETRY_BACKOFFS[attempt], attempt + 1, MAX_STATUS_RETRIES
            );
            tokio::time::sleep(STATUS_RETRY_BACKOFFS[attempt]).await;
            attempt += 1;
        };
        if sent.status().is_redirection() {
            let location = sent.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok())
                .ok_or_else(|| (502u16, "upstream redirect without Location header".to_string()))?;
            let target = url.join(location)
                .map_err(|e| (502u16, format!("upstream redirect has invalid Location: {e}")))?;
            if let Err(refusal) = plan_redirect_hop(&base, &target) {
                log::warn!("[stream-proxy] {refusal}");
                return Err((502, refusal));
            }
            url = target;
            continue;
        }
        return Ok(sent);
    }
    Err((502, format!("upstream exceeded {MAX_REDIRECTS} redirects")))
}

/// What to do with the URL of the next upstream request.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum HopPlan {
    /// Same origin as the configured base URL: resend the Bearer token.
    WithCredentials,
    /// Another origin (e.g. the signed `*.googleusercontent.com` URL a Drive
    /// redirect points at): follow it, but never send credentials.
    WithoutCredentials,
}

/// Decide how to treat one request URL relative to the base URL. Security
/// contract: the Bearer token only ever goes to the exact origin the base URL
/// was configured with (scheme+host+port — strictly narrower than reqwest's
/// auto-follow, which strips on host/scheme change only), and a non-https hop
/// is refused outright unless it is a plain-http test/dev base redirecting
/// within its own host (production base is https, so non-https is always
/// refused there).
fn plan_redirect_hop(base: &url::Url, target: &url::Url) -> Result<HopPlan, String> {
    if target.scheme() != "https" {
        let same_host = target.host_str() == base.host_str();
        if base.scheme() == "https" || !same_host {
            return Err(format!(
                "refusing non-https redirect hop to {}://{}",
                target.scheme(),
                target.host_str().unwrap_or("<no host>")
            ));
        }
    }
    if target.origin() == base.origin() {
        Ok(HopPlan::WithCredentials)
    } else {
        Ok(HopPlan::WithoutCredentials)
    }
}

/// Statuses worth re-requesting: 429 (Google documents exponential backoff)
/// and the 5xx family. 403 is deliberately absent — quota/denial cases need a
/// body peek (out of scope) and permanent denials must not be retried.
fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504)
}

fn message_response(status: StatusCode, message: &str) -> Response<ProxyBody> {
    let body = Full::new(Bytes::from(message.to_string()))
        .map_err(|never: Infallible| -> io::Error { match never {} })
        .boxed_unsync();
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8");
    if status == StatusCode::METHOD_NOT_ALLOWED {
        // RFC 9110 §15.5.6: a 405 response MUST carry the allowed methods.
        builder = builder.header(header::ALLOW, "GET");
    }
    builder.body(body).expect("static response always builds")
}
#[cfg(test)]
mod spike_tests;

#[cfg(test)]
mod tests;
