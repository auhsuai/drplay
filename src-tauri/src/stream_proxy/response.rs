//! Response half of the localhost stream proxy: mirroring the upstream
//! response to the client and the idle-deadline body stream that aborts a
//! stalled upstream. An error from the body stream is what makes hyper close
//! the connection and release the player.

use std::{
    convert::Infallible, future::Future, io, pin::Pin,
    sync::{atomic::{AtomicBool, Ordering}, Arc},
    task::{Context, Poll}, time::Duration,
};

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::Frame;
use hyper::{header, Response, StatusCode};
use tokio::time::{Instant, Sleep};

use super::types::{BODY_ERROR_STATUS, ErrorSink, IDLE_ABORT_STATUS, ProxyBody, ProxyContext};
use super::upstream::redact_urls;

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

/// Mirror the upstream response to the client: status, media headers, and the
/// upstream body wrapped in the idle-deadline stream. An error from that
/// stream is what makes hyper close the connection and release the player.
pub(super) fn stream_response(context: &ProxyContext, file_id: &str, upstream: reqwest::Response) -> Response<ProxyBody> {
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

pub(super) fn message_response(status: StatusCode, message: &str) -> Response<ProxyBody> {
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
