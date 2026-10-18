use super::*;
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use server::{spawn_proxy, ErrorSink};

struct RecordedRequest {
    path: String,
    authorization: Option<String>,
    range: Option<String>,
}

#[derive(Clone)]
struct FixtureResponse {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
    delay: Duration,
    /// `Some((total_length, stall))`: send `body` as the start of a
    /// Content-Length `total_length` response, then stall (no more
    /// bytes, no EOF) for `stall` — a network dying mid-body.
    mid_body_stall: Option<(usize, Duration)>,
}

fn respond(status: u16, headers: Vec<(&'static str, String)>, body: &[u8]) -> FixtureResponse {
    FixtureResponse {
        status,
        headers,
        body: body.to_vec(),
        delay: Duration::ZERO,
        mid_body_stall: None,
    }
}

fn respond_delayed(status: u16, body: &[u8], delay: Duration) -> FixtureResponse {
    FixtureResponse {
        status,
        headers: vec![],
        body: body.to_vec(),
        delay,
        mid_body_stall: None,
    }
}

/// Upstream response that starts a body and then goes silent, leaving the
/// connection half-open (no EOF) for `stall`.
fn respond_stalling(
    status: u16,
    first_bytes: &[u8],
    total_length: usize,
    stall: Duration,
) -> FixtureResponse {
    FixtureResponse {
        status,
        headers: vec![],
        body: first_bytes.to_vec(),
        delay: Duration::ZERO,
        mid_body_stall: Some((total_length, stall)),
    }
}

/// `Read` for a stalling fixture response: hands out the `first` bytes,
/// then blocks for `stall` before EOF. `first` must exceed tiny_http's
/// 1024-byte per-connection write buffer (see `STALLED_FIRST_BYTES`):
/// otherwise the response head + prefix sit in that buffer and the proxy
/// would keep waiting for headers (504 at the header deadline) instead of
/// stalling mid-body.
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
        Ok(0) // EOF after the stall; a fixed proxy must abort before this
    }
}

