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

// `pub(crate)` so the mpv module's real-sidecar measurement harness
// (src/mpv/video_lifecycle.rs) can start the REAL proxy and drive a real mpv
// against it, instead of a second re-implementation of the same server.
pub(crate) mod server;

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
/// Deadline for one OS-vault call (reading the persisted refresh token, or
/// persisting a rotated one). The vault is local (Windows Credential Manager)
/// and answers in milliseconds, so a call still blocked after this means it
/// is wedged. Without this deadline a hung vault keeps `refresh_lock` held:
/// every proxy request then starves with no headers, no error, and no log —
/// mpv can only be recovered by restarting the app. Bounded here so `refresh`
/// fails fast and the proxy answers mpv with a proper 502.
const VAULT_CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

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
    /// Deadline for one OS-vault call; defaults to `VAULT_CALL_TIMEOUT` and
    /// is shrunk by tests.
    vault_read_timeout: std::time::Duration,
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
            vault_read_timeout: VAULT_CALL_TIMEOUT,
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
            // stalled vault must not occupy an executor thread. It also runs
            // under `vault_read_timeout`: this task awaits the vault while
            // holding `refresh_lock`, so an unbounded read would serialize
            // every later refresh caller behind a wedged vault — no headers,
            // no error, no log reaches mpv (incident hardening).
            let stored = tokio::time::timeout(self.vault_read_timeout, async {
                match &self.vault_read {
                    Some(read) => {
                        let read = Arc::clone(read);
                        tauri::async_runtime::spawn_blocking(move || read()).await
                    }
                    None => tauri::async_runtime::spawn_blocking(crate::token_store::get_refresh_token).await,
                }
            })
            .await
            .map_err(|_elapsed| {
                format!("token vault read timed out after {:?}", self.vault_read_timeout)
            })?;
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
                // Same deadline as the read: this blocking vault write runs
                // while `refresh_lock` is held too, so a wedged vault must not
                // hold the lock past the deadline. Persisting stays
                // best-effort — a timeout is logged and the mint still returns.
                let stored = tokio::time::timeout(
                    self.vault_read_timeout,
                    tauri::async_runtime::spawn_blocking(move || {
                        crate::token_store::set_refresh_token(rotated)
                    }),
                )
                .await;
                match stored {
                    Ok(Ok(Ok(()))) => {}
                    Ok(Ok(Err(store_error))) => {
                        log::warn!("[stream-proxy] failed to persist rotated refresh token: {store_error}");
                    }
                    Ok(Err(join_error)) => {
                        log::warn!("[stream-proxy] persisting the rotated refresh token failed: {join_error}");
                    }
                    Err(_elapsed) => {
                        log::warn!(
                            "[stream-proxy] persisting the rotated refresh token timed out after {:?}",
                            self.vault_read_timeout
                        );
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
mod tests;
