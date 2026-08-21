// DPoP (RFC 9449) sender-constrained OAuth 2.0 tokens for Google's token
// endpoint.
//
// WHY: this app is a public client (installed app) that stores a long-lived
// Google refresh token granting offline Drive access. A leaked bearer refresh
// token could be replayed by anyone forever. DPoP binds the refresh token to
// an asymmetric key pair generated on the device: every token request carries
// a short-lived JWT proof signed with the private key, so a stolen token is
// useless without the key. Google's OAuth best practices explicitly recommend
// DPoP for public clients accessing sensitive data such as Drive
// (https://developers.google.com/identity/protocols/oauth2/resources/best-practices).
//
// How the pieces fit together:
// - `get_or_create_dpop_key` keeps ONE persistent P-256 key (PKCS#8 DER in the
//   OS credential vault via token_store). The refresh token is bound to this
//   key by Google, so swapping keys would break refresh (`invalid_dpop_proof`).
// - `build_dpop_proof` constructs the ES256 proof JWT (`typ: dpop+jwt` header
//   with the public JWK, payload with jti/htm/htu/iat and the optional nonce).
//   Per Google's DPoP adoption guide, the jti for an authorization-code
//   exchange MUST be the base64url SHA-256 hash of the authorization code,
//   while refresh-token exchanges use a fresh random jti per request.
// - `dpop_http_client` is the oauth2 HTTP client hook (oauth2 4.4.2
//   `request_async` takes any `FnOnce(HttpRequest) -> Future<...>`): it adds
//   the DPoP header to the token request and implements the mandatory
//   DPoP-Nonce challenge/retry loop — a 400 `use_dpop_nonce` / 
//   `invalid_dpop_proof` response is retried exactly once with the fresh nonce
//   from the `DPoP-Nonce` response header. The nonce is cached in a process
//   static and sent on every subsequent request, as Google requires.

use std::sync::{Mutex, OnceLock};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use oauth2::http::StatusCode;
use oauth2::http::header::{HeaderMap, HeaderName, HeaderValue};
use oauth2::{HttpRequest, HttpResponse};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::Generate;
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use sha2::{Digest as _, Sha256};

/// Google's token endpoint (the only URL the oauth2 client sends token
/// requests to). Kept as the reference htu so proof payloads always match.
/// Only referenced from unit tests below.
#[cfg(test)]
const TOKEN_ENDPOINT_HTU: &str = "https://oauth2.googleapis.com/token";

/// Maximum number of retries when Google challenges a stale/invalid DPoP
/// nonce with a 400 `use_dpop_nonce` response. Exactly one retry with the
/// fresh nonce from the challenge response is enough; a second challenge
/// means something is genuinely wrong (e.g. the token is bound to a different
/// key), so we surface the error to the caller instead of looping forever.
const MAX_NONCE_RETRIES: usize = 1;

/// Timeout for a single token-endpoint request (the oauth2 default client has
/// none; a hang here would stall login/refresh indefinitely).
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Error type surfaced by the DPoP HTTP client. Implements `std::error::Error`
/// so it satisfies oauth2's `request_async` bound (`RE: Error + 'static`).
/// No variant ever carries a key, token or nonce value.
#[derive(Debug)]
pub enum DpopError {
    /// OS credential vault read/write failed (key storage).
    Vault(String),
    /// Key generation, PKCS#8 or signing failure.
    Crypto(String),
    /// Proof JWT construction failure (serialization / encoding).
    Proof(String),
    /// Underlying reqwest transport failure.
    Http(reqwest::Error),
    /// Conversion between oauth2's http 0.2 types and reqwest's http 1.x types
    /// failed (cannot happen for values produced by reqwest, but the bridging
    /// conversions are fallible).
    HttpConversion(String),
}

impl std::fmt::Display for DpopError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DpopError::Vault(m) => write!(f, "DPoP credential-vault error: {m}"),
            DpopError::Crypto(m) => write!(f, "DPoP crypto error: {m}"),
            DpopError::Proof(m) => write!(f, "DPoP proof error: {m}"),
            DpopError::Http(e) => write!(f, "DPoP HTTP error: {e}"),
            DpopError::HttpConversion(m) => write!(f, "DPoP HTTP conversion error: {m}"),
        }
    }
}

