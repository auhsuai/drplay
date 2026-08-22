use crate::auth_errors::{format_exchange_error, format_token_request_error};
use crate::dpop::dpop_http_client;
use oauth2::basic::BasicClient;
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge,
    RedirectUrl, Scope, TokenResponse, TokenUrl, RefreshToken,
};
use serde_json::Value;
use tauri::command;

#[command]
pub async fn login_google_native() -> Result<Value, String> {
    // The blocking loopback-server wait runs on a worker thread; it returns
    // the OAuth client + PKCE verifier + authorization code so the token
    // exchange itself can run in this async context (the DPoP http client
    // added for RFC 9449 is async).
    let (client, pkce_verifier, code) = tauri::async_runtime::spawn_blocking(|| {
        const CREDENTIALS_JSON: &str = include_str!("../../wa_credential.json");
        let creds: serde_json::Value = serde_json::from_str(CREDENTIALS_JSON).map_err(|e| format!("Invalid wa_credential.json: {}", e))?;
        let client_id = ClientId::new(creds["installed"]["client_id"].as_str().ok_or("Missing client_id in wa_credential.json")?.to_string());
        let client_secret = ClientSecret::new(creds["installed"]["client_secret"].as_str().ok_or("Missing client_secret in wa_credential.json")?.to_string());
        let auth_url = AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".to_string()).map_err(|e| format!("invalid AuthUrl: {e:?}"))?;
        let token_url = TokenUrl::new("https://oauth2.googleapis.com/token".to_string()).map_err(|e| format!("invalid TokenUrl: {e:?}"))?;

        // 1. Dynamic Port Binding
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("Failed to start server: {}", e))?;
        let port = server.server_addr().to_ip().ok_or("server address has no IP")?.port();
        let redirect_uri = format!("http://127.0.0.1:{}", port);

        let client = BasicClient::new(
            client_id,
            Some(client_secret),
            auth_url,
            Some(token_url),
        )
            .set_redirect_uri(RedirectUrl::new(redirect_uri.clone()).map_err(|e| format!("invalid RedirectUrl: {e:?}"))?);

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

        open::that(auth_url.as_str()).map_err(|e| format!("Failed to open browser: {}", e))?;

        // 2. Timeout (5 minutes)
        let timeout = std::time::Duration::from_secs(300);
        let start_time = std::time::Instant::now();

        while start_time.elapsed() < timeout {
            // Check for requests every 500ms
            if let Ok(Some(request)) = server.recv_timeout(std::time::Duration::from_millis(500)) {
                let url = format!("{}{}", redirect_uri, request.url());
                let parsed_url = url::Url::parse(&url).map_err(|e| format!("Invalid redirect URL: {}", e))?;

                let code = parsed_url.query_pairs().find(|(key, _)| key == "code");
                let state = parsed_url.query_pairs().find(|(key, _)| key == "state");
                let error = parsed_url.query_pairs().find(|(key, _)| key == "error");

                if error.is_some() {
                    let response = tiny_http::Response::from_string("<html><body><script>window.close();</script></body></html>")
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).map_err(|e| format!("invalid Content-Type header: {e:?}"))?);
                    let _ = request.respond(response);
                    return Err("User cancelled authorization".to_string());
                }

                if let (Some((_, code)), Some((_, state))) = (code, state) {
                    if state.into_owned() != *csrf_token.secret() {
                        let response = tiny_http::Response::from_string("CSRF Token Mismatch!");
                        let _ = request.respond(response);
                        return Err("CSRF Token Mismatch".to_string());
                    }

                    // 3. Auto-close HTML Response
                    let html_response = r#"
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="utf-8">
                            <title>Đăng nhập thành công</title>
                            <style>
                                body { font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #f8f9fa; color: #202124; }
                                .container { text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                                h1 { font-size: 24px; margin-bottom: 12px; }
                                p { color: #5f6368; }
                            </style>
                        </head>
                        <body>
                            <div class="container">
                                <h1>Đăng nhập thành công!</h1>
                                <p>Cửa sổ này sẽ tự động đóng lại trong giây lát.</p>
                                <p>Nếu không, bạn có thể tự đóng cửa sổ này.</p>
                            </div>
                            <script>
                                setTimeout(() => window.close(), 100);
                            </script>
                        </body>
                        </html>
                    "#;

                    let response = tiny_http::Response::from_string(html_response)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).map_err(|e| format!("invalid Content-Type header: {e:?}"))?);
                    let _ = request.respond(response);

                    // Hand the code + the PKCE verifier back to the async
                    // caller, which exchanges it with a DPoP proof.
                    return Ok((client, pkce_verifier, AuthorizationCode::new(code.into_owned())));
                } else {
                    let response = tiny_http::Response::from_string("No code provided.");
                    let _ = request.respond(response);
                    return Err("Authorization failed: no code returned.".to_string());
                }
            }
        }

        Err("Authorization timeout: user did not complete login within 5 minutes.".to_string())
    }).await.map_err(|e| format!("Task panicked: {}", e))??;

    let token_result = client
        .exchange_code(code)
        .set_pkce_verifier(pkce_verifier)
        .request_async(dpop_http_client)
        .await
        .map_err(|e| format_exchange_error(&e))?;

    Ok(serde_json::json!({
        "access_token": token_result.access_token().secret().to_string(),
        "refresh_token": token_result.refresh_token().map(|t| t.secret().to_string()),
        "expires_in": token_result.expires_in().map(|d| d.as_secs()),
    }))
}

