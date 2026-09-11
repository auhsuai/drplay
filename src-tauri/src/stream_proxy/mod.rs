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
use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::Manager;
use tokio::runtime::Handle;
use tokio::sync::Mutex as AsyncMutex;

use crate::auth;

/// Production Drive API origin; tests inject a fixture server URL instead.
const DRIVE_BASE_URL: &str = "https://www.googleapis.com";
/// Deadline for the upstream to deliver response HEADERS. The body stream
/// itself is intentionally not time-limited: media streams run for minutes.
const UPSTREAM_HEADERS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

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
/// `refresh` is single-flight: concurrent workers hitting an expired token at
/// the same moment serialize instead of stampeding the token endpoint.
struct DriveTokenSource {
    cached: Mutex<Option<String>>,
    refresh_lock: AsyncMutex<()>,
}

impl Default for DriveTokenSource {
    fn default() -> Self {
        Self { cached: Mutex::new(None), refresh_lock: AsyncMutex::new(()) }
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
            }
            let refresh_token = crate::token_store::get_refresh_token()?
                .ok_or_else(|| "not signed in: no refresh token stored".to_string())?;
            let payload = auth::refresh_google_token(refresh_token).await?;
            let access_token = payload["access_token"]
                .as_str()
                .ok_or_else(|| "token refresh response is missing access_token".to_string())?
                .to_string();
            // Google may rotate the refresh token; persist the rotation so the
            // next cold start keeps working. Failure is non-fatal (the old
            // token usually remains valid) but is logged.
            if let Some(rotated) = payload["refresh_token"].as_str() {
                if let Err(store_error) = crate::token_store::set_refresh_token(rotated.to_string()) {
                    log::warn!("[stream-proxy] failed to persist rotated refresh token: {store_error}");
                }
            }
            if let Ok(mut guard) = self.cached.lock() {
                *guard = Some(access_token.clone());
            }
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
        Handle::current(),
    )?;
    *guard = Some(port);
    log::info!("[stream-proxy] started on 127.0.0.1:{port}");
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
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
    }

    fn respond(status: u16, headers: Vec<(&'static str, String)>, body: &[u8]) -> FixtureResponse {
        FixtureResponse { status, headers, body: body.to_vec(), delay: Duration::ZERO }
    }

    fn respond_delayed(status: u16, body: &[u8], delay: Duration) -> FixtureResponse {
        FixtureResponse { status, headers: vec![], body: body.to_vec(), delay }
    }

    /// Tiny upstream standing in for Google Drive: serves the scripted
    /// responses in request order (the last one repeats) and records every
    /// request's path + auth/range headers.
    fn spawn_fixture(script: Vec<FixtureResponse>) -> (u16, Arc<Mutex<Vec<RecordedRequest>>>) {
        const FIXTURE_WORKERS: usize = 2;
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
                let mut outgoing =
                    tiny_http::Response::from_data(scripted.body).with_status_code(scripted.status);
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
    ) -> (u16, Arc<Mutex<Vec<(String, u16)>>>) {
        let events: Arc<Mutex<Vec<(String, u16)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: ErrorSink = {
            let events = Arc::clone(&events);
            Arc::new(move |file_id, status| events.lock().unwrap().push((file_id, status)))
        };
        let port = spawn_proxy(sink, base_url, tokens, headers_timeout, Handle::current())
            .expect("proxy must start");
        (port, events)
    }

    const CLIENT_TIMEOUT: Duration = Duration::from_secs(5);

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
        let (port, _events) = start_proxy(format!("http://127.0.0.1:{upstream_port}"), tokens, Duration::from_secs(2)).await;

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
        let (port, _events) = start_proxy(format!("http://127.0.0.1:{upstream_port}"), tokens, Duration::from_secs(2)).await;

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
        let (port, _events) = start_proxy(format!("http://127.0.0.1:{upstream_port}"), Arc::clone(&tokens), Duration::from_secs(2)).await;

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
        let (port, events) = start_proxy(format!("http://127.0.0.1:{upstream_port}"), Arc::clone(&tokens), Duration::from_secs(2)).await;

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
        let (port, _events) = start_proxy(format!("http://127.0.0.1:{upstream_port}"), tokens, Duration::from_secs(2)).await;

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
        )
        .await;

        let response = get(port, "slow", None).await;

        assert_eq!(response.status(), 504);
        assert_eq!(*events.lock().unwrap(), vec![("slow".to_string(), 504u16)]);
    }
}
