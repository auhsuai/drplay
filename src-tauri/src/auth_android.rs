// Mobile (Android) Google OAuth flow per RFC 8252: the system browser opens
// the Google consent page and the authorization code comes back through a
// custom-scheme deep link (tauri-plugin-deep-link) instead of a localhost
// loopback server (which is what the desktop flow in auth.rs uses). The
// desktop loopback flow (login_google_native) is untouched — this module is
// only invoked from the mobile UI.
//
// GCP setup required (one-time, by the user):
// 1. Google Cloud Console > APIs & Services > Credentials > Create
//    Credentials > OAuth client ID > Android.
// 2. Package name: com.drplay.app (matches tauri.conf.json identifier).
//    SHA-1: from the app's signing keystore, e.g.
//      keytool -list -v -keystore <keystore> -alias androiddebugkey
//    (debug keystore: ~/.android/debug.keystore, storepass "android").
// 3. Google registers the redirect URI "com.drplay.app:/oauth2redirect" for
//    that client — it MUST match MOBILE_REDIRECT_URI below exactly.
// 4. Since Oct 2023 Google requires enabling "Custom URI schemes" under
//    OAuth consent screen > Advanced settings before custom-scheme redirects
//    are accepted.
// 5. Paste the Android client id (ends in .apps.googleusercontent.com) into
//    ANDROID_CLIENT_ID below.
use crate::auth_errors::format_exchange_error;
use crate::dpop::dpop_http_client;
use oauth2::basic::BasicClient;
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, CsrfToken, PkceCodeChallenge, RedirectUrl, Scope,
    TokenResponse, TokenUrl,
};
use serde_json::Value;
use std::sync::OnceLock;
use tauri::command;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// Redirect URI Google sends the code to after consent. Must match the URI
/// registered for the Android OAuth client in GCP exactly (see module docs).
/// Both `com.drplay.app:/oauth2redirect` and `com.drplay.app://oauth2redirect`
/// resolve to the same deep-link intent filter (scheme-only, no host).
///
/// `pub(crate)` so the moved pipeline tests in auth_errors can build a
/// client shaped exactly like `login_google_mobile` without duplicating the
/// literal.
pub(crate) const MOBILE_REDIRECT_URI: &str = "com.drplay.app:/oauth2redirect";

/// GCP OAuth client id for the ANDROID app (public client — no secret, per
/// RFC 8252). Created 2026-08-15 in Google Cloud Console project 72581565914;
/// must match the client registered with package com.drplay.app + SHA-1
/// DA:C2:0C:1C:F9:F0:E1:5C:3C:23:D2:D9:04:04:72:C4:11:99:AC:31 and the
/// "Custom URI schemes" advanced setting enabled.
pub(crate) const ANDROID_CLIENT_ID: &str = "72581565914-vsdl8b65dutbtrrrtpqf71pirqq4cifp.apps.googleusercontent.com";

/// How long the mobile flow waits for the deep-link redirect — same 5 minutes
/// as the desktop loopback flow (auth.rs:48).
const MOBILE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Broadcast channel carrying every custom-scheme URL the app receives while
/// running. One listener is registered once in lib.rs setup; each login
/// attempt subscribes and filters by its own CSRF state, so a stale redirect
/// from an earlier login can never abort a newer one.
static DEEP_LINK_TX: OnceLock<tokio::sync::broadcast::Sender<tauri::Url>> = OnceLock::new();

/// Error returned when a mobile login attempt is cancelled by the user or
/// superseded by a newer attempt. The frontend classifier matches errors by
/// substring, checking the cancellation family FIRST: this message must keep
/// containing "cancel" and must NOT contain "timeout"/"timed out" (guarded by
/// a test below).
const LOGIN_CANCELLED: &str = "Login cancelled";

/// Generation counter shared by every mobile login attempt (`watch` retains
/// the last value and wakes all receivers on change, and `send_replace`
/// updates it even with zero receivers — docs.rs/tokio watch::Sender). Each
/// `login_google_mobile` claims one generation; a later claim (cancel command
/// or newer attempt) makes every older claim stale, and the stale loops exit
/// immediately instead of riding out their 5-minute deadline.
static LOGIN_GENERATION_TX: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();

fn login_generation_tx() -> &'static tokio::sync::watch::Sender<u64> {
    LOGIN_GENERATION_TX.get_or_init(|| tokio::sync::watch::Sender::new(0))
}

