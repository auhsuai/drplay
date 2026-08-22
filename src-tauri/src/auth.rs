use crate::dpop::{dpop_http_client, DpopError};
use oauth2::basic::{BasicClient, BasicErrorResponseType};
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge,
    RedirectUrl, RequestTokenError, Scope, StandardErrorResponse, TokenResponse, TokenUrl,
    RefreshToken,
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

/// Concrete failure type produced by token requests routed through
/// `dpop_http_client` (RE = DpopError) against the BasicClient Google
/// endpoint setup.
type TokenRequestError =
    RequestTokenError<DpopError, StandardErrorResponse<BasicErrorResponseType>>;

/// Renders an OAuth token-request failure (refresh-token flow OR login
/// code-exchange) as a short IPC-safe diagnostic string.
///
/// Both `exchange_refresh_token` (refresh_google_token) and
/// `exchange_code` (login_google_native) fail with the same
/// `RequestTokenError`, whose derive(Debug) embeds the raw HTTP response
/// body (`RequestTokenError::Parse(_, Vec<u8>)`) and DPoP/reqwest internals.
/// Those strings cross IPC into errStr (apiClient.ts / LoginScreen.tsx) and
/// are persisted in JS-side error logs. Each arm must emit structural facts
/// only, while preserving the exact substrings that JS string-matching
/// classifies on: `invalid_grant` (revoked/expired bucket in apiClient.ts),
/// `timeout`/`unreachable` (network bucket in apiClient.ts). The login
/// exchange call site prefixes this with "Failed to exchange token: " — no
/// consumer matches on "exchange", so the prefix is diagnostic-only.
fn format_token_request_error(e: &TokenRequestError) -> String {
    match e {
        RequestTokenError::ServerResponse(resp) => {
            // RFC 6749 §5.2 machine-readable code; Display renders the
            // snake_case wire form (e.g. "invalid_grant") — the keyword the
            // JS classifier matches for revoked/expired refresh tokens. The
            // server-provided error_description is deliberately NOT emitted.
            format!("server_error:{}", resp.error())
        }
        RequestTokenError::Parse(path_err, _) => {
            // serde_path_to_error reports WHERE parsing failed (field names
            // only, "." at root). The raw body Vec<u8> is deliberately
            // dropped: it is untrusted-controlled and leaked via {:?} before.
            format!("parse_error:{}", path_err.path())
        }
        RequestTokenError::Request(dpop_err) => match dpop_err {
            // Transport facts only. "timeout"/"unreachable" are the exact
            // substrings apiClient.ts matches to classify network failures.
            DpopError::Http(reqwest_err) => {
                if reqwest_err.is_timeout() {
                    "request_error:timeout".to_string()
                } else if reqwest_err.is_connect() {
                    "request_error:unreachable".to_string()
                } else {
                    "request_error:http".to_string()
                }
            }
            DpopError::Vault(_) => "other:dpop_vault".to_string(),
            DpopError::Crypto(_) => "other:dpop_crypto".to_string(),
            DpopError::Proof(_) => "other:dpop_proof".to_string(),
            DpopError::HttpConversion(_) => "other:dpop_http_conversion".to_string(),
        },
        RequestTokenError::Other(_) => "other".to_string(),
    }
}

