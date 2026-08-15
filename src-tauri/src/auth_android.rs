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
use oauth2::basic::BasicClient;
use oauth2::reqwest::async_http_client;
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
const MOBILE_REDIRECT_URI: &str = "com.drplay.app:/oauth2redirect";

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

    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    let deadline = tokio::time::Instant::now() + MOBILE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(
                "Authorization timeout: user did not complete login within 5 minutes.".to_string(),
            );
        }
        let received = tokio::time::timeout(remaining, rx.recv()).await;
        let url = match received {
            Err(_) => {
                return Err(
                    "Authorization timeout: user did not complete login within 5 minutes."
                        .to_string(),
                );
            }
            Ok(Err(_)) => {
                return Err("Deep-link channel closed unexpectedly".to_string());
            }
            Ok(Ok(url)) => url,
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
                    .request_async(async_http_client)
                    .await;
                return match token_result {
                    Ok(token) => Ok(serde_json::json!({
                        "access_token": token.access_token().secret().to_string(),
                        "refresh_token": token.refresh_token().map(|t| t.secret().to_string()),
                        "expires_in": token.expires_in().map(|d| d.as_secs()),
                    })),
                    Err(e) => Err(format!("Failed to exchange token: {e:?}")),
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
}
