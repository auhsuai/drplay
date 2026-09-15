//! Localhost stream proxy for mpv: mpv opens `http://127.0.0.1:{port}/stream/{fileId}`
//! and this proxy forwards the request to Google Drive `files/{id}?alt=media`,
//! attaching the Bearer access token, forwarding the client `Range` header and
//! passing the upstream status (206/Content-Range) back untouched.
//!
//! The proxy binds 127.0.0.1 on an ephemeral port, so it is reachable only
//! from the local machine. Tokens are never logged (AGENTS.md Luật 4).
//!
//! Upstream redirects are NOT followed by reqwest (Policy::none): Google may
//! 302 to a different origin and clients strip `Authorization` on cross-origin
//! redirects, so each hop is followed manually with the header re-applied.

mod server;

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::Manager;
use tokio::sync::Mutex as AsyncMutex;

use crate::auth;

/// Production Drive API origin; tests inject a fixture server URL instead.
const DRIVE_BASE_URL: &str = "https://www.googleapis.com";
/// Deadline for the upstream to deliver response HEADERS. The body stream
/// itself is intentionally not time-limited: media streams run for minutes.
const UPSTREAM_HEADERS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// Deadline for a GAP between upstream body reads once headers have arrived
/// (including waiting for the first chunk). A media stream is expected to run
/// for minutes, but silence for this long means the network died mid-stream:
/// without this deadline the body feeder parks on `chunk()` forever, the
/// worker never returns to `recv()` and mpv never gets a read error to end
/// the file (incident 2026-09-13). 20s sits below the player's `--cache-secs=30`
/// window on purpose: when upstream goes silent the abort lands while the
/// audio buffer is usually still playing, so mpv's reconnect with `Range`
/// barely misses audio; a hard network death also gets its verdict at ~20s +
/// headers timeout instead of ~30s + headers timeout. Still above Drive's
/// normal short chunk stalls, so healthy streams are not cut.
const UPSTREAM_BODY_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Source of Drive access tokens, injected so tests can run without real
/// credentials while production reuses the exact auth.rs/token_store.rs logic.
pub(crate) trait TokenSource: Send + Sync + 'static {
    /// Access token currently cached (may be stale); `None` means "never minted here".
    fn current(&self) -> Option<String>;
    /// Mint an access token. `force=true` skips the cached value (used after a
    /// 401 so a just-rejected token is never reused without a refresh).
    fn refresh(self: Arc<Self>, force: bool)
        -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
}

/// Production token source: reads the refresh token from the OS credential
/// vault via `token_store`, mints access tokens through the existing
/// `auth::refresh_google_token`, and caches the latest access token in memory
/// (the frontend keeps its own copy in localStorage; the proxy never sees it).
///
/// `refresh` is single-flight and stampede-proof: concurrent workers hitting
/// an expired token at the same moment serialize on `refresh_lock`, and a
/// `force=true` caller whose 401 predates a concurrent mint reuses that
/// freshly minted token instead of calling the token endpoint again.
struct DriveTokenSource {
    cached: Mutex<Option<String>>,
    refresh_lock: AsyncMutex<()>,
    /// Bumped after every successful mint (R04-6); a `force=true` caller
    /// compares it against the value observed at its 401 to reuse a token a
    /// concurrent worker minted while it waited for the lock.
    generation: AtomicU64,
    /// Deadline for one token-endpoint call; defaults to
    /// `UPSTREAM_HEADERS_TIMEOUT` and is shrunk by tests.
    refresh_timeout: std::time::Duration,
    /// Test seams (production: `None`): replace the OS-vault read and the
    /// token-endpoint call so tests run without the keyring or the network.
    vault_read: Option<VaultRead>,
    mint: Option<MintFn>,
}

/// One token-endpoint call, as the JSON payload `auth.rs` returns it.
type MintFuture = Pin<Box<dyn Future<Output = Result<serde_json::Value, String>> + Send>>;
/// Test seam for the token-endpoint call.
type MintFn = Arc<dyn Fn(String) -> MintFuture + Send + Sync>;
/// Test seam for the OS-vault read.
type VaultRead = Arc<dyn Fn() -> Result<Option<String>, String> + Send + Sync>;

impl Default for DriveTokenSource {
    fn default() -> Self {
        Self {
            cached: Mutex::new(None),
            refresh_lock: AsyncMutex::new(()),
            generation: AtomicU64::new(0),
            refresh_timeout: UPSTREAM_HEADERS_TIMEOUT,
            vault_read: None,
            mint: None,
        }
    }
}

impl TokenSource for DriveTokenSource {
    fn current(&self) -> Option<String> {
        self.cached.lock().ok().and_then(|guard| guard.clone())
    }

