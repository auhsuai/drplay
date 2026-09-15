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
/// or `IDLE_ABORT_STATUS` when the upstream body stalls and the response is
/// aborted. Never fired for 405/404-path/400 (not file failures).
pub(crate) type ErrorSink = Arc<dyn Fn(String, u16) + Send + Sync>;

/// Status reported to the error sink when the upstream body goes idle
/// mid-stream and the response is aborted. The client has already received
/// 200/206 and sees a broken body instead; 499 never appears on the wire.
const IDLE_ABORT_STATUS: u16 = 499;

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
        Err(body_error) => Err(io::Error::other(format!("upstream body error: {body_error}"))),
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
                Ok(Err(send_error)) => return Err((502, format!("upstream request failed: {send_error}"))),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };

    // Minimal scripted upstream mirroring the `spawn_fixture` harness in
    // `stream_proxy::tests`: that harness is private to `mod.rs`, which this
    // batch must not touch (scope lock), so this module carries its own.

    #[derive(Clone)]
    struct FixtureResponse {
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: Vec<u8>,
        /// `Some((total_length, stall))`: send `body` as the start of a
        /// Content-Length `total_length` response, then stall (no EOF) for
        /// `stall` — a network dying mid-body.
        stall: Option<(usize, Duration)>,
    }

    fn respond(status: u16, headers: Vec<(&'static str, String)>, body: &[u8]) -> FixtureResponse {
        FixtureResponse { status, headers, body: body.to_vec(), stall: None }
    }

    fn respond_stalling(status: u16, body: &[u8], total_length: usize, stall: Duration) -> FixtureResponse {
        FixtureResponse { status, headers: vec![], body: body.to_vec(), stall: Some((total_length, stall)) }
    }

    struct StallingBody {
        first: Vec<u8>,
        position: usize,
        stall: Duration,
        stalled: bool,
    }

    impl Read for StallingBody {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if self.position < self.first.len() {
                let count = (self.first.len() - self.position).min(out.len());
                out[..count].copy_from_slice(&self.first[self.position..self.position + count]);
                self.position += count;
                return Ok(count);
            }
            if !self.stalled {
                self.stalled = true;
                std::thread::sleep(self.stall);
            }
            Ok(0) // EOF after the stall; the proxy must abort before this
        }
    }

    struct RecordedRequest {
        authorization: Option<String>,
        range: Option<String>,
    }

    /// Serves the scripted responses in request order (the last one repeats)
    /// and records every request's Authorization/Range headers.
    fn spawn_fixture(script: Vec<FixtureResponse>) -> (u16, Arc<Mutex<Vec<RecordedRequest>>>) {
        let http_server = tiny_http::Server::http("127.0.0.1:0").expect("fixture upstream must bind");
        let port = http_server.server_addr().to_ip().expect("fixture upstream address").port();
        let http_server = Arc::new(http_server);
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let script = Arc::new(Mutex::new(script));
        let served = Arc::new(AtomicUsize::new(0));
        // Spare workers: a stalled fixture response parks one worker for the
        // whole stall (its blocking body write never finishes while the proxy
        // stops reading).
        for _ in 0..6 {
            let http_server = Arc::clone(&http_server);
            let recorded = Arc::clone(&recorded);
            let script = Arc::clone(&script);
            let served = Arc::clone(&served);
            std::thread::spawn(move || loop {
                let Ok(request) = http_server.recv() else { continue };
                let mut authorization = None;
                let mut range = None;
                for header in request.headers() {
                    let name = header.field.as_str().as_str();
                    if name.eq_ignore_ascii_case("authorization") {
                        authorization = Some(header.value.as_str().to_string());
                    }
                    if name.eq_ignore_ascii_case("range") {
                        range = Some(header.value.as_str().to_string());
                    }
                }
                recorded.lock().unwrap().push(RecordedRequest { authorization, range });
                let index = served.fetch_add(1, Ordering::SeqCst);
                let scripted = {
                    let script = script.lock().unwrap();
                    script
                        .get(index)
                        .cloned()
                        .or_else(|| script.last().cloned())
                        .expect("fixture script is never empty")
                };
                let mut outgoing: tiny_http::Response<Box<dyn Read + Send>> = match scripted.stall {
                    Some((total_length, stall)) => {
                        let reader = StallingBody { first: scripted.body, position: 0, stall, stalled: false };
                        tiny_http::Response::from_data(Vec::new())
                            .with_status_code(scripted.status)
                            .with_data(reader, Some(total_length))
                            .boxed()
                    }
                    None => tiny_http::Response::from_data(scripted.body)
                        .with_status_code(scripted.status)
                        .boxed(),
                };
                for (name, value) in &scripted.headers {
                    if let Ok(header) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
                        outgoing.add_header(header);
                    }
                }
                let _ = request.respond(outgoing);
            });
        }
        (port, recorded)
    }

    struct StubTokens {
        initial: Option<String>,
        queued: Mutex<Vec<String>>,
        calls: AtomicUsize,
    }

    impl StubTokens {
        fn new(initial: &str, refreshed: &[&str]) -> Arc<Self> {
            Arc::new(Self {
                initial: Some(initial.to_string()),
                queued: Mutex::new(refreshed.iter().map(|t| t.to_string()).collect()),
                calls: AtomicUsize::new(0),
            })
        }
    }

    impl TokenSource for StubTokens {
        fn current(&self) -> Option<String> {
            self.initial.clone()
        }

        fn refresh(self: Arc<Self>, _force: bool) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            // Panics on an empty queue on purpose: a test that sees this has a bug.
            let next = self.queued.lock().unwrap().remove(0);
            Box::pin(async move { Ok(next) })
        }
    }

    async fn start_proxy(
        base_url: String,
        tokens: Arc<StubTokens>,
        headers_timeout: Duration,
        body_idle_timeout: Duration,
    ) -> (u16, Arc<Mutex<Vec<(String, u16)>>>) {
        let events: Arc<Mutex<Vec<(String, u16)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: ErrorSink = {
            let events = Arc::clone(&events);
            Arc::new(move |file_id, status| events.lock().unwrap().push((file_id, status)))
        };
        let port = spawn_proxy(sink, base_url, tokens, headers_timeout, body_idle_timeout)
            .expect("proxy must start");
        (port, events)
    }

    const CLIENT_TIMEOUT: Duration = Duration::from_secs(8);
    const IDLE_TIMEOUT: Duration = Duration::from_secs(2);

    async fn get(port: u16, file_id: &str, range: Option<&str>) -> reqwest::Response {
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{port}/stream/{file_id}");
        let mut request = client.get(&url);
        if let Some(range) = range {
            request = request.header(reqwest::header::RANGE, range);
        }
        tokio::time::timeout(CLIENT_TIMEOUT, request.send())
            .await
            .expect("client request timed out")
            .expect("client request failed")
    }

    /// R04-1: a retryable upstream status must be re-requested (same Range and
    /// token) instead of being passed through on the first hit; the final
    /// success emits no error event.
    #[tokio::test(flavor = "multi_thread")]
    async fn retries_retryable_status_then_passes_through_success() {
        let (upstream_port, recorded) = spawn_fixture(vec![
            respond(503, vec![], b"busy"),
            respond(200, vec![], b"recovered"),
        ]);
        let tokens = StubTokens::new("stale-token-a", &[]);
        let (port, events) = start_proxy(
            format!("http://127.0.0.1:{upstream_port}"),
            tokens,
            IDLE_TIMEOUT,
            IDLE_TIMEOUT,
        )
        .await;

        let response = get(port, "retry-me", Some("bytes=0-99")).await;

        assert_eq!(response.status(), 200, "503 must be retried, not passed through");
        assert_eq!(response.bytes().await.unwrap(), b"recovered".as_slice());
        let recorded = recorded.lock().unwrap();
        assert_eq!(recorded.len(), 2, "expected initial attempt + one retry");
        for request in recorded.iter() {
            assert_eq!(request.authorization.as_deref(), Some("Bearer stale-token-a"));
            assert_eq!(request.range.as_deref(), Some("bytes=0-99"));
        }
        assert!(
            events.lock().unwrap().is_empty(),
            "a retried request that ends 200 must not emit an error event"
        );
    }

    /// R04-1: repeated 429 stops after exactly two retries (3 requests total)
    /// and passes the last response through; the sink sees that status once.
    #[tokio::test(flavor = "multi_thread")]
    async fn stops_after_two_retries_on_repeated_429() {
        let (upstream_port, recorded) = spawn_fixture(vec![
            respond(429, vec![], b"slow-down"),
            respond(429, vec![], b"slow-down"),
            respond(429, vec![], b"slow-down"),
            respond(200, vec![], b"must-not-be-reached"),
        ]);
        let tokens = StubTokens::new("stale-token-a", &[]);
        let (port, events) = start_proxy(
            format!("http://127.0.0.1:{upstream_port}"),
            tokens,
            IDLE_TIMEOUT,
            IDLE_TIMEOUT,
        )
        .await;

        let response = get(port, "rate-limited", None).await;

        assert_eq!(response.status(), 429);
        assert_eq!(response.bytes().await.unwrap(), b"slow-down".as_slice());
        assert_eq!(recorded.lock().unwrap().len(), 3, "initial attempt + exactly two retries");
        assert_eq!(
            *events.lock().unwrap(),
            vec![("rate-limited".to_string(), 429u16)],
            "the sink fires once, with the final status"
        );
    }

    /// R04-1: 403 is not retryable (needs a body peek / permanent denial).
    #[tokio::test(flavor = "multi_thread")]
    async fn does_not_retry_403_and_emits_passthrough_event() {
        let (upstream_port, recorded) = spawn_fixture(vec![
            respond(403, vec![], b"forbidden"),
            respond(200, vec![], b"must-not-be-reached"),
        ]);
        let tokens = StubTokens::new("stale-token-a", &[]);
        let (port, events) = start_proxy(
            format!("http://127.0.0.1:{upstream_port}"),
            tokens,
            IDLE_TIMEOUT,
            IDLE_TIMEOUT,
        )
        .await;

        let response = get(port, "forbidden-file", None).await;

        assert_eq!(response.status(), 403);
        assert_eq!(response.bytes().await.unwrap(), b"forbidden".as_slice());
        assert_eq!(recorded.lock().unwrap().len(), 1, "4xx other than 429 must not be retried");
        assert_eq!(*events.lock().unwrap(), vec![("forbidden-file".to_string(), 403u16)]);
    }

    /// R04-2: the passthrough 503 group reaches the sink exactly once.
    #[tokio::test(flavor = "multi_thread")]
    async fn passes_through_503_after_exhausted_retries_with_single_event() {
        let (upstream_port, recorded) = spawn_fixture(vec![respond(503, vec![], b"still-down")]);
        let tokens = StubTokens::new("stale-token-a", &[]);
        let (port, events) = start_proxy(
            format!("http://127.0.0.1:{upstream_port}"),
            tokens,
            IDLE_TIMEOUT,
            IDLE_TIMEOUT,
        )
        .await;

        let response = get(port, "down-file", None).await;

        assert_eq!(response.status(), 503);
        assert_eq!(response.bytes().await.unwrap(), b"still-down".as_slice());
        assert_eq!(recorded.lock().unwrap().len(), 3, "503 is retried twice, then passed through");
        assert_eq!(
            *events.lock().unwrap(),
            vec![("down-file".to_string(), 503u16)],
            "exactly one event for the whole group"
        );
    }

    /// R04-2: an idle-aborted body (headers already sent) reports the
    /// synthesized 499 status exactly once.
    #[tokio::test(flavor = "multi_thread")]
    async fn idle_abort_emits_single_499_event() {
        const STALLED_FIRST_BYTES: usize = 2048;
        const STALLED_TOTAL_LENGTH: usize = 4096;
        let short_idle = Duration::from_millis(200);
        let (upstream_port, _recorded) = spawn_fixture(vec![respond_stalling(
            206,
            &[0u8; STALLED_FIRST_BYTES],
            STALLED_TOTAL_LENGTH,
            Duration::from_secs(10),
        )]);
        let tokens = StubTokens::new("stale-token-a", &[]);
        let (port, events) = start_proxy(
            format!("http://127.0.0.1:{upstream_port}"),
            tokens,
            IDLE_TIMEOUT,
            short_idle,
        )
        .await;

        let response = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/stream/idle-file"))
            .header(reqwest::header::RANGE, "bytes=0-4095")
            .send()
            .await
            .expect("stalled request must get a response");
        assert_eq!(response.status(), 206);
        let body = tokio::time::timeout(short_idle + Duration::from_secs(2), response.bytes())
            .await
            .expect("client read must terminate after the body idle deadline");
        assert!(body.is_err(), "aborted body must surface as a read error");
        assert_eq!(
            *events.lock().unwrap(),
            vec![("idle-file".to_string(), 499u16)],
            "exactly one idle-abort event, status 499 (IDLE_ABORT_STATUS)"
        );
    }

    /// R04-3: a hop to another server (different origin — the signed-URL
    /// case) must be followed WITHOUT the Authorization header; Range stays.
    #[tokio::test(flavor = "multi_thread")]
    async fn redirect_hop_to_second_server_drops_authorization() {
        let (second_port, second_recorded) = spawn_fixture(vec![respond(200, vec![], b"signed-hop-ok")]);
        let location = format!("http://127.0.0.1:{second_port}/drive/v3/files/redirected?alt=media");
        let (first_port, first_recorded) = spawn_fixture(vec![respond(302, vec![("Location", location)], b"")]);
        let tokens = StubTokens::new("stale-token-a", &[]);
        let (port, _events) = start_proxy(
            format!("http://127.0.0.1:{first_port}"),
            tokens,
            IDLE_TIMEOUT,
            IDLE_TIMEOUT,
        )
        .await;

        let response = get(port, "redirect-me", Some("bytes=0-9")).await;

        assert_eq!(response.status(), 200);
        assert_eq!(response.bytes().await.unwrap(), b"signed-hop-ok".as_slice());
        assert_eq!(
            first_recorded.lock().unwrap()[0].authorization.as_deref(),
            Some("Bearer stale-token-a")
        );
        let second = second_recorded.lock().unwrap();
        assert_eq!(second.len(), 1, "the redirect hop must reach the second fixture");
        assert_eq!(second[0].authorization, None, "a hop to another origin must never carry the Bearer token");
        assert_eq!(second[0].range.as_deref(), Some("bytes=0-9"), "Range stays forwarded on the hop");
    }

    /// R04-3 (production semantics, plain unit): with an https base the guard
    /// refuses every non-https hop and credentials go only to the base origin.
    #[test]
    fn hop_plan_production_semantics() {
        let base = url::Url::parse("https://www.googleapis.com/drive/v3/files/x?alt=media").unwrap();
        let same_origin = url::Url::parse("https://www.googleapis.com/drive/v3/files/y").unwrap();
        let signed = url::Url::parse("https://storage.googleapis.com/signed-url").unwrap();
        let downgrade = url::Url::parse("http://www.googleapis.com/drive/v3/files/y").unwrap();

        assert_eq!(plan_redirect_hop(&base, &same_origin), Ok(HopPlan::WithCredentials));
        assert_eq!(plan_redirect_hop(&base, &signed), Ok(HopPlan::WithoutCredentials));
        assert!(plan_redirect_hop(&base, &downgrade).is_err(), "https base must refuse plain-http hops");

        // Fixture/dev base (plain http): a redirect within the same host stays
        // followable, but loses credentials as soon as the origin changes; a
        // cross-host plain-http hop is refused.
        let local = url::Url::parse("http://127.0.0.1:5000/drive/v3/files/x").unwrap();
        let other_port = url::Url::parse("http://127.0.0.1:6000/drive/v3/files/y").unwrap();
        let other_host = url::Url::parse("http://localhost:6000/drive/v3/files/y").unwrap();
        assert_eq!(plan_redirect_hop(&local, &other_port), Ok(HopPlan::WithoutCredentials));
        assert!(plan_redirect_hop(&local, &other_host).is_err());
    }

    /// R04-3: a redirect hop that downgrades to plain http is refused (502)
    /// before any request is sent.
    #[tokio::test(flavor = "multi_thread")]
    async fn refuses_non_https_redirect_hop_with_502() {
        // 127.0.0.2:1 is not where the fixture (or anything) listens: old code
        // would try to connect there; fixed code refuses the URL itself.
        let location = "http://127.0.0.2:1/drive/v3/files/downgrade?alt=media";
        let (upstream_port, _recorded) =
            spawn_fixture(vec![respond(302, vec![("Location", location.to_string())], b"")]);
        let tokens = StubTokens::new("stale-token-a", &[]);
        let (port, events) = start_proxy(
            format!("http://127.0.0.1:{upstream_port}"),
            tokens,
            IDLE_TIMEOUT,
            IDLE_TIMEOUT,
        )
        .await;

        let response = get(port, "downgrade", None).await;

        assert_eq!(response.status(), 502, "a non-https hop must be refused");
        let body = response.text().await.unwrap();
        assert!(body.contains("non-https"), "refusal must name the reason, got: {body}");
        assert_eq!(*events.lock().unwrap(), vec![("downgrade".to_string(), 502u16)]);
    }

    /// R04-4: 405 carries `Allow`; synthesized bodies carry `Content-Type`.
    #[tokio::test(flavor = "multi_thread")]
    async fn method_not_allowed_carries_allow_and_synthesized_bodies_carry_content_type() {
        // No fixture needed: both paths answer before the upstream is touched.
        let tokens = StubTokens::new("stale-token-a", &[]);
        let (port, _events) = start_proxy("http://127.0.0.1:1".to_string(), tokens, IDLE_TIMEOUT, IDLE_TIMEOUT).await;
        let client = reqwest::Client::new();

        let post = client
            .post(format!("http://127.0.0.1:{port}/stream/whatever"))
            .send()
            .await
            .expect("POST must get a response");
        assert_eq!(post.status(), 405);
        assert_eq!(post.headers().get("allow").expect("405 must carry Allow"), "GET");
        assert_eq!(
            post.headers().get("content-type").expect("405 body must be typed"),
            "text/plain; charset=utf-8"
        );

        let missing = client
            .get(format!("http://127.0.0.1:{port}/not-stream"))
            .send()
            .await
            .expect("unknown path must get a response");
        assert_eq!(missing.status(), 404);
        assert_eq!(
            missing.headers().get("content-type").expect("404 body must be typed"),
            "text/plain; charset=utf-8"
        );
    }
}
