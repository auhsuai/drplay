use oauth2::basic::BasicClient;
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge,
    RedirectUrl, Scope, TokenResponse, TokenUrl, RefreshToken
};
use serde_json::Value;
use tauri::command;

use crate::AppError;

/// Build the sync HTTP client used for the code-exchange request (runs
/// inside spawn_blocking). `oauth2` v4's removed `oauth2::reqwest::http_client`
/// helper built a client with default settings -- including following
/// redirects, which the crate's own v5 docs call out as an SSRF risk during
/// token exchange (a redirected response could hand the code/token to an
/// unintended host). Disabling redirects entirely closes that off; this app
/// only ever talks to a single, hardcoded Google endpoint anyway.
fn build_sync_http_client() -> Result<reqwest::blocking::Client, AppError> {
    reqwest::blocking::ClientBuilder::new()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::Auth(format!("failed to build HTTP client: {e}")))
}

fn build_async_http_client() -> Result<reqwest::Client, AppError> {
    reqwest::ClientBuilder::new()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::Auth(format!("failed to build HTTP client: {e}")))
}

#[command]
pub async fn login_google_native() -> Result<Value, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        const CREDENTIALS_JSON: &str = include_str!("../../../wa_credential.json");
        let creds: serde_json::Value = serde_json::from_str(CREDENTIALS_JSON).map_err(|e| AppError::Auth(format!("Invalid wa_credential.json: {}", e)))?;
        let client_id = ClientId::new(creds["installed"]["client_id"].as_str().ok_or_else(|| AppError::Auth("Missing client_id in wa_credential.json".to_string()))?.to_string());
        let client_secret = ClientSecret::new(creds["installed"]["client_secret"].as_str().ok_or_else(|| AppError::Auth("Missing client_secret in wa_credential.json".to_string()))?.to_string());
        let auth_url = AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".to_string()).map_err(|e| AppError::Auth(format!("invalid AuthUrl: {e:?}")))?;
        let token_url = TokenUrl::new("https://oauth2.googleapis.com/token".to_string()).map_err(|e| AppError::Auth(format!("invalid TokenUrl: {e:?}")))?;

        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| AppError::Auth(format!("Failed to start server: {}", e)))?;
        let port = server.server_addr().to_ip().ok_or_else(|| AppError::Auth("server address has no IP".to_string()))?.port();
        let redirect_uri = format!("http://127.0.0.1:{}", port);

        let client = BasicClient::new(client_id)
            .set_client_secret(client_secret)
            .set_auth_uri(auth_url)
            .set_token_uri(token_url)
            .set_redirect_uri(RedirectUrl::new(redirect_uri.clone()).map_err(|e| AppError::Auth(format!("invalid RedirectUrl: {e:?}")))?);

        let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
        let (auth_url, csrf_token) = client
            .authorize_url(CsrfToken::new_random)
            .add_scope(Scope::new("https://www.googleapis.com/auth/drive".to_string()))
            .add_scope(Scope::new("https://www.googleapis.com/auth/drive.appdata".to_string()))
            .add_scope(Scope::new("email".to_string()))
            .add_scope(Scope::new("profile".to_string()))
            .add_extra_param("access_type", "offline")
            .add_extra_param("prompt", "consent")
            .set_pkce_challenge(pkce_challenge)
            .url();

        open::that(auth_url.as_str()).map_err(|e| AppError::Auth(format!("Failed to open browser: {}", e)))?;

        let timeout = std::time::Duration::from_secs(300);
        let start_time = std::time::Instant::now();

        while start_time.elapsed() < timeout {
            if let Ok(Some(request)) = server.recv_timeout(std::time::Duration::from_millis(500)) {
                let url = format!("{}{}", redirect_uri, request.url());
                let parsed_url = url::Url::parse(&url).map_err(|e| AppError::Auth(format!("Invalid redirect URL: {}", e)))?;

                let code = parsed_url.query_pairs().find(|(key, _)| key == "code");
                let state = parsed_url.query_pairs().find(|(key, _)| key == "state");
                let error = parsed_url.query_pairs().find(|(key, _)| key == "error");

                if error.is_some() {
                    let response = tiny_http::Response::from_string("<html><body><script>window.close();</script></body></html>")
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).map_err(|e| AppError::Auth(format!("invalid Content-Type header: {e:?}")))?);
                    let _ = request.respond(response);
                    // NOTE: message text is substring-matched by
                    // src/ui/Login/LoginScreen.tsx's handleLoginClick -- keep
                    // it byte-for-byte identical if you ever touch this line
                    // (see src-tauri/src/error.rs's module doc).
                    return Err(AppError::Auth("User cancelled authorization".to_string()));
                }

                if let (Some((_, code)), Some((_, state))) = (code, state) {
                    if state.into_owned() != *csrf_token.secret() {
                        let _ = request.respond(tiny_http::Response::from_string("CSRF Token Mismatch!"));
                        return Err(AppError::Auth("CSRF Token Mismatch".to_string()));
                    }

                    let html_response = include_str!("auth_success.html");
                    let response = tiny_http::Response::from_string(html_response)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).map_err(|e| AppError::Auth(format!("invalid Content-Type header: {e:?}")))?);
                    let _ = request.respond(response);

                    let sync_http_client = build_sync_http_client()?;
                    let token_result = client
                        .exchange_code(AuthorizationCode::new(code.into_owned()))
                        .set_pkce_verifier(pkce_verifier)
                        .request(&sync_http_client);

                    match token_result {
                        Ok(token) => {
                            let access_token = token.access_token().secret().to_string();
                            let refresh_token = token.refresh_token().map(|t| t.secret().to_string());
                            return Ok(serde_json::json!({
                                "access_token": access_token,
                                "refresh_token": refresh_token
                            }));
                        }
                        // NOTE: this is where a real "invalid_grant"-shaped
                        // Google error would actually surface for THIS
                        // command; refresh_google_token below is the one
                        // apiClient.ts's getValidToken substring-matches on,
                        // but keep the `{:?}` Debug formatting here too so
                        // both commands behave consistently.
                        Err(e) => return Err(AppError::Auth(format!("Failed to exchange token: {:?}", e))),
                    }
                } else {
                    let _ = request.respond(tiny_http::Response::from_string("No code provided."));
                    return Err(AppError::Auth("Authorization failed: no code returned.".to_string()));
                }
            }
        }
        // NOTE: "timeout" substring is matched by LoginScreen.tsx -- keep it
        // in the message if you ever reword this.
        Err(AppError::Auth("Authorization timeout: user did not complete login within 5 minutes.".to_string()))
    }).await.map_err(|e| AppError::TaskPanicked(format!("Task panicked: {}", e)))?
}