/// Advance the shared generation counter and return the new value. Monotonic
/// (wrapping); each caller treats the returned value as its claim ticket.
fn bump_generation() -> u64 {
    let tx = login_generation_tx();
    // Scope the borrow guard so the read lock is released before send_replace
    // takes the write side (long-lived borrows can deadlock the sender).
    let next = tx.borrow().wrapping_add(1);
    tx.send_replace(next);
    next
}

/// Why `wait_for_redirect` stopped waiting. Mapped 1:1 onto the exact error
/// strings `login_google_mobile` has always returned.
#[derive(Debug, PartialEq)]
enum WaitFailure {
    /// Deadline elapsed — same condition as the previous timeout branches.
    Timeout,
    /// Deep-link broadcast receiver errored (closed/lagged) — preserved from
    /// the previous `Ok(Err(_))` arm.
    ChannelClosed,
    /// A newer generation was claimed (user cancel or newer login attempt).
    Cancelled,
}

/// Wait for exactly one of: the next deep-link URL, generation invalidation,
/// or the deadline. Pure move of the previous per-iteration wait logic — the
/// only change is the new `generation_rx.changed()` select arm, which exits
/// the moment this attempt stops being current. Both `broadcast::recv()` and
/// `watch::changed()` are documented cancel-safe, so dropping the losing
/// branch loses nothing.
async fn wait_for_redirect(
    deep_link_rx: &mut tokio::sync::broadcast::Receiver<tauri::Url>,
    generation_rx: &mut tokio::sync::watch::Receiver<u64>,
    expected_generation: u64,
    remaining: std::time::Duration,
) -> Result<tauri::Url, WaitFailure> {
    // Catch bumps that landed between iterations (e.g. while the caller was
    // parsing the previous URL): cheaper and more deterministic than waiting
    // for the next poll of changed().
    if *generation_rx.borrow() != expected_generation {
        return Err(WaitFailure::Cancelled);
    }
    tokio::select! {
        // The generation sender lives in a static for the whole process, so
        // this arm fires only on an actual bump — i.e. we are no longer
        // current. Any outcome means "this attempt is dead".
        _ = generation_rx.changed() => Err(WaitFailure::Cancelled),
        received = tokio::time::timeout(remaining, deep_link_rx.recv()) => match received {
            Err(_) => Err(WaitFailure::Timeout),
            Ok(Err(_)) => Err(WaitFailure::ChannelClosed),
            Ok(Ok(url)) => Ok(url),
        },
    }
}

/// A parsed OAuth redirect, validated against the expected CSRF state.
#[derive(Debug, PartialEq)]
pub struct OAuthRedirect {
    /// Authorization code (present when the user granted access).
    pub code: Option<String>,
    /// The CSRF state echoed back by Google.
    pub state: String,
    /// Google error reason (e.g. "access_denied" when the user cancels).
    pub error: Option<String>,
}

/// Classification of redirects that cannot belong to the expected login flow.
#[derive(Debug, PartialEq)]
pub enum OAuthError {
    /// Not parseable as a URL at all.
    MalformedUrl,
    /// No state parameter — not an OAuth redirect of ours.
    MissingState,
    /// State present but different from the expected CSRF token — a redirect
    /// from a stale/different login flow.
    CsrfMismatch,
}

/// Parse a `com.drplay.app:/oauth2redirect?code=...&state=...` redirect and
/// validate its CSRF state. Returns Ok for redirects that DO belong to the
/// expected flow (the caller interprets code/error); Err when the redirect
/// clearly belongs to someone else or is garbage.
pub fn parse_oauth_redirect(url: &str, expected_state: &str) -> Result<OAuthRedirect, OAuthError> {
    let parsed = Url::parse(url).map_err(|_| OAuthError::MalformedUrl)?;
    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut error: Option<String> = None;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }
    // State is validated BEFORE error/code so a redirect from a different
    // (stale) login flow can never abort this one as a "cancel".
    let state = state.ok_or(OAuthError::MissingState)?;
    if state != expected_state {
        return Err(OAuthError::CsrfMismatch);
    }
    Ok(OAuthRedirect { code, state, error })
}