impl std::error::Error for DpopError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            DpopError::Http(e) => Some(e),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/// Return the persistent DPoP signing key, generating and storing it on first
/// use. The key MUST stay stable across requests: Google binds the refresh
/// token to it, and any key change makes existing tokens unusable
/// (`invalid_dpop_proof`). A corrupt stored key is regenerated with a warning
/// (the bound refresh token will then need a re-login anyway).
pub fn get_or_create_dpop_key() -> Result<SigningKey, DpopError> {
    if let Some(der) = crate::token_store::get_dpop_key().map_err(DpopError::Vault)? {
        match SigningKey::from_pkcs8_der(&der) {
            Ok(key) => return Ok(key),
            Err(e) => {
                eprintln!("[drplay:dpop] stored DPoP key is corrupt ({e}) — generating a fresh one");
            }
        }
    }

    let key = SigningKey::generate();
    let der = key
        .to_pkcs8_der()
        .map_err(|e| DpopError::Crypto(format!("failed to serialize DPoP key: {e}")))?;
    crate::token_store::set_dpop_key(der.as_bytes()).map_err(DpopError::Vault)?;
    Ok(key)
}

/// Delete the persisted DPoP key. Called on logout (via
/// `token_store::delete_refresh_token`) so the next login starts with a fresh
/// key pair; the old key is orphaned once the refresh token it protected is
/// gone. Production logout clears the key via `token_store::delete_dpop_key`
/// directly; this wrapper is exercised from the unit tests below.
#[cfg(test)]
pub fn delete_dpop_key() -> Result<(), String> {
    crate::token_store::delete_dpop_key()
}

// ---------------------------------------------------------------------------
// Proof JWT construction
// ---------------------------------------------------------------------------

/// Derive the proof `jti` from the token request body. Google requires:
/// - authorization-code exchange -> base64url(SHA-256(authorization_code))
/// - refresh-token exchange      -> a unique random value (UUID v4 here)
///
/// Any other grant falls back to a fresh UUID.
fn jti_for_request(body: &[u8]) -> String {
    let params: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(body).into_owned().collect();
    if params.get("grant_type").map(String::as_str) == Some("authorization_code") {
        if let Some(code) = params.get("code") {
            let mut hasher = Sha256::new();
            hasher.update(code.as_bytes());
            return b64(hasher.finalize());
        }
    }
    uuid::Uuid::new_v4().to_string()
}

/// Base64url (no padding) encoding used throughout DPoP/JWS.
fn b64(data: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

/// Current unix timestamp in whole seconds.
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The public key as a JWK (kty EC, crv P-256, x/y base64url) embedded in the
/// proof header. The 65-byte uncompressed SEC1 point is `0x04 || x || y`.
fn public_key_jwk(key: &SigningKey) -> serde_json::Value {
    let sec1 = key.verifying_key().to_sec1_point(false);
    let bytes: &[u8] = sec1.as_ref();
    serde_json::json!({
        "kty": "EC",
        "crv": "P-256",
        "x": b64(&bytes[1..33]),
        "y": b64(&bytes[33..65]),
    })
}

/// Build a fresh ES256 DPoP proof JWT for one token request. Every call MUST
/// produce a new proof (new jti/iat); the caller chooses the jti via
/// `jti_for_request`.
pub fn build_dpop_proof(
    key: &SigningKey,
    method: &str,
    htu: &str,
    nonce: Option<&str>,
    jti: &str,
) -> Result<String, DpopError> {
    let header = serde_json::json!({
        "typ": "dpop+jwt",
        "alg": "ES256",
        "jwk": public_key_jwk(key),
    });
    let mut payload = serde_json::json!({
        "jti": jti,
        "htm": method,
        "htu": htu,
        "iat": now_unix(),
    });
    if let Some(nonce) = nonce {
        payload["nonce"] = serde_json::Value::String(nonce.to_string());
    }

    let header_b64 = b64(serde_json::to_vec(&header).map_err(|e| {
        DpopError::Proof(format!("failed to serialize proof header: {e}"))
    })?);
    let payload_b64 = b64(serde_json::to_vec(&payload).map_err(|e| {
        DpopError::Proof(format!("failed to serialize proof payload: {e}"))
    })?);
    let signing_input = format!("{header_b64}.{payload_b64}");

    // ES256 = ECDSA over P-256 with SHA-256; the JWS signature is the raw
    // r || s concatenation (64 bytes), NOT the ASN.1 DER form.
    let signature: Signature = key.sign(signing_input.as_bytes());
    Ok(format!("{signing_input}.{}", b64(signature.to_bytes())))
}

// ---------------------------------------------------------------------------
// DPoP-Nonce handling
// ---------------------------------------------------------------------------

/// Process-global cache of the latest DPoP-Nonce issued by Google. The nonce
/// is single-use and must be included in every subsequent token request;
/// Google also enforces workflow isolation (an auth-code-exchange nonce is
/// rejected on the first refresh request), which the retry loop below absorbs.
static DPOP_NONCE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn nonce_cache() -> &'static Mutex<Option<String>> {
    DPOP_NONCE.get_or_init(|| Mutex::new(None))
}