/// Google OAuth client identity (client id + optional secret) for token
/// exchange. Desktop uses the installed-app client from wa_credential.json
/// (confidential — has a secret). Android uses the public mobile client
/// (RFC 8252 §8.4 — NO secret) that actually minted the login refresh token:
/// refreshing with a different client than the one that issued the token
/// fails with `invalid_grant` (the ~50-minute Android playback death bug).
struct TokenClientConfig {
    client_id: String,
    client_secret: Option<String>,
}

/// Pure client-selection: returns the OAuth identity for the platform the
/// refresh token was minted on. `use_android_client` is a plain parameter so
/// both branches are unit-testable on the host; the caller passes
/// `cfg!(target_os = "android")`.
fn token_client_config(use_android_client: bool) -> Result<TokenClientConfig, String> {
    if use_android_client {
        Ok(TokenClientConfig {
            client_id: crate::auth_android::ANDROID_CLIENT_ID.to_string(),
            client_secret: None,
        })
    } else {
        const CREDENTIALS_JSON: &str = include_str!("../../wa_credential.json");
        let creds: serde_json::Value = serde_json::from_str(CREDENTIALS_JSON)
            .map_err(|e| format!("Invalid wa_credential.json: {}", e))?;
        Ok(TokenClientConfig {
            client_id: creds["installed"]["client_id"]
                .as_str()
                .ok_or("Missing client_id in wa_credential.json")?
                .to_string(),
            client_secret: Some(
                creds["installed"]["client_secret"]
                    .as_str()
                    .ok_or("Missing client_secret in wa_credential.json")?
                    .to_string(),
            ),
        })
    }
}

/// Builds the OAuth client (same AuthUrl/TokenUrl on both platforms) from the
/// platform-appropriate identity. See `token_client_config` for the platform
/// rationale.
fn build_token_client(use_android_client: bool) -> Result<BasicClient, String> {
    let config = token_client_config(use_android_client)?;
    Ok(BasicClient::new(
        ClientId::new(config.client_id),
        config.client_secret.map(ClientSecret::new),
        AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".to_string()).unwrap(),
        Some(TokenUrl::new("https://oauth2.googleapis.com/token".to_string()).unwrap()),
    ))
}

#[command]
pub async fn refresh_google_token(refresh_token: String) -> Result<Value, String> {
    let client = build_token_client(cfg!(target_os = "android"))?;

    let token_result = client
        .exchange_refresh_token(&RefreshToken::new(refresh_token))
        .request_async(dpop_http_client)
        .await
        .map_err(|e| format_token_request_error(&e))?;

    let access_token = token_result.access_token().secret().to_string();
    let new_refresh_token = token_result.refresh_token().map(|t| t.secret().to_string());
    let expires_in = token_result.expires_in().map(|d| d.as_secs());

    Ok(serde_json::json!({
        "access_token": access_token,
        "refresh_token": new_refresh_token,
        "expires_in": expires_in
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CREDENTIALS_JSON: &str = include_str!("../../wa_credential.json");

    fn wa_client_id() -> String {
        let creds: serde_json::Value =
            serde_json::from_str(CREDENTIALS_JSON).expect("wa_credential.json must be valid");
        creds["installed"]["client_id"]
            .as_str()
            .expect("client_id present")
            .to_string()
    }

    fn wa_client_secret() -> String {
        let creds: serde_json::Value =
            serde_json::from_str(CREDENTIALS_JSON).expect("wa_credential.json must be valid");
        creds["installed"]["client_secret"]
            .as_str()
            .expect("client_secret present")
            .to_string()
    }

    #[test]
    fn android_branch_uses_android_client_without_secret() {
        let config = token_client_config(true).expect("android branch must build");
        assert_eq!(config.client_id, crate::auth_android::ANDROID_CLIENT_ID);
        assert!(
            config.client_secret.is_none(),
            "android public client must not carry a secret (RFC 8252)"
        );
    }

    #[test]
    fn desktop_branch_uses_wa_credential_with_secret() {
        let config = token_client_config(false).expect("desktop branch must build");
        assert_eq!(config.client_id, wa_client_id());
        assert_eq!(config.client_secret.as_deref(), Some(wa_client_secret().as_str()));
    }

    #[test]
    fn built_client_carries_selected_client_id() {
        let android = build_token_client(true).expect("android client must build");
        assert_eq!(android.client_id().as_str(), crate::auth_android::ANDROID_CLIENT_ID);

        let desktop = build_token_client(false).expect("desktop client must build");
        assert_eq!(desktop.client_id().as_str(), wa_client_id());
    }
}