    fn refresh(self: Arc<Self>, force: bool)
        -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>>
    {
        Box::pin(async move {
            // Observation point for the 401 stampede: callers invoke
            // `refresh(true)` the moment they see a 401, so a generation read
            // here predates any mint this caller could be racing with.
            let observed = self.generation.load(Ordering::SeqCst);
            if !force {
                if let Some(token) = self.current() {
                    return Ok(token);
                }
            }
            let _guard = self.refresh_lock.lock().await;
            if !force {
                if let Some(token) = self.current() {
                    // Another worker refreshed while we waited for the lock.
                    return Ok(token);
                }
            } else if self.generation.load(Ordering::SeqCst) > observed {
                // Another worker minted and cached a token after this caller
                // observed its 401, so that 401 cannot have been caused by the
                // new token: reuse it instead of minting again. A token that
                // really was rejected still ends the request at the retry-once
                // 502 cap, so no rejection can loop here.
                if let Some(token) = self.current() {
                    return Ok(token);
                }
            }
            // The OS credential vault is blocking (Windows Credential
            // Manager), so it runs on a blocking thread like auth.rs does: a
            // stalled vault must not occupy an executor thread. The refresh
            // task still awaits this JoinHandle while holding `refresh_lock`,
            // so a hung vault does serialize the other refresh callers.
            let stored = match &self.vault_read {
                Some(read) => {
                    let read = Arc::clone(read);
                    tauri::async_runtime::spawn_blocking(move || read()).await
                }
                None => tauri::async_runtime::spawn_blocking(crate::token_store::get_refresh_token).await,
            };
            let refresh_token = match stored {
                Ok(Ok(Some(token))) => token,
                Ok(Ok(None)) => return Err("not signed in: no refresh token stored".to_string()),
                Ok(Err(vault_error)) => return Err(vault_error),
                Err(join_error) => {
                    return Err(format!("reading the refresh token from the OS vault failed: {join_error}"))
                }
            };
            let minted: MintFuture = match &self.mint {
                Some(mint) => mint(refresh_token),
                None => Box::pin(auth::refresh_google_token(refresh_token)),
            };
            // Defense in depth: auth.rs already builds the refresh client with
            // a 12s timeout, so `minted` normally settles first; this outer
            // deadline bounds the `refresh_lock` hold even if that inner
            // timeout is ever removed or misconfigured.
            let payload = tokio::time::timeout(self.refresh_timeout, minted)
                .await
                .map_err(|_elapsed| format!("token refresh timed out after {:?}", self.refresh_timeout))??;
            let access_token = payload["access_token"]
                .as_str()
                .ok_or_else(|| "token refresh response is missing access_token".to_string())?
                .to_string();
            // Google may rotate the refresh token; persist the rotation so the
            // next cold start keeps working. Failure is non-fatal (the old
            // token usually remains valid) but is logged. The vault write is
            // blocking too, so it also runs on a blocking thread.
            if let Some(rotated) = payload["refresh_token"].as_str() {
                let rotated = rotated.to_string();
                let stored = tauri::async_runtime::spawn_blocking(move || {
                    crate::token_store::set_refresh_token(rotated)
                })
                .await;
                match stored {
                    Ok(Ok(())) => {}
                    Ok(Err(store_error)) => {
                        log::warn!("[stream-proxy] failed to persist rotated refresh token: {store_error}");
                    }
                    Err(join_error) => {
                        log::warn!("[stream-proxy] persisting the rotated refresh token failed: {join_error}");
                    }
                }
            }
            if let Ok(mut guard) = self.cached.lock() {
                *guard = Some(access_token.clone());
            }
            // Publish the mint before the lock is released, so a deduping
            // caller that reads a newer generation normally finds the token.
            // If the cached write above was skipped (poisoned mutex), such a
            // caller just mints again — same as no dedup, never a wrong token.
            self.generation.fetch_add(1, Ordering::SeqCst);
            Ok(access_token)
        })
    }
}

/// Lazily create / fetch the started-port slot (mirror of the mpv state pattern).
type SharedPort = Arc<Mutex<Option<u16>>>;

fn proxy_state(app: &tauri::AppHandle) -> SharedPort {
    if let Some(existing) = app.try_state::<SharedPort>() {
        return existing.inner().clone();
    }
    app.manage(Arc::new(Mutex::new(None::<u16>)));
    app.state::<SharedPort>().inner().clone()
}

fn lock_port(state: &SharedPort) -> Result<std::sync::MutexGuard<'_, Option<u16>>, String> {
    state.lock().map_err(|_| "stream proxy port state poisoned".to_string())
}

/// Bind the proxy on 127.0.0.1:0 and keep it running for the process lifetime.
/// Idempotent: once started, the same port is returned without rebinding.
#[tauri::command]
pub async fn stream_proxy_start(app: tauri::AppHandle) -> Result<u16, String> {
    let state = proxy_state(&app);
    let mut guard = lock_port(&state)?;
    if let Some(port) = *guard {
        return Ok(port);
    }
    use tauri::Emitter;
    let event_app = app.clone();
    let sink: server::ErrorSink = Arc::new(move |file_id, status| {
        let _ = event_app.emit("stream-proxy-error", json!({ "fileId": file_id, "status": status }));
    });
    let port = server::spawn_proxy(
        sink,
        DRIVE_BASE_URL.to_string(),
        Arc::new(DriveTokenSource::default()),
        UPSTREAM_HEADERS_TIMEOUT,
        UPSTREAM_BODY_IDLE_TIMEOUT,
    )?;
    *guard = Some(port);
    log::info!("[stream-proxy] started on 127.0.0.1:{port}");
    Ok(port)
}

#[cfg(test)]
mod tests {
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

    /// R04-5/R04-6/R04-7: a `DriveTokenSource` wired to stubs instead of the
    /// OS keyring and the token endpoint, so the refresh paths run
    /// deterministically inside a test. Returns the number of mint calls.
    fn stub_source(
        refresh_timeout: Duration,
        mint_delay: Duration,
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
        let vault_read: VaultRead = Arc::new(|| Ok(Some("stub-refresh-token".to_string())));
        let source = Arc::new(DriveTokenSource {
            cached: Mutex::new(None),
            refresh_lock: AsyncMutex::new(()),
            generation: AtomicU64::new(0),
            refresh_timeout,
            vault_read: Some(vault_read),
            mint: Some(mint),
        });
        (source, calls)
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
}