fn set_nonce(value: Option<String>) {
    let mut guard = nonce_cache().lock().unwrap_or_else(|p| p.into_inner());
    *guard = value;
}

fn get_nonce() -> Option<String> {
    nonce_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

/// If `response` is a DPoP nonce challenge (HTTP 400 whose JSON body names
/// `use_dpop_nonce` or `invalid_dpop_proof`), return the fresh `DPoP-Nonce`
/// response header value to retry with. Returns None when the response is not
/// a challenge, or when a challenge arrives without a new nonce (then the
/// caller forwards the 400 to oauth2, which surfaces the Google error).
fn nonce_challenge_new_nonce(response: &HttpResponse) -> Option<String> {
    if response.status_code != StatusCode::BAD_REQUEST {
        return None;
    }
    let body = String::from_utf8_lossy(&response.body);
    if !(body.contains("use_dpop_nonce") || body.contains("invalid_dpop_proof")) {
        return None;
    }
    let new_nonce = response
        .headers
        .get("dpop-nonce")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if new_nonce.is_none() {
        eprintln!(
            "[drplay:dpop] received a 400 DPoP nonce challenge without a DPoP-Nonce header — returning the error to the caller"
        );
    }
    new_nonce
}

// ---------------------------------------------------------------------------
// oauth2 HTTP client
// ---------------------------------------------------------------------------

/// Send one token request with the given DPoP proof over reqwest (async),
/// mirroring oauth2's own `async_http_client` (no redirects, same
/// HttpRequest/HttpResponse shape).
async fn send_with_proof(
    request: &HttpRequest,
    proof: &str,
) -> Result<HttpResponse, DpopError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(DpopError::Http)?;

    let method = reqwest::Method::from_bytes(request.method.as_str().as_bytes())
        .map_err(|e| DpopError::HttpConversion(format!("invalid HTTP method: {e}")))?;
    let mut request_builder = client
        .request(method, request.url.clone())
        .body(request.body.clone());
    for (name, value) in &request.headers {
        request_builder = request_builder.header(name.as_str(), value.as_bytes());
    }
    let response = request_builder
        .header("DPoP", proof)
        .send()
        .await
        .map_err(DpopError::Http)?;

    let status_code = StatusCode::from_u16(response.status().as_u16())
        .map_err(|e| DpopError::HttpConversion(format!("invalid status code: {e}")))?;
    let mut headers = HeaderMap::new();
    for (name, value) in response.headers() {
        let name = HeaderName::from_bytes(name.as_str().as_bytes())
            .map_err(|e| DpopError::HttpConversion(format!("invalid header name: {e}")))?;
        let value = HeaderValue::from_bytes(value.as_bytes())
            .map_err(|e| DpopError::HttpConversion(format!("invalid header value: {e}")))?;
        headers.append(name, value);
    }
    let body = response.bytes().await.map_err(DpopError::Http)?.to_vec();
    Ok(HttpResponse {
        status_code,
        headers,
        body,
    })
}