/// Registers the single deep-link listener for the whole app process. Called
/// once from lib.rs setup. Every custom-scheme URL the running app receives is
/// published to the broadcast channel; `login_google_mobile` subscribes per
/// attempt and filters by CSRF state. Inert on desktop (no desktop schemes are
/// configured, so the plugin never emits events there).
pub fn init_deep_link_listener(app: &tauri::App) {
    let (tx, _) = tokio::sync::broadcast::channel::<tauri::Url>(16);
    let _ = DEEP_LINK_TX.set(tx.clone());
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            // Never log the query string — it may carry an OAuth code.
            let mut safe = url.clone();
            safe.set_query(None);
            eprintln!("[drplay:auth] deep link received: {safe}");
            let _ = tx.send(url);
        }
    });
}

/// Android OAuth login (RFC 8252): system browser + custom-scheme redirect.
/// Returns the same token payload shape as the desktop `login_google_native`:
/// access_token / refresh_token / expires_in.
#[command]
pub async fn login_google_mobile(app: tauri::AppHandle) -> Result<Value, String> {
    if ANDROID_CLIENT_ID.is_empty() {
        return Err(
            "login_google_mobile: ANDROID_CLIENT_ID is not configured — follow the GCP setup documented in src-tauri/src/auth_android.rs"
                .to_string(),
        );
    }

    let client = BasicClient::new(
        ClientId::new(ANDROID_CLIENT_ID.to_string()),
        // Android OAuth clients are public — no client secret (RFC 8252 §8.4).
        None,
        AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".to_string())
            .map_err(|e| format!("invalid AuthUrl: {e:?}"))?,
        Some(
            TokenUrl::new("https://oauth2.googleapis.com/token".to_string())
                .map_err(|e| format!("invalid TokenUrl: {e:?}"))?,
        ),
    )
    .set_redirect_uri(
        RedirectUrl::new(MOBILE_REDIRECT_URI.to_string())
            .map_err(|e| format!("invalid RedirectUrl: {e:?}"))?,
    );

    // Same scopes + offline consent as the desktop flow (auth.rs:36-41).
    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
    let (auth_url, csrf_token) = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new("https://www.googleapis.com/auth/drive".to_string()))
        .add_scope(Scope::new(
            "https://www.googleapis.com/auth/drive.appdata".to_string(),
        ))
        .add_scope(Scope::new("email".to_string()))
        .add_scope(Scope::new("profile".to_string()))
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent")
        .set_pkce_challenge(pkce_challenge)
        .url();

    let tx = DEEP_LINK_TX
        .get()
        .ok_or("deep-link listener not initialized (lib.rs setup did not register it)?")?
        .clone();
    // Subscribe BEFORE opening the browser so a redirect can never race past us.
    let mut rx = tx.subscribe();

    // Claim this attempt's generation slot: bump the shared counter, then
    // subscribe and verify nothing newer claimed while we were setting up
    // (a concurrent cancel or a newer login must win over us). From here on,
    // any generation change aborts this attempt through the select arm in
    // wait_for_redirect.
    let my_generation = bump_generation();
    let mut generation_rx = login_generation_tx().subscribe();
    if *generation_rx.borrow_and_update() != my_generation {
        eprintln!(
            "[drplay:auth] login attempt abandoned before opening browser (superseded or cancelled)"
        );
        return Err(LOGIN_CANCELLED.to_string());
    }

    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    let deadline = tokio::time::Instant::now() + MOBILE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let url = match wait_for_redirect(&mut rx, &mut generation_rx, my_generation, remaining)
            .await
        {
            Ok(url) => url,
            Err(WaitFailure::Cancelled) => return Err(LOGIN_CANCELLED.to_string()),
            Err(WaitFailure::ChannelClosed) => {
                return Err("Deep-link channel closed unexpectedly".to_string())
            }
            Err(WaitFailure::Timeout) => {
                return Err(
                    "Authorization timeout: user did not complete login within 5 minutes."
                        .to_string(),
                )
            }
        };

        match parse_oauth_redirect(url.as_str(), csrf_token.secret()) {
            Ok(redirect) => {
                if redirect.error.is_some() {
                    // Google's "access_denied" (user denied consent) or a
                    // similar flow error — same message as the desktop flow so
                    // the frontend classifies it as user-cancelled.
                    return Err("User cancelled authorization".to_string());
                }
                let code = match redirect.code {
                    Some(code) => code,
                    None => return Err("Authorization failed: no code returned.".to_string()),
                };

                let token_result = client
                    .exchange_code(AuthorizationCode::new(code))
                    .set_pkce_verifier(pkce_verifier)
                    .request_async(dpop_http_client)
                    .await;
                return match token_result {
                    Ok(token) => Ok(serde_json::json!({
                        "access_token": token.access_token().secret().to_string(),
                        "refresh_token": token.refresh_token().map(|t| t.secret().to_string()),
                        "expires_in": token.expires_in().map(|d| d.as_secs()),
                    })),
                    Err(e) => Err(format_exchange_error(&e)),
                };
            }
            Err(OAuthError::CsrfMismatch) | Err(OAuthError::MissingState) | Err(OAuthError::MalformedUrl) => {
                // Not ours (stale login, another deep link, garbage) — keep
                // waiting for the redirect that matches our CSRF state.
                eprintln!(
                    "[drplay:auth] ignoring deep link that does not match this login attempt (state mismatch or malformed URL)"
                );
            }
        }
    }
}

