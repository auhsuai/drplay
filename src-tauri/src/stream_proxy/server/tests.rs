use super::*;
use std::io::{Read, Write};
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

/// A one-shot upstream that sends the response head + a partial body and
/// then drops the socket: the body truncates mid-stream, never reaching
/// the Content-Length it declared (ECONNRESET / early EOF). Unlike
/// `StallingBody`, the connection does not stay open — the proxy's inner
/// stream sees a real body error, not an idle gap.
fn spawn_truncating_fixture(declared_length: usize, first_bytes: &[u8]) -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("truncating fixture must bind");
    let port = listener.local_addr().expect("truncating fixture address").port();
    let first_bytes = first_bytes.to_vec();
    std::thread::spawn(move || {
        let Ok((mut socket, _)) = listener.accept() else { return };
        let mut request = [0u8; 1024];
        let _ = socket.read(&mut request);
        let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {declared_length}\r\n\r\n");
        let _ = socket.write_all(head.as_bytes());
        let _ = socket.write_all(&first_bytes);
        let _ = socket.flush();
        // Dropping the socket here truncates the body mid-stream.
    });
    port
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

/// R04a F1: a body error mid-stream (not an idle stall) must reach the
/// sink exactly once with 502 — the documented contract covers every
/// failed file request, and the client must still see the body abort.
#[tokio::test(flavor = "multi_thread")]
async fn body_error_mid_stream_emits_single_502_event() {
    const FIRST_BYTES: usize = 512;
    const DECLARED_LENGTH: usize = 4096;
    let upstream_port = spawn_truncating_fixture(DECLARED_LENGTH, &[0u8; FIRST_BYTES]);
    let tokens = StubTokens::new("stale-token-a", &[]);
    let (port, events) = start_proxy(
        format!("http://127.0.0.1:{upstream_port}"),
        tokens,
        IDLE_TIMEOUT,
        IDLE_TIMEOUT,
    )
    .await;

    let response = get(port, "truncated-file", None).await;
    assert_eq!(response.status(), 200, "the upstream head was already mirrored");
    let body = tokio::time::timeout(CLIENT_TIMEOUT, response.bytes())
        .await
        .expect("client read must terminate after the upstream truncation");
    assert!(body.is_err(), "a truncated body must surface as a read error");
    assert_eq!(
        *events.lock().unwrap(),
        vec![("truncated-file".to_string(), 502u16)],
        "exactly one 502 event for the mid-stream body error"
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

/// D1 (R05 fix-review F1): reqwest's Display appends " for url (...)" to
/// send/body errors — on a redirect hop that URL is a signed
/// googleusercontent URL whose query is credential-like. The redactor must
/// keep origin+path, replace the query with `?<redacted>`, and leave
/// URL-free text untouched.
#[test]
fn redact_urls_strips_query_keeps_origin_and_path() {
    assert_eq!(
        redact_urls("upstream request failed: error sending request for url (https://x.googleusercontent.com/download/abc?Signature=SECRET&Expires=123)".to_string()),
        "upstream request failed: error sending request for url (https://x.googleusercontent.com/download/abc?<redacted>)"
    );
    // Every URL in the message is redacted, both schemes, whitespace-delimited.
    assert_eq!(
        redact_urls("a https://h1/p?x=1 b http://h2/q?y=2 c".to_string()),
        "a https://h1/p?<redacted> b http://h2/q?<redacted> c"
    );
    // No query → untouched; no URL → identity.
    assert_eq!(
        redact_urls("plain https://host/a/b failure".to_string()),
        "plain https://host/a/b failure"
    );
    assert_eq!(redact_urls("no url here".to_string()), "no url here");
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