/// Exchange-flow wrapper: keeps the pre-existing "Failed to exchange
/// token:" context prefix around the sanitized diagnostics (no consumer
/// string-matches the prefix; it is diagnostic-only).
fn format_exchange_error(e: &TokenRequestError) -> String {
    format!(
        "Failed to exchange token: {}",
        format_token_request_error(e)
    )
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

    // ------------------------------------------------------------------
    // format_token_request_error: IPC-safe rendering of token-request
    // failures (refresh flow AND login code-exchange).
    //
    // oauth2's `RequestTokenError::Parse(_, Vec<u8>)` carries the RAW HTTP
    // response body and derive(Debug) prints it, so the pre-fix
    // `format!("{:?}", e)` leaked untrusted bodies (captive portal HTML...)
    // across IPC into JS error logs. These tests drive oauth2's REAL parse
    // pipeline through canned HTTP responses so every variant is exercised
    // as the exact concrete type production sees (RE = DpopError because
    // dpop_http_client fails with DpopError).
    // ------------------------------------------------------------------

    use oauth2::http::{header::HeaderMap, StatusCode};
    use oauth2::{HttpRequest, HttpResponse, PkceCodeVerifier};

    async fn portal_html_client(_request: HttpRequest) -> Result<HttpResponse, DpopError> {
        Ok(HttpResponse {
            status_code: StatusCode::OK,
            headers: HeaderMap::new(),
            body: b"<html>captive-portal</html>".to_vec(),
        })
    }

    async fn invalid_grant_client(_request: HttpRequest) -> Result<HttpResponse, DpopError> {
        Ok(HttpResponse {
            status_code: StatusCode::BAD_REQUEST,
            headers: HeaderMap::new(),
            body: br#"{"error":"invalid_grant","error_description":"TOPSECRETDESC"}"#.to_vec(),
        })
    }

    /// Produces a REAL `RequestTokenError` by running the same
    /// exchange_refresh_token -> request_async pipeline as production, with
    /// `portal_html_client` standing in for dpop_http_client.
    #[test]
    fn debug_format_of_parse_error_contains_raw_body() {
        // Documents the vulnerability this task fixes: oauth2's Debug on the
        // Parse variant embeds the entire raw response body. If a future
        // oauth2 upgrade stops doing that, the sanitization in
        // format_token_request_error becomes defense-in-depth rather than
        // required.
        let err = tokio::runtime::Runtime::new()
            .expect("tokio runtime")
            .block_on(async {
                build_token_client(true)
                    .expect("client must build")
                    .exchange_refresh_token(&RefreshToken::new("rt".to_string()))
                    .request_async(portal_html_client)
                    .await
                    .expect_err("portal HTML must fail to parse")
            });
        assert!(
            matches!(err, RequestTokenError::Parse(_, _)),
            "portal HTML with status 200 must surface as Parse, got {err:?}"
        );
        let leaked = format!("{:?}", err);
        // Vec<u8> Debug-prints as a decimal byte array, not plaintext — the
        // FULL raw body still crosses IPC verbatim.
        let byte_dump = b"<html>captive-portal</html>"
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        assert!(
            leaked.contains(&byte_dump),
            "derive(Debug) is expected to embed every raw body byte: {leaked}"
        );
    }

    #[test]
    fn parse_variant_hides_raw_body_and_keeps_field_path_only() {
        let formatted = format_token_request_error(
            &tokio::runtime::Runtime::new()
                .expect("tokio runtime")
                .block_on(async {
                    build_token_client(true)
                        .expect("client must build")
                        .exchange_refresh_token(&RefreshToken::new("rt".to_string()))
                        .request_async(portal_html_client)
                        .await
                        .expect_err("portal HTML must fail to parse")
                }),
        );
        assert!(!formatted.contains("<html>"), "leaked body: {formatted}");
        assert!(!formatted.contains("captive-portal"), "leaked body: {formatted}");
        assert!(formatted.starts_with("parse_error:"), "got: {formatted}");
        assert!(formatted.len() < 80, "must stay a short fixed string: {formatted}");
    }

    #[test]
    fn server_response_variant_maps_to_code_only() {
        let err = RequestTokenError::<DpopError, _>::ServerResponse(
            StandardErrorResponse::new(
                BasicErrorResponseType::InvalidGrant,
                Some("secret-description".to_string()),
                None,
            ),
        );
        let formatted = format_token_request_error(&err);
        // Keyword contract: apiClient.ts buckets "invalid_grant" as
        // revoked/expired; the human-readable description must NOT cross IPC.
        assert_eq!(formatted, "server_error:invalid_grant");
    }

    #[test]
    fn server_response_pipeline_variant_keeps_invalid_grant_keyword() {
        let formatted = format_token_request_error(
            &tokio::runtime::Runtime::new()
                .expect("tokio runtime")
                .block_on(async {
                    build_token_client(true)
                        .expect("client must build")
                        .exchange_refresh_token(&RefreshToken::new("rt".to_string()))
                        .request_async(invalid_grant_client)
                        .await
                        .expect_err("invalid_grant must be an error")
                }),
        );
        assert!(formatted.starts_with("server_error:"), "got: {formatted}");
        assert!(formatted.contains("invalid_grant"), "got: {formatted}");
        assert!(
            !formatted.contains("TOPSECRETDESC"),
            "description value leaked: {formatted}"
        );
    }

    #[test]
    fn request_variant_connect_refused_maps_to_unreachable_keyword() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);

        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        let http_err = runtime
            .block_on(async {
                reqwest::Client::new()
                    .post(format!("http://127.0.0.1:{port}/token"))
                    .body(b"grant_type=refresh_token".to_vec())
                    .send()
                    .await
            })
            .expect_err("connect to a closed port must fail");
        assert!(
            http_err.is_connect(),
            "expected connect-kind reqwest error, got {http_err:?}"
        );

        let err: TokenRequestError = RequestTokenError::Request(DpopError::Http(http_err));
        // apiClient.ts buckets "unreachable" into its network branch.
        assert_eq!(format_token_request_error(&err), "request_error:unreachable");
    }

    #[test]
    fn request_variant_timeout_maps_to_timeout_keyword() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            if let Ok((_stream, _)) = listener.accept() {
                // Accept but never respond; the client's own timeout fires.
                std::thread::sleep(std::time::Duration::from_secs(5));
            }
        });

        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        let http_err = runtime
            .block_on(async {
                reqwest::Client::builder()
                    .timeout(std::time::Duration::from_millis(500))
                    .build()
                    .expect("client builds")
                    .post(format!("http://127.0.0.1:{port}/token"))
                    .send()
                    .await
            })
            .expect_err("held connection must time out");
        assert!(
            http_err.is_timeout(),
            "expected timeout-kind reqwest error, got {http_err:?}"
        );

        let err: TokenRequestError = RequestTokenError::Request(DpopError::Http(http_err));
        // apiClient.ts buckets "timeout" into its network branch.
        assert_eq!(format_token_request_error(&err), "request_error:timeout");
    }

    #[test]
    fn request_variant_non_network_dpop_errors_emit_fixed_labels_without_details() {
        let cases: [(DpopError, &str); 4] = [
            (DpopError::Vault("vault-detail-X".to_string()), "other:dpop_vault"),
            (DpopError::Crypto("crypto-detail-X".to_string()), "other:dpop_crypto"),
            (DpopError::Proof("proof-detail-X".to_string()), "other:dpop_proof"),
            (
                DpopError::HttpConversion("conv-detail-X".to_string()),
                "other:dpop_http_conversion",
            ),
        ];
        for (dpop_err, expected) in cases {
            let err: TokenRequestError = RequestTokenError::Request(dpop_err);
            assert_eq!(format_token_request_error(&err), expected);
        }
    }

    #[test]
    fn other_variant_emits_bare_other_marker() {
        let err: TokenRequestError =
            RequestTokenError::Other("oauth2-internal message".to_string());
        assert_eq!(format_token_request_error(&err), "other");
    }

    // ------------------------------------------------------------------
    // Exchange flow (login_google_native): the SAME RequestTokenError type
    // crosses IPC from the login command. The pre-fix
    // `format!("Failed to exchange token: {:?}", e)` leaked the raw body /
    // internals exactly like the refresh path did. LoginScreen.tsx buckets
    // errors by substring ("cancel", /timeout|timed out/) — none of those
    // keywords may appear spuriously, and no consumer matches "exchange".
    // ------------------------------------------------------------------

    #[test]
    fn exchange_parse_variant_hides_raw_body_and_keeps_field_path_only() {
        let formatted = format_exchange_error(
            &tokio::runtime::Runtime::new()
                .expect("tokio runtime")
                .block_on(async {
                    build_token_client(true)
                        .expect("client must build")
                        .exchange_code(AuthorizationCode::new("ac".to_string()))
                        .set_pkce_verifier(PkceCodeVerifier::new("pv".to_string()))
                        .request_async(portal_html_client)
                        .await
                        .expect_err("portal HTML must fail to parse")
                }),
        );
        assert!(
            formatted.starts_with("Failed to exchange token: parse_error:"),
            "got: {formatted}"
        );
        assert!(!formatted.contains("<html>"), "leaked body: {formatted}");
        assert!(
            !formatted.contains("captive-portal"),
            "leaked body: {formatted}"
        );
        assert!(
            formatted.len() < 100,
            "must stay a short fixed string: {formatted}"
        );
        // A parse failure must never be misread as user cancellation by the
        // LoginScreen `includes("cancel")` bucket.
        assert!(!formatted.contains("cancel"), "got: {formatted}");
    }

    #[test]
    fn exchange_server_response_variant_keeps_invalid_grant_keyword_only() {
        let err = RequestTokenError::<DpopError, _>::ServerResponse(
            StandardErrorResponse::new(
                BasicErrorResponseType::InvalidGrant,
                Some("secret-description".to_string()),
                None,
            ),
        );
        let formatted = format_exchange_error(&err);
        assert!(
            formatted.starts_with("Failed to exchange token:"),
            "got: {formatted}"
        );
        assert!(
            formatted.contains("server_error:invalid_grant"),
            "got: {formatted}"
        );
        assert!(
            !formatted.contains("secret-description"),
            "leaked description value: {formatted}"
        );
    }
}