/// Cancel the in-flight mobile Google login: bumps the shared generation
/// counter so every waiting `login_google_mobile` loop exits within
/// milliseconds with "Login cancelled" (the frontend classifier treats it as
/// a user cancellation, not an error). Idempotent and side-effect free when
/// no login is pending. A newer `login_google_mobile` also bumps the counter,
/// which supersedes any older attempt still waiting.
#[command]
pub async fn cancel_google_login() -> Result<(), String> {
    bump_generation();
    eprintln!("[drplay:auth] google login cancelled or superseded");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = "csrf-123";

    #[test]
    fn parses_code_and_state() {
        let redirect = parse_oauth_redirect(
            "com.drplay.app:/oauth2redirect?code=ABC-123&state=csrf-123",
            STATE,
        )
        .expect("valid redirect must parse");
        assert_eq!(redirect.code.as_deref(), Some("ABC-123"));
        assert_eq!(redirect.state, STATE);
        assert_eq!(redirect.error, None);
    }

    #[test]
    fn parses_double_slash_form() {
        let redirect = parse_oauth_redirect(
            "com.drplay.app://oauth2redirect?code=ABC&state=csrf-123",
            STATE,
        )
        .expect("scheme://host form must parse the same");
        assert_eq!(redirect.code.as_deref(), Some("ABC"));
    }

    #[test]
    fn parses_user_cancelled_redirect() {
        let redirect = parse_oauth_redirect(
            "com.drplay.app:/oauth2redirect?error=access_denied&state=csrf-123",
            STATE,
        )
        .expect("error redirect with matching state must parse");
        assert_eq!(redirect.code, None);
        assert_eq!(redirect.error.as_deref(), Some("access_denied"));
    }

    #[test]
    fn ignores_extra_query_params() {
        let redirect = parse_oauth_redirect(
            "com.drplay.app:/oauth2redirect?code=ABC&state=csrf-123&scope=drive&authuser=0",
            STATE,
        )
        .expect("extra params must not break parsing");
        assert_eq!(redirect.code.as_deref(), Some("ABC"));
    }

    #[test]
    fn error_and_code_both_preserved() {
        let redirect = parse_oauth_redirect(
            "com.drplay.app:/oauth2redirect?code=ABC&error=access_denied&state=csrf-123",
            STATE,
        )
        .expect("both fields must be preserved for the caller to interpret");
        assert_eq!(redirect.code.as_deref(), Some("ABC"));
        assert_eq!(redirect.error.as_deref(), Some("access_denied"));
    }

    #[test]
    fn no_code_no_error_parses_ok() {
        let redirect = parse_oauth_redirect(
            "com.drplay.app:/oauth2redirect?state=csrf-123",
            STATE,
        )
        .expect("state-only redirect parses; caller decides it means no code");
        assert_eq!(redirect.code, None);
        assert_eq!(redirect.error, None);
    }

    #[test]
    fn rejects_missing_state() {
        assert_eq!(
            parse_oauth_redirect("com.drplay.app:/oauth2redirect?code=ABC", STATE),
            Err(OAuthError::MissingState)
        );
    }

    #[test]
    fn rejects_csrf_mismatch() {
        assert_eq!(
            parse_oauth_redirect("com.drplay.app:/oauth2redirect?code=ABC&state=other-state", STATE),
            Err(OAuthError::CsrfMismatch)
        );
    }

    #[test]
    fn rejects_csrf_mismatch_even_with_error_param() {
        // State is checked before error so a foreign redirect cannot abort
        // our flow as a "cancel".
        assert_eq!(
            parse_oauth_redirect(
                "com.drplay.app:/oauth2redirect?error=access_denied&state=other-state",
                STATE
            ),
            Err(OAuthError::CsrfMismatch)
        );
    }

    #[test]
    fn rejects_malformed_url() {
        assert_eq!(
            parse_oauth_redirect("not a url at all", STATE),
            Err(OAuthError::MalformedUrl)
        );
    }

    // -------------------------------------------------------------------
    // Generation-based cancellation tests. The wait seam takes channels as
    // parameters, so every expectation-of-success test builds LOCAL channels
    // and stays immune to unrelated generation bumps from tests running in
    // parallel against the process-global channel. Only tests that exercise
    // the real global path expect Cancelled (any bump kills them).
    // -------------------------------------------------------------------

    use std::time::Duration;
    use std::time::Instant;
    use tokio::sync::broadcast;
    use tokio::sync::watch;

    fn redirect_url(query: &str) -> Url {
        Url::parse(&format!("com.drplay.app:/oauth2redirect?{query}"))
            .expect("test redirect URL must parse")
    }

    /// Mirror of the claim sequence `login_google_mobile` performs against the
    /// process-global generation channel: bump + capture + subscribe +
    /// staleness check.
    fn claim_global_generation() -> (watch::Receiver<u64>, u64) {
        let my_gen = bump_generation();
        let mut gen_rx = login_generation_tx().subscribe();
        assert_eq!(
            *gen_rx.borrow_and_update(),
            my_gen,
            "freshly claimed attempt must observe its own generation"
        );
        (gen_rx, my_gen)
    }

    #[tokio::test]
    async fn wait_delivers_matching_redirect() {
        let (gen_tx, mut gen_rx) = watch::channel(1u64);
        let (deep_link_tx, _) = broadcast::channel::<Url>(16);
        let mut deep_link_rx = deep_link_tx.subscribe();

        deep_link_tx
            .send(redirect_url("code=ABC&state=csrf-123"))
            .expect("local channel has capacity");

        let delivered = wait_for_redirect(
            &mut deep_link_rx,
            &mut gen_rx,
            *gen_tx.borrow(),
            Duration::from_secs(5),
        )
        .await
        .expect("deep link arriving while generation is current must be delivered");
        assert!(delivered.as_str().contains("code=ABC"));
    }

    #[tokio::test]
    async fn cancel_while_waiting_returns_cancelled_quickly() {
        let (gen_tx, mut gen_rx) = watch::channel(1u64);
        let expected_gen = *gen_tx.borrow();
        let (deep_link_tx, _) = broadcast::channel::<Url>(16);
        let mut deep_link_rx = deep_link_tx.subscribe();

        let bumper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            gen_tx.send_replace(2u64);
        });

        let started = Instant::now();
        let result = wait_for_redirect(
            &mut deep_link_rx,
            &mut gen_rx,
            expected_gen,
            Duration::from_secs(60),
        )
        .await;
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "cancellation must exit in milliseconds, not wait out the deadline"
        );
        assert_eq!(result, Err(WaitFailure::Cancelled));
        bumper.await.expect("bumper task must not panic");
    }

    #[tokio::test]
    async fn second_generation_supersedes_first_wait() {
        let (gen_tx, _) = watch::channel(1u64);
        // Attempt 1 claims generation 1.
        let first_gen = *gen_tx.borrow();
        let mut first_deep_link_rx;
        let mut first_gen_rx = gen_tx.subscribe();

        // Attempt 2 bumps the shared generation — supersedes attempt 1.
        gen_tx.send_replace(2u64);
        let second_gen = *gen_tx.borrow();
        let mut second_gen_rx = gen_tx.subscribe();
        assert_eq!(*second_gen_rx.borrow_and_update(), second_gen);

        let (deep_link_tx, _) = broadcast::channel::<Url>(16);
        first_deep_link_rx = deep_link_tx.subscribe();
        let mut second_deep_link_rx = deep_link_tx.subscribe();

        let started = Instant::now();
        let first_result = wait_for_redirect(
            &mut first_deep_link_rx,
            &mut first_gen_rx,
            first_gen,
            Duration::from_secs(60),
        )
        .await;
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "superseded attempt must die quickly, not ride out its deadline"
        );
        assert_eq!(first_result, Err(WaitFailure::Cancelled));

        deep_link_tx
            .send(redirect_url("code=NEW&state=csrf-123"))
            .expect("local channel has capacity");
        let second_result = wait_for_redirect(
            &mut second_deep_link_rx,
            &mut second_gen_rx,
            second_gen,
            Duration::from_secs(5),
        )
        .await
        .expect("current attempt keeps receiving redirects");
        assert!(second_result.as_str().contains("code=NEW"));
    }

    #[tokio::test]
    async fn generation_bump_before_wait_is_detected_without_awaiting() {
        // Covers the staleness pre-check: a bump landing between claiming the
        // generation and entering the select loop must abort immediately even
        // though changed() was never polled mid-wait.
        let (gen_tx, mut gen_rx) = watch::channel(1u64);
        let claimed = *gen_tx.borrow();
        gen_tx.send_replace(2u64);

        let (_, mut silent_deep_link_rx) = broadcast::channel::<Url>(16);
        let result =
            wait_for_redirect(&mut silent_deep_link_rx, &mut gen_rx, claimed, Duration::from_secs(60))
                .await;
        assert_eq!(result, Err(WaitFailure::Cancelled));
    }

    #[tokio::test]
    async fn wait_times_out_when_deadline_elapses() {
        let (gen_tx, mut gen_rx) = watch::channel(1u64);
        let expected_gen = *gen_tx.borrow();
        // Hold the sender for the whole wait so the channel stays open —
        // dropping it would surface as ChannelClosed before any timeout.
        let (deep_link_tx, mut idle_deep_link_rx) = broadcast::channel::<Url>(16);
        let _keep_channel_open = deep_link_tx;

        let result = wait_for_redirect(
            &mut idle_deep_link_rx,
            &mut gen_rx,
            expected_gen,
            Duration::from_millis(30),
        )
        .await;
        assert_eq!(result, Err(WaitFailure::Timeout));
    }

    #[tokio::test]
    async fn closed_deep_link_channel_surfaces_as_channel_closed() {
        let (gen_tx, mut gen_rx) = watch::channel(1u64);
        let expected_gen = *gen_tx.borrow();
        let (deep_link_tx, mut deep_link_rx) = broadcast::channel::<Url>(16);
        drop(deep_link_tx);

        let result = wait_for_redirect(
            &mut deep_link_rx,
            &mut gen_rx,
            expected_gen,
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(result, Err(WaitFailure::ChannelClosed));
    }

    #[tokio::test]
    async fn cancel_google_login_kills_in_flight_waiter() {
        let (mut gen_rx, my_gen) = claim_global_generation();
        let (deep_link_tx, _) = broadcast::channel::<Url>(16);
        let mut deep_link_rx = deep_link_tx.subscribe();

        let canceller = tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel_google_login()
                .await
                .expect("cancel must always succeed");
        });

        let started = Instant::now();
        let result = wait_for_redirect(
            &mut deep_link_rx,
            &mut gen_rx,
            my_gen,
            Duration::from_secs(60),
        )
        .await;
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "cancel command must wake the waiter in milliseconds"
        );
        assert_eq!(result, Err(WaitFailure::Cancelled));
        canceller.await.expect("canceller task must not panic");
    }

    #[tokio::test]
    async fn cancel_without_active_login_is_ok_noop() {
        // No receiver waits on the global channel here — the command must
        // still succeed and never panic.
        cancel_google_login()
            .await
            .expect("cancel without a pending login is an idempotent no-op");
        cancel_google_login()
            .await
            .expect("repeat cancels stay no-ops");
    }

    #[test]
    fn cancelled_message_satisfies_frontend_classifier_contract() {
        // TS classifier matches cancel-first by substring; the cancelled
        // message must contain "cancel" and must NOT collide with the
        // timeout family ("timeout"/"timed out").
        let lowered = LOGIN_CANCELLED.to_lowercase();
        assert!(lowered.contains("cancel"), "must classify as cancellation");
        assert!(!lowered.contains("timeout"), "must not classify as timeout");
        assert!(!lowered.contains("timed out"), "must not classify as timeout");
    }
}