#[command]
pub async fn refresh_google_token(refresh_token: String) -> Result<Value, AppError> {
    const CREDENTIALS_JSON: &str = include_str!("../../../wa_credential.json");
    let creds: serde_json::Value = serde_json::from_str(CREDENTIALS_JSON).map_err(|e| AppError::Auth(format!("Invalid wa_credential.json: {}", e)))?;
    let client_id = ClientId::new(creds["installed"]["client_id"].as_str().ok_or_else(|| AppError::Auth("Missing client_id in wa_credential.json".to_string()))?.to_string());
    let client_secret = ClientSecret::new(creds["installed"]["client_secret"].as_str().ok_or_else(|| AppError::Auth("Missing client_secret in wa_credential.json".to_string()))?.to_string());
    let token_url = TokenUrl::new("https://oauth2.googleapis.com/token".to_string()).unwrap();

    let client = BasicClient::new(client_id)
        .set_client_secret(client_secret)
        .set_auth_uri(AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".to_string()).unwrap())
        .set_token_uri(token_url);

    let async_http_client = build_async_http_client()?;
    // NOTE: apiClient.ts's getValidToken() substring-matches this exact
    // message for "invalid_grant" to detect a revoked/expired refresh token
    // and trigger logout (vs. treating it as a transient network error to
    // retry) -- see src-tauri/src/error.rs's module doc. The `{:?}` Debug
    // formatting of oauth2's RequestTokenError is what actually carries the
    // "invalid_grant" text through from Google's error response body; do
    // not switch this to `{}` (Display) or otherwise reword without
    // checking that call site.
    let token_result = client
        .exchange_refresh_token(&RefreshToken::new(refresh_token))
        .request_async(&async_http_client)
        .await
        .map_err(|e| AppError::Auth(format!("Failed to refresh token: {:?}", e)))?;

    let access_token = token_result.access_token().secret().to_string();
    let new_refresh_token = token_result.refresh_token().map(|t| t.secret().to_string());
    let expires_in = token_result.expires_in().map(|d| d.as_secs());

    Ok(serde_json::json!({
        "access_token": access_token,
        "refresh_token": new_refresh_token,
        "expires_in": expires_in
    }))
}
