//! Single source of truth for IPC-safe rendering of OAuth token-request
//! failures, shared by the desktop flow (auth.rs: login_google_native code
//! exchange + refresh_google_token) and the Android flow (auth_android.rs:
//! login_google_mobile code exchange). Extracted verbatim from the former
//! private copies in auth.rs and its local mirror in auth_android.rs so the
//! two flows can never drift apart again.
use crate::dpop::DpopError;
use oauth2::basic::BasicErrorResponseType;
use oauth2::{RequestTokenError, StandardErrorResponse};

/// Concrete failure type produced by token requests routed through
/// `dpop_http_client` (RE = DpopError) against the BasicClient Google
/// endpoint setup.
pub(crate) type TokenRequestError =
    RequestTokenError<DpopError, StandardErrorResponse<BasicErrorResponseType>>;

/// Renders an OAuth token-request failure (refresh-token flow OR login
/// code-exchange on either platform) as a short IPC-safe diagnostic string.
///
/// Both `exchange_refresh_token` (refresh_google_token) and
/// `exchange_code` (login_google_native / login_google_mobile) fail with the same
/// `RequestTokenError`, whose derive(Debug) embeds the raw HTTP response
/// body (`RequestTokenError::Parse(_, Vec<u8>)`) and DPoP/reqwest internals.
/// Those strings cross IPC into errStr (apiClient.ts / LoginScreen.tsx) and
/// are persisted in JS-side error logs. Each arm must emit structural facts
/// only, while preserving the exact substrings that JS string-matching
/// classifies on: `invalid_grant` (revoked/expired bucket in apiClient.ts),
/// `timeout`/`unreachable` (network bucket in apiClient.ts). The login
/// exchange call site prefixes this with "Failed to exchange token: " — no
/// consumer matches on "exchange", so the prefix is diagnostic-only.
pub(crate) fn format_token_request_error(e: &TokenRequestError) -> String {
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
pub(crate) fn format_exchange_error(e: &TokenRequestError) -> String {
    format!(
        "Failed to exchange token: {}",
        format_token_request_error(e)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::auth_android::{ANDROID_CLIENT_ID, MOBILE_REDIRECT_URI};
    use oauth2::basic::BasicClient;
    use oauth2::http::{header::HeaderMap, StatusCode};
    use oauth2::{
        AuthUrl, AuthorizationCode, ClientId, HttpRequest, HttpResponse, PkceCodeVerifier,
        RedirectUrl, RefreshToken, TokenUrl,
    };

    // ------------------------------------------------------------------
    // format_token_request_error / format_exchange_error: IPC-safe rendering
    // of token-request failures (refresh flow AND login code-exchange, both
    // platforms).
    //
    // Provenance: these tests were moved VERBATIM (assertions untouched)
    // from auth::tests (desktop pipeline; original names kept) and from
    // auth_android::tests (mobile pipeline; prefixed `mobile_` because Rust
    // forbids duplicate function names inside one merged test module).
    //
    // oauth2's `RequestTokenError::Parse(_, Vec<u8>)` carries the RAW HTTP
    // response body and derive(Debug) prints it, so the pre-fix
    // `format!("{:?}", e)` leaked untrusted bodies (captive portal HTML...)
    // across IPC into JS error logs. These tests drive oauth2's REAL parse
    // pipeline through canned HTTP responses so every variant is exercised
    // as the exact concrete type production sees (RE = DpopError because
    // dpop_http_client fails with DpopError).
    // ------------------------------------------------------------------

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

    /// Test scaffold mirroring auth.rs `build_token_client(true)` exactly:
    /// android public client id, no secret, standard Google URLs, NO
    /// redirect URI — so canned-response errors match the exact concrete
    /// production error type of the desktop flow.
    fn desktop_flow_client() -> BasicClient {
        BasicClient::new(
            ClientId::new(ANDROID_CLIENT_ID.to_string()),
            None,
            AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".to_string()).unwrap(),
            Some(TokenUrl::new("https://oauth2.googleapis.com/token".to_string()).unwrap()),
        )
    }

    /// Moved verbatim from auth_android::tests: client built exactly like
    /// `login_google_mobile` builds it (same URLs, same mobile redirect URI)
    /// so canned-response errors match the concrete production error type.
    fn mobile_test_client() -> BasicClient {
        BasicClient::new(
            ClientId::new(ANDROID_CLIENT_ID.to_string()),
            None,
            AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".to_string()).unwrap(),
            Some(
                TokenUrl::new("https://oauth2.googleapis.com/token".to_string())
                    .expect("hardcoded TokenUrl must parse"),
            ),
        )
        .set_redirect_uri(
            RedirectUrl::new(MOBILE_REDIRECT_URI.to_string())
                .expect("hardcoded redirect URI must parse"),
        )
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
                desktop_flow_client()
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
                    desktop_flow_client()
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
                    desktop_flow_client()
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
                    desktop_flow_client()
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

    // ------------------------------------------------------------------
    // Mobile-pipeline trio moved verbatim from auth_android::tests: they
    // drive the REAL mobile client shape (same redirect URI) through the
    // same sanitization helpers. Names carry the `mobile_` prefix only to
    // avoid colliding with the desktop-origin twins above; every assertion
    // is unchanged.
    // ------------------------------------------------------------------

    #[test]
    fn mobile_debug_format_of_parse_error_contains_raw_body() {
        // Documents the vulnerability this task fixes: oauth2's Debug on the
        // Parse variant embeds the entire raw response body. If a future
        // oauth2 upgrade stops doing that, the sanitization in
        // format_token_request_error becomes defense-in-depth rather than
        // required.
        let err = tokio::runtime::Runtime::new()
            .expect("tokio runtime")
            .block_on(async {
                mobile_test_client()
                    .exchange_code(AuthorizationCode::new("ac".to_string()))
                    .set_pkce_verifier(PkceCodeVerifier::new("pv".to_string()))
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
    fn mobile_exchange_parse_variant_hides_raw_body_and_keeps_field_path_only() {
        let formatted = format_exchange_error(
            &tokio::runtime::Runtime::new()
                .expect("tokio runtime")
                .block_on(async {
                    mobile_test_client()
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
    fn mobile_exchange_server_response_variant_keeps_invalid_grant_keyword_only() {
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