/// oauth2 async HTTP client that adds DPoP proof-of-possession to every token
/// request and implements the DPoP-Nonce challenge/retry loop.
///
/// Pass this function wherever the OAuth flows currently pass
/// `oauth2::reqwest::async_http_client` (code exchange and refresh). It builds
/// a fresh proof per request (unique jti), attaches it as the `DPoP` header,
/// and on a 400 `use_dpop_nonce`/`invalid_dpop_proof` challenge retries exactly
/// once with the nonce from the response. The final response's `DPoP-Nonce`
/// header is cached for the next request.
pub async fn dpop_http_client(request: HttpRequest) -> Result<HttpResponse, DpopError> {
    let key = get_or_create_dpop_key()?;
    let jti = jti_for_request(&request.body);
    let method = request.method.as_str();
    let htu = request.url.to_string();

    let current_nonce = get_nonce();
    let proof = build_dpop_proof(&key, method, &htu, current_nonce.as_deref(), &jti)?;

    let mut response = send_with_proof(&request, &proof).await?;

    let mut retries = 0;
    while let Some(new_nonce) = nonce_challenge_new_nonce(&response) {
        if retries >= MAX_NONCE_RETRIES {
            break;
        }
        retries += 1;
        eprintln!(
            "[drplay:dpop] token request rejected with a DPoP nonce challenge — retrying once with the fresh DPoP-Nonce"
        );
        set_nonce(Some(new_nonce.clone()));
        let retry_proof = build_dpop_proof(&key, method, &htu, Some(&new_nonce), &jti)?;
        response = send_with_proof(&request, &retry_proof).await?;
    }

    // Google issues a fresh nonce on every token response; cache it so the
    // next request includes it (RFC 9449 §7.2).
    if let Some(nonce) = response
        .headers
        .get("dpop-nonce")
        .and_then(|v| v.to_str().ok())
    {
        set_nonce(Some(nonce.to_string()));
    }

    Ok(response)
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;
    use oauth2::http::header::HeaderMap;
    use oauth2::http::Method;
    use p256::ecdsa::VerifyingKey;

    /// Point the keyring default store at the in-memory mock store so key
    /// persistence can be exercised without touching the OS vault (same
    /// pattern as token_store tests).
    fn use_mock_store() {
        let _ = keyring::Entry::store_status();
        let store = keyring_core::mock::Store::new().expect("mock store creation");
        keyring_core::set_default_store(store);
    }

    /// The mock keyring store (and the DPoP nonce cache) are process globals,
    /// so any test touching them must run alone.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Split a proof JWT and decode its header/payload segments.
    fn decode_segments(proof: &str) -> (serde_json::Value, serde_json::Value) {
        let parts: Vec<&str> = proof.split('.').collect();
        assert_eq!(parts.len(), 3, "proof must have header.payload.signature");
        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        let payload: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        (header, payload)
    }

    #[test]
    fn proof_header_carries_expected_claims() {
        let key = SigningKey::generate();
        let proof = build_dpop_proof(&key, "POST", TOKEN_ENDPOINT_HTU, None, "jti-1").unwrap();
        let (header, payload) = decode_segments(&proof);
        assert_eq!(header["typ"], "dpop+jwt");
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["jwk"]["kty"], "EC");
        assert_eq!(header["jwk"]["crv"], "P-256");
        assert!(header["jwk"]["x"].as_str().unwrap().len() > 0);
        assert!(header["jwk"]["y"].as_str().unwrap().len() > 0);
        assert_eq!(payload["jti"], "jti-1");
        assert_eq!(payload["htm"], "POST");
        assert_eq!(payload["htu"], TOKEN_ENDPOINT_HTU);
        assert!(payload["iat"].as_u64().unwrap() > 0);
        assert!(payload.get("nonce").is_none(), "no nonce when none given");
    }

    #[test]
    fn proof_includes_nonce_when_provided() {
        let key = SigningKey::generate();
        let proof =
            build_dpop_proof(&key, "POST", TOKEN_ENDPOINT_HTU, Some("nonce-123"), "jti-2").unwrap();
        let (_, payload) = decode_segments(&proof);
        assert_eq!(payload["nonce"], "nonce-123");
    }

    #[test]
    fn proof_signature_verifies_with_embedded_public_key() {
        use p256::ecdsa::signature::Verifier;

        let key = SigningKey::generate();
        let proof = build_dpop_proof(&key, "POST", TOKEN_ENDPOINT_HTU, None, "jti-3").unwrap();
        let parts: Vec<&str> = proof.split('.').collect();
        let (header, _) = decode_segments(&proof);

        // Reconstruct the 65-byte SEC1 point from the JWK x/y coordinates and
        // verify the signature over header.payload.
        let mut sec1 = vec![0x04u8];
        sec1.extend_from_slice(
            &URL_SAFE_NO_PAD
                .decode(header["jwk"]["x"].as_str().unwrap())
                .unwrap(),
        );
        sec1.extend_from_slice(
            &URL_SAFE_NO_PAD
                .decode(header["jwk"]["y"].as_str().unwrap())
                .unwrap(),
        );
        let verifying_key = VerifyingKey::from_sec1_bytes(&sec1).unwrap();
        assert_eq!(
            verifying_key.to_sec1_point(false).as_ref(),
            key.verifying_key().to_sec1_point(false).as_ref(),
            "JWK must describe the same key that signed the proof"
        );

        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap();
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        verifying_key
            .verify(signing_input.as_bytes(), &signature)
            .expect("signature must be valid ES256 over header.payload");
    }

    #[test]
    fn code_exchange_jti_is_sha256_of_the_code() {
        let body = b"grant_type=authorization_code&code=ABC-123&client_id=xyz";
        let mut hasher = Sha256::new();
        hasher.update(b"ABC-123");
        assert_eq!(jti_for_request(body), b64(hasher.finalize()));
    }

    #[test]
    fn refresh_jti_is_random_and_unique() {
        let body = b"grant_type=refresh_token&refresh_token=rt";
        let first = jti_for_request(body);
        let second = jti_for_request(body);
        assert_ne!(first, second, "each proof needs a unique jti");
        assert!(first.len() >= 16, "jti must carry at least 128 bits");
    }

    #[test]
    fn consecutive_proofs_differ() {
        let key = SigningKey::generate();
        let body = b"grant_type=refresh_token&refresh_token=x";
        let proof_a =
            build_dpop_proof(&key, "POST", TOKEN_ENDPOINT_HTU, None, &jti_for_request(body))
                .unwrap();
        let proof_b =
            build_dpop_proof(&key, "POST", TOKEN_ENDPOINT_HTU, None, &jti_for_request(body))
                .unwrap();
        assert_ne!(proof_a, proof_b, "two requests must never reuse a proof");
    }

    #[test]
    fn get_or_create_key_is_persistent_across_calls() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        use_mock_store();
        let first = get_or_create_dpop_key().unwrap();
        let second = get_or_create_dpop_key().unwrap();
        assert_eq!(
            first.to_bytes(),
            second.to_bytes(),
            "the persisted key must be reused, not regenerated"
        );
    }

    #[test]
    fn delete_key_forces_a_fresh_key_on_next_get() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        use_mock_store();
        let first = get_or_create_dpop_key().unwrap();
        delete_dpop_key().unwrap();
        let second = get_or_create_dpop_key().unwrap();
        assert_ne!(
            first.to_bytes(),
            second.to_bytes(),
            "after logout a new login must start with a new key"
        );
    }

    #[test]
    fn http_client_sends_dpop_header_and_retries_nonce_challenge() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        use_mock_store();
        set_nonce(None);

        // Blocking runtime so the whole scenario runs under the test mutex
        // (the keyring mock store and nonce cache are process globals).
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        runtime.block_on(async {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let port = server.server_addr().to_ip().unwrap().port();
            let url = format!("http://127.0.0.1:{port}/token");

            let server_thread = std::thread::spawn(move || {
                // Request 1: must carry a DPoP header with no nonce claim yet.
                let request = server.recv().unwrap();
                let dpop_header = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("DPoP"))
                    .map(|h| h.value.as_str().to_string())
                    .expect("request 1 must carry a DPoP header");
                let parts: Vec<&str> = dpop_header.split('.').collect();
                assert_eq!(parts.len(), 3, "DPoP header must be a JWT");
                let payload: serde_json::Value =
                    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
                assert!(
                    payload.get("nonce").is_none(),
                    "no nonce may be claimed before the server issued one"
                );
                request
                    .respond(
                        tiny_http::Response::from_string(r#"{"error":"use_dpop_nonce"}"#)
                            .with_status_code(400)
                            .with_header(
                                tiny_http::Header::from_bytes(&b"DPoP-Nonce"[..], &b"CHALLENGE-NONCE"[..])
                                    .unwrap(),
                            ),
                    )
                    .unwrap();

                // Request 2: retried with the fresh nonce in the payload.
                let request = server.recv().unwrap();
                let dpop_header = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("DPoP"))
                    .map(|h| h.value.as_str().to_string())
                    .expect("request 2 must carry a DPoP header");
                let parts: Vec<&str> = dpop_header.split('.').collect();
                let payload: serde_json::Value =
                    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
                assert_eq!(payload["nonce"], "CHALLENGE-NONCE");
                request
                    .respond(
                        tiny_http::Response::from_string(
                            r#"{"access_token":"at","token_type":"Bearer","expires_in":3600}"#,
                        )
                        .with_status_code(200)
                        .with_header(
                            tiny_http::Header::from_bytes(&b"DPoP-Nonce"[..], &b"FRESH-NONCE"[..])
                                .unwrap(),
                        ),
                    )
                    .unwrap();
            });

            let request = HttpRequest {
                url: url::Url::parse(&url).unwrap(),
                method: Method::POST,
                headers: HeaderMap::new(),
                body: b"grant_type=refresh_token&refresh_token=rt".to_vec(),
            };
            let response = dpop_http_client(request).await.unwrap();
            assert_eq!(response.status_code, StatusCode::OK);
            assert_eq!(
                get_nonce().as_deref(),
                Some("FRESH-NONCE"),
                "the nonce from the final response must be cached for the next request"
            );
            server_thread.join().unwrap();
        });
    }
}