/// Tiny upstream standing in for Google Drive: serves the scripted
/// responses in request order (the last one repeats) and records every
/// request's path + auth/range headers.
fn spawn_fixture(script: Vec<FixtureResponse>) -> (u16, Arc<Mutex<Vec<RecordedRequest>>>) {
    // tiny_http workers: a stalled fixture response parks one worker for
    // the whole stall (its blocking body write never finishes while the
    // proxy stops reading), so keep spares for the follow-up requests of
    // the abort tests.
    const FIXTURE_WORKERS: usize = 6;
    let http_server = tiny_http::Server::http("127.0.0.1:0").expect("fixture upstream must bind");
    let port = http_server.server_addr().to_ip().expect("fixture upstream address").port();
    let http_server = Arc::new(http_server);
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let script = Arc::new(Mutex::new(script));
    let served = Arc::new(AtomicUsize::new(0));
    for _ in 0..FIXTURE_WORKERS {
        let http_server = Arc::clone(&http_server);
        let recorded = Arc::clone(&recorded);
        let script = Arc::clone(&script);
        let served = Arc::clone(&served);
        std::thread::spawn(move || loop {
            let Ok(request) = http_server.recv() else { continue };
            let path = request.url().to_string();
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
            recorded.lock().unwrap().push(RecordedRequest { path, authorization, range });
            let index = served.fetch_add(1, Ordering::SeqCst);
            let scripted = {
                let script = script.lock().unwrap();
                script
                    .get(index)
                    .cloned()
                    .or_else(|| script.last().cloned())
                    .expect("fixture script is never empty")
            };
            if scripted.delay > Duration::ZERO {
                std::thread::sleep(scripted.delay);
            }
            let mut outgoing: tiny_http::Response<Box<dyn Read + Send>> =
                match scripted.mid_body_stall {
                    Some((total_length, stall)) => {
                        let reader = StallingBody {
                            first: scripted.body,
                            position: 0,
                            stall,
                            stalled: false,
                        };
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

/// Token stub: serves `initial` from `current()` and hands out the queued
/// tokens from `refresh()` while counting how often refresh was called.
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

    fn refresh(self: Arc<Self>, _force: bool)
        -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
    {
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
    let port = spawn_proxy(
        sink,
        base_url,
        tokens,
        headers_timeout,
        body_idle_timeout,
    )
    .expect("proxy must start");
    (port, events)
}

const CLIENT_TIMEOUT: Duration = Duration::from_secs(5);
/// Idle upstream-body deadline for the pre-existing tests: their fixtures
/// never pause between chunks for longer than 150ms.
const TEST_IDLE_TIMEOUT: Duration = Duration::from_secs(2);
/// Idle deadline for the stalled-body tests, short so the abort is quick.
const SHORT_IDLE_TIMEOUT: Duration = Duration::from_millis(200);
/// How long a client read may take after the idle deadline before the test
/// declares the response hung.
const ABORT_MARGIN: Duration = Duration::from_secs(2);
/// The stall prefix must exceed tiny_http's 1024-byte per-connection write
/// buffer, otherwise the fixture response head + prefix stay buffered and
/// the proxy waits for headers (504 at the header deadline) rather than
/// stalling mid-body.
const STALLED_FIRST_BYTES: usize = 2048;
const STALLED_TOTAL_LENGTH: usize = 4096;

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

/// (a) /stream/abc -> upstream receives GET files/abc?alt=media with Bearer.
#[tokio::test(flavor = "multi_thread")]
async fn proxies_file_path_bearer_and_body() {
    let (upstream_port, recorded) = spawn_fixture(vec![respond(
        200,
        vec![("Content-Type", "audio/mpeg".to_string())],
        b"proxy-payload",
    )]);
    let tokens = StubTokens::new("stale-token-a", &[]);
    let (port, _events) = start_proxy(format!("http://127.0.0.1:{upstream_port}"), tokens, Duration::from_secs(2), TEST_IDLE_TIMEOUT).await;

    let response = get(port, "abc", None).await;

    assert_eq!(response.status(), 200);
    assert_eq!(response.bytes().await.unwrap(), b"proxy-payload".as_slice());
    let recorded = recorded.lock().unwrap();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].path, "/drive/v3/files/abc?alt=media");
    assert_eq!(recorded[0].authorization.as_deref(), Some("Bearer stale-token-a"));
    assert_eq!(recorded[0].range, None);
}

/// (b) Range forwarded; 206 + Content-Range pass through untouched.
#[tokio::test(flavor = "multi_thread")]
async fn forwards_range_and_passes_206_content_range_through() {
    let body: Vec<u8> = (0..100u8).collect();
    let (upstream_port, recorded) = spawn_fixture(vec![respond(
        206,
        vec![("Content-Range", "bytes 0-99/4096".to_string())],
        &body,
    )]);
    let tokens = StubTokens::new("stale-token-a", &[]);
    let (port, _events) = start_proxy(format!("http://127.0.0.1:{upstream_port}"), tokens, Duration::from_secs(2), TEST_IDLE_TIMEOUT).await;

    let response = get(port, "range-file", Some("bytes=0-99")).await;

    assert_eq!(response.status(), 206);
    assert_eq!(response.headers().get("content-range").unwrap(), "bytes 0-99/4096");
    assert_eq!(response.bytes().await.unwrap().len(), 100);
    let recorded = recorded.lock().unwrap();
    assert_eq!(recorded[0].range.as_deref(), Some("bytes=0-99"));
    assert_eq!(recorded[0].authorization.as_deref(), Some("Bearer stale-token-a"));
}

/// (c) upstream 401 -> refresh exactly once -> retry with the fresh token -> 200.
#[tokio::test(flavor = "multi_thread")]
async fn refreshes_exactly_once_on_401_then_retries() {
    let (upstream_port, recorded) = spawn_fixture(vec![
        respond(401, vec![], b"expired"),
        respond(200, vec![], b"after-refresh"),
    ]);
    let tokens = StubTokens::new("stale-token-a", &["fresh-token-b"]);
    let (port, _events) = start_proxy(format!("http://127.0.0.1:{upstream_port}"), Arc::clone(&tokens), Duration::from_secs(2), TEST_IDLE_TIMEOUT).await;

    let response = get(port, "refresh-me", None).await;

    assert_eq!(response.status(), 200);
    assert_eq!(response.bytes().await.unwrap(), b"after-refresh".as_slice());
    assert_eq!(tokens.calls.load(Ordering::SeqCst), 1, "refresh must run exactly once");
    let recorded = recorded.lock().unwrap();
    assert_eq!(recorded.len(), 2);
    assert_eq!(recorded[0].authorization.as_deref(), Some("Bearer stale-token-a"));
    assert_eq!(recorded[1].authorization.as_deref(), Some("Bearer fresh-token-b"));
}

/// (d) 401 twice -> 502 + event stream-proxy-error {fileId, status}.
#[tokio::test(flavor = "multi_thread")]
async fn second_401_returns_502_and_emits_event() {
    let (upstream_port, _recorded) = spawn_fixture(vec![respond(401, vec![], b"still-denied")]);
    let tokens = StubTokens::new("stale-token-a", &["fresh-token-b"]);
    let (port, events) = start_proxy(format!("http://127.0.0.1:{upstream_port}"), Arc::clone(&tokens), Duration::from_secs(2), TEST_IDLE_TIMEOUT).await;

    let response = get(port, "two-oh-one", None).await;

    assert_eq!(response.status(), 502);
    assert_eq!(tokens.calls.load(Ordering::SeqCst), 1, "no refresh loop on repeated 401");
    assert_eq!(*events.lock().unwrap(), vec![("two-oh-one".to_string(), 502u16)]);
}

/// (e) 2 concurrent requests both complete (no serialization/deadlock).
#[tokio::test(flavor = "multi_thread")]
async fn two_parallel_requests_both_complete() {
    let slow = Duration::from_millis(150);
    let (upstream_port, recorded) = spawn_fixture(vec![
        respond_delayed(200, b"parallel-ok", slow),
        respond_delayed(200, b"parallel-ok", slow),
    ]);
    let tokens = StubTokens::new("stale-token-a", &[]);
    let (port, _events) = start_proxy(format!("http://127.0.0.1:{upstream_port}"), tokens, Duration::from_secs(2), TEST_IDLE_TIMEOUT).await;

    let client = reqwest::Client::new();
    let started = Instant::now();
    let (first, second) = tokio::join!(
        client.get(format!("http://127.0.0.1:{port}/stream/p1")).send(),
        client.get(format!("http://127.0.0.1:{port}/stream/p2")).send(),
    );
    let elapsed = started.elapsed();

    assert_eq!(first.expect("first request failed").status(), 200);
    assert_eq!(second.expect("second request failed").status(), 200);
    assert_eq!(recorded.lock().unwrap().len(), 2);
    assert!(
        elapsed < Duration::from_millis(260),
        "requests appear serialized (each upstream delay is 150ms): {elapsed:?}"
    );
}

/// (f) upstream that never delivers headers within the deadline -> 504 + event.
#[tokio::test(flavor = "multi_thread")]
async fn upstream_headers_timeout_returns_504_and_emits_event() {
    let (upstream_port, _recorded) =
        spawn_fixture(vec![respond_delayed(200, b"too-late", Duration::from_secs(2))]);
    let tokens = StubTokens::new("stale-token-a", &[]);
    let (port, events) = start_proxy(
        format!("http://127.0.0.1:{upstream_port}"),
        tokens,
        Duration::from_millis(300),
        TEST_IDLE_TIMEOUT,
    )
    .await;

    let response = get(port, "slow", None).await;

    assert_eq!(response.status(), 504);
    assert_eq!(*events.lock().unwrap(), vec![("slow".to_string(), 504u16)]);
}

/// (g) Upstream stalls mid-body: the proxy must abort the response once the
/// idle deadline passes instead of parking the worker forever (the
/// production incident: mpv never saw a read error, the UI hung).
#[tokio::test(flavor = "multi_thread")]
async fn idle_upstream_body_aborts_response_instead_of_hanging() {
    let (upstream_port, _recorded) = spawn_fixture(vec![respond_stalling(
        206,
        &[0u8; STALLED_FIRST_BYTES],
        STALLED_TOTAL_LENGTH,
        Duration::from_secs(10),
    )]);
    let tokens = StubTokens::new("stale-token-a", &[]);
    let (port, _events) = start_proxy(
        format!("http://127.0.0.1:{upstream_port}"),
        tokens,
        Duration::from_secs(2),
        SHORT_IDLE_TIMEOUT,
    )
    .await;

    // The real client (mpv 0.41 / ffmpeg) sends NO `Connection` header at
    // all — verified live. The abort must therefore not depend on one:
    // hyper closes the connection itself as soon as the response body
    // stream errors. (tiny_http could not close keep-alive connections
    // from the server side, so this exact scenario left mpv parked on a
    // silent socket — incident 2026-09-13.)
    let response = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/stream/stalled"))
        .header(reqwest::header::RANGE, "bytes=0-4095")
        .send()
        .await
        .expect("stalled request must get a response");
    assert_eq!(response.status(), 206);

    let body = tokio::time::timeout(SHORT_IDLE_TIMEOUT + ABORT_MARGIN, response.bytes())
        .await
        .expect("client read must terminate after the body idle deadline (hangs without the fix)");
    assert!(
        body.is_err(),
        "aborted body must surface as a client read error, got {} bytes",
        body.map(|bytes| bytes.len()).unwrap_or(0)
    );
}

/// (h) Aborts must not wedge the proxy: several concurrent stalled
/// responses (mpv-style clients, no `Connection` header) all end with a
/// read error, and a fresh request to the same proxy is still served.
#[tokio::test(flavor = "multi_thread")]
async fn proxy_still_serves_after_concurrent_idle_aborts() {
    const CONCURRENT_STALLS: usize = 4;
    let mut script: Vec<FixtureResponse> = (0..CONCURRENT_STALLS)
        .map(|_| {
            respond_stalling(
                206,
                &[0u8; STALLED_FIRST_BYTES],
                STALLED_TOTAL_LENGTH,
                Duration::from_secs(10),
            )
        })
        .collect();
    script.push(respond(200, vec![], b"recycled-ok"));
    let (upstream_port, _recorded) = spawn_fixture(script);
    let tokens = StubTokens::new("stale-token-a", &[]);
    let (port, _events) = start_proxy(
        format!("http://127.0.0.1:{upstream_port}"),
        tokens,
        Duration::from_secs(2),
        SHORT_IDLE_TIMEOUT,
    )
    .await;

    let mut stalled = Vec::new();
    for index in 0..CONCURRENT_STALLS {
        stalled.push(tokio::spawn(async move {
            let response = reqwest::Client::new()
                .get(format!("http://127.0.0.1:{port}/stream/stalled-{index}"))
                .header(reqwest::header::RANGE, "bytes=0-4095")
                .send()
                .await
                .expect("stalled request must get a response");
            assert_eq!(response.status(), 206);
            let body = tokio::time::timeout(SHORT_IDLE_TIMEOUT + ABORT_MARGIN, response.bytes())
                .await
                .expect("stalled body read must terminate once the proxy aborts the idle upstream");
            assert!(body.is_err(), "stalled body must surface as a read error");
        }));
    }
    for handle in stalled {
        handle.await.expect("stalled request task failed");
    }

    let response = get(port, "after-idle", None).await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.bytes().await.unwrap(), b"recycled-ok".as_slice());
}

/// (i) MEASURED STALL THRESHOLD (F.1 / R2). The investigation report claims
/// the audio-tuned `UPSTREAM_BODY_IDLE_TIMEOUT` "may hard-fail a video
/// stream" because video bitrates are high. That claim is only true if the
/// deadline is a BYTE budget. It is not: it is a wall-clock gap detector, so
/// the threshold must be exactly the configured duration REGARDLESS of how
/// fast the upstream delivers. These two tests pin that down at the PRODUCTION
/// value (20s, not a shrunken test value):
///
/// - a gap BELOW the deadline must complete the body untouched (no
///   premature abort, whatever the byte rate);
/// - a gap ABOVE it must abort, and the measured moment of the abort must
///   land on the configured 20s (not earlier, not 20s + headers timeout).
///
/// The byte rate differs by ~2000x between the two cases, which is the whole
/// point: rate does not move the threshold.
#[tokio::test(flavor = "multi_thread")]
async fn measured_stall_threshold_is_the_configured_deadline_not_a_byte_budget() {
    /// A gap comfortably inside the deadline.
    const SUB_DEADLINE_GAP: Duration = Duration::from_secs(2);
    /// Body size for the sub-deadline case: 64 bytes per millisecond of the
    /// pause, so the upstream is a "fast" one (about 0.5 Mbit/s) and the
    /// byte budget is 2000x the stalled case's.
    const COMPLETE_LEN: usize = SUB_DEADLINE_GAP.as_millis() as usize * 64;
    /// How much slack the measured abort moment may drift by. Timer
    /// granularity plus one poll interval, nothing more.
    const TOLERANCE: Duration = Duration::from_millis(750);

    // (1) Below the deadline: an upstream that delivers its whole body and
    // only then pauses 2s before EOF MUST complete. `first_bytes ==
    // total_length` keeps Content-Length honest, so the only reason the read
    // could fail is an abort — and it must not happen.
    let (upstream_port, _recorded) = spawn_fixture(vec![respond_stalling(
        206,
        &[7u8; COMPLETE_LEN],
        COMPLETE_LEN,
        SUB_DEADLINE_GAP,
    )]);
    let tokens = StubTokens::new("stale-token-a", &[]);
    let (port, _events) = start_proxy(
        format!("http://127.0.0.1:{upstream_port}"),
        tokens,
        Duration::from_secs(2),
        UPSTREAM_BODY_IDLE_TIMEOUT,
    )
    .await;
    let response = get(port, "sub-deadline", Some(&format!("bytes=0-{}", COMPLETE_LEN - 1))).await;
    assert_eq!(response.status(), 206);
    let started = Instant::now();
    let body = tokio::time::timeout(
        UPSTREAM_BODY_IDLE_TIMEOUT + ABORT_MARGIN,
        response.bytes(),
    )
    .await
    .expect("a gap below the idle deadline must NOT abort");
    assert_eq!(
        body.map(|bytes| bytes.len()).unwrap_or(0),
        COMPLETE_LEN,
        "a sub-deadline pause must deliver the full body (an abort would surface as an Err)"
    );
    println!(
        "[evidence] F.1 gap {SUB_DEADLINE_GAP:?} < {UPSTREAM_BODY_IDLE_TIMEOUT:?}: body completed in {:?}",
        started.elapsed()
    );

    // (2) Above the deadline: the SAME fixture shape but a gap that outlives
    // the production deadline. The abort must land ON the deadline.
    let overshoot = Duration::from_secs(10);
    let (upstream_port, _recorded) = spawn_fixture(vec![respond_stalling(
        206,
        &[0u8; STALLED_FIRST_BYTES],
        STALLED_TOTAL_LENGTH,
        UPSTREAM_BODY_IDLE_TIMEOUT + overshoot,
    )]);
    let tokens = StubTokens::new("stale-token-a", &[]);
    let (port, events) = start_proxy(
        format!("http://127.0.0.1:{upstream_port}"),
        tokens,
        Duration::from_secs(2),
        UPSTREAM_BODY_IDLE_TIMEOUT,
    )
    .await;
    let response = get(port, "over-deadline", Some("bytes=0-4095")).await;
    assert_eq!(response.status(), 206);
    let started = Instant::now();
    let body = tokio::time::timeout(
        UPSTREAM_BODY_IDLE_TIMEOUT + overshoot + ABORT_MARGIN,
        response.bytes(),
    )
    .await
    .expect("the client read must terminate once the idle deadline fires");
    let measured = started.elapsed();
    assert!(
        body.is_err(),
        "a gap past the deadline must abort, got {} bytes",
        body.map(|bytes| bytes.len()).unwrap_or(0)
    );
    assert!(
        measured >= UPSTREAM_BODY_IDLE_TIMEOUT - TOLERANCE
            && measured <= UPSTREAM_BODY_IDLE_TIMEOUT + TOLERANCE,
        "the abort must land on the configured {UPSTREAM_BODY_IDLE_TIMEOUT:?}, measured {measured:?}"
    );
    assert_eq!(
        *events.lock().unwrap(),
        vec![("over-deadline".to_string(), server::IDLE_ABORT_STATUS)],
        "exactly one idle-abort event at the configured deadline"
    );
    println!(
        "[evidence] F.1 gap > {UPSTREAM_BODY_IDLE_TIMEOUT:?}: aborted after {measured:?} (budget {UPSTREAM_BODY_IDLE_TIMEOUT:?} + headers {UPSTREAM_HEADERS_TIMEOUT:?})"
    );
}

/// R04-5/R04-6/R04-7: a `DriveTokenSource` wired to stubs instead of the
/// OS keyring and the token endpoint, so the refresh paths run
/// deterministically inside a test. Returns the number of mint calls.
fn stub_source(
    refresh_timeout: Duration,
    mint_delay: Duration,
) -> (Arc<DriveTokenSource>, Arc<AtomicUsize>) {
    let vault_read: VaultRead = Arc::new(|| Ok(Some("stub-refresh-token".to_string())));
    stub_source_with_vault(refresh_timeout, VAULT_CALL_TIMEOUT, mint_delay, vault_read)
}

/// `stub_source` with the vault read and its deadline injected.
fn stub_source_with_vault(
    refresh_timeout: Duration,
    vault_read_timeout: Duration,
    mint_delay: Duration,
    vault_read: VaultRead,
) -> (Arc<DriveTokenSource>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let minted = Arc::clone(&calls);
    let mint: MintFn = Arc::new(move |_refresh_token: String| {
        let call = minted.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            tokio::time::sleep(mint_delay).await;
            Ok(serde_json::json!({ "access_token": format!("fresh-{call}") }))
        })
    });
    let source = Arc::new(DriveTokenSource {
        cached: Mutex::new(None),
        refresh_lock: AsyncMutex::new(()),
        generation: AtomicU64::new(0),
        refresh_timeout,
        vault_read_timeout,
        vault_read: Some(vault_read),
        mint: Some(mint),
    });
    (source, calls)
}

/// A vault read that stalls far past the (shrunk) deadline: simulates a
/// wedged Windows Credential Manager. The sleep runs on a blocking thread
/// exactly like the real vault read, and stays short so runtime teardown
/// does not wait long for it.
fn stalled_vault_read() -> VaultRead {
    Arc::new(|| {
        std::thread::sleep(Duration::from_millis(250));
        Ok(Some("stub-refresh-token".to_string()))
    })
}

/// R04-8: a vault read that outlives `vault_read_timeout` must fail the
/// refresh within the deadline and free the lock for the next caller.
#[tokio::test(flavor = "multi_thread")]
async fn vault_read_times_out_and_releases_the_lock() {
    /// Wide bound so a regression to an unbounded vault read fails this
    /// test instead of hanging it.
    const GUARD: Duration = Duration::from_secs(2);
    let (source, _calls) = stub_source_with_vault(
        Duration::from_secs(5),
        Duration::from_millis(50),
        Duration::ZERO,
        stalled_vault_read(),
    );
    let started = Instant::now();

    let first = tokio::time::timeout(GUARD, Arc::clone(&source).refresh(true))
        .await
        .expect("refresh must return at the vault-read deadline (unbounded read -> this guard fired)");
    let error = first.expect_err("a stalled vault read must fail the refresh");
    assert!(error.contains("timed out"), "the error must name the timeout, got: {error}");

    // The lock must be free again: the next caller reaches its own
    // deadline promptly instead of queueing behind the stalled read.
    let second = tokio::time::timeout(GUARD, Arc::clone(&source).refresh(true))
        .await
        .expect("the refresh lock must be released after the timeout");
    let error = second.expect_err("the second caller must fail at the deadline too");
    assert!(error.contains("timed out"), "the second caller must reach the vault deadline, got: {error}");
    assert!(
        started.elapsed() < GUARD,
        "both callers must return at the deadline, took {:?}",
        started.elapsed()
    );
}

/// R04-7: a token endpoint that outlives `refresh_timeout` must end the
/// refresh with a timeout error and free the lock for the next caller.
#[tokio::test(flavor = "multi_thread")]
async fn refresh_times_out_and_releases_the_lock() {
    let (source, calls) = stub_source(Duration::from_millis(100), Duration::from_secs(1));
    let started = Instant::now();

    let first = Arc::clone(&source).refresh(true).await;
    assert!(first.is_err(), "a hung mint must time out, got: {first:?}");
    assert!(first.unwrap_err().contains("timed out"), "the error must name the timeout");

    // The lock must be free again: the next caller hits its own timeout
    // promptly instead of queueing behind the first (hung) mint.
    let second = Arc::clone(&source).refresh(true).await;
    assert!(second.is_err(), "the second caller must fail fast too");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "both callers must return at the deadline, took {:?}",
        started.elapsed()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2, "each timed-out call is a fresh attempt");
    assert!(source.current().is_none(), "a timed-out mint must not populate the cache");
}

/// R04-6: two callers whose 401s both predate the first mint completing
/// share one token-endpoint call; the second reuses the minted token.
#[tokio::test(flavor = "multi_thread")]
async fn concurrent_401_refresh_mints_once_and_shares_the_token() {
    let (source, calls) = stub_source(Duration::from_secs(5), Duration::from_millis(200));

    let (first, second) = tokio::join!(
        Arc::clone(&source).refresh(true),
        Arc::clone(&source).refresh(true),
    );

    assert_eq!(first.expect("first refresh must succeed"), "fresh-0");
    assert_eq!(second.expect("second refresh must reuse the fresh token"), "fresh-0");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "the stampede must collapse to one mint");
}

/// R04-6 guard: a 401 observed AFTER a completed mint is a real second
/// rejection; the next `force=true` refresh must mint again.
#[tokio::test(flavor = "multi_thread")]
async fn sequential_401_after_a_completed_mint_mints_again() {
    let (source, calls) = stub_source(Duration::from_secs(5), Duration::from_millis(10));

    let first = Arc::clone(&source).refresh(true).await.expect("first mint");
    let second = Arc::clone(&source).refresh(true).await.expect("second mint");

    assert_eq!(first, "fresh-0");
    assert_eq!(second, "fresh-1");
    assert_eq!(calls.load(Ordering::SeqCst), 2, "a later 401 must mint again");
}
