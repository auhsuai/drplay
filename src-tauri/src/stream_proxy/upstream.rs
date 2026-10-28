//! Upstream half of the localhost stream proxy: URL construction, manual
//! redirect following (Authorization sent only to the configured base
//! origin, non-https hops refused) and retry/backoff on retryable upstream
//! statuses.

use std::time::Duration;

use super::types::ProxyContext;

/// Redirect hops we are willing to follow manually before giving up (502).
const MAX_REDIRECTS: usize = 5;
/// Backoff before each status retry: ~250ms, then ~1s. No jitter: a single
/// local player does not herd, and fixed delays keep the fixture exact.
const STATUS_RETRY_BACKOFFS: [Duration; 2] = [Duration::from_millis(250), Duration::from_secs(1)];
/// Retries after the initial attempt for a retryable status (3 requests max).
const MAX_STATUS_RETRIES: usize = STATUS_RETRY_BACKOFFS.len();

/// KNOWN LIMITATION (verified 2026-10-07 by grep: `resourceKey` appears nowhere
/// in this crate): a link-shared file that needs `?resourceKey=` cannot be
/// streamed. `handle_request` takes `uri().path()` only, so a client cannot even
/// pass one through, and the upstream URL below is built from the file id alone.
/// That matches R7 in the investigation report and is deliberately NOT fixed
/// here: wiring resourceKey means changing the Drive/auth layer, which is out of
/// this slice's scope. Consequence: a Shared-Drive or link-shared movie shows up
/// in the library but fails to play with a 404/403 from the proxy.
pub(super) fn build_upstream_url(base_url: &str, file_id: &str) -> Result<url::Url, (u16, String)> {
    url::Url::parse(&format!("{base_url}/drive/v3/files/{file_id}?alt=media"))
        .map_err(|e| (400u16, format!("failed to build upstream URL: {e}")))
}

/// Drive file ids are `[A-Za-z0-9_-]+`; rejecting anything else keeps hostile
/// strings out of the upstream URL without needing percent-encoding.
pub(super) fn is_valid_file_id(file_id: &str) -> bool {
    !file_id.is_empty()
        && file_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Strips the query string from every `http(s)://…` URL in a message so a
/// signed upstream URL (its query carries credential-like params such as
/// Drive's `Signature`/`Expires`) can never reach the log or a response body.
/// Each URL keeps its scheme, authority and path; its query becomes
/// `?<redacted>`. Text without a URL passes through unchanged.
pub(super) fn redact_urls(message: String) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message.as_str();
    while let Some((index, scheme)) = ["https://", "http://"]
        .iter()
        .filter_map(|scheme| rest.find(scheme).map(|index| (index, *scheme)))
        .min_by_key(|(index, _)| *index)
    {
        out.push_str(&rest[..index]);
        // The URL ends at whitespace or ')': reqwest wraps it as
        // "error sending request for url (https://…)".
        let tail = &rest[index + scheme.len()..];
        let end = tail.find(|c: char| c.is_whitespace() || c == ')').unwrap_or(tail.len());
        out.push_str(scheme);
        let url = &tail[..end];
        match url.find('?') {
            Some(query_start) => {
                out.push_str(&url[..query_start]);
                out.push_str("?<redacted>");
            }
            None => out.push_str(url),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

pub(super) async fn fetch_upstream(
    context: &ProxyContext,
    mut url: url::Url,
    token: Option<&str>,
    range: Option<&str>,
) -> Result<reqwest::Response, (u16, String)> {
    // The first URL is built from the configured Drive base URL: its origin is
    // the only origin ever trusted with the Authorization header (see
    // plan_redirect_hop; reqwest auto-follow is disabled on purpose).
    let base = url.clone();
    for _ in 0..MAX_REDIRECTS {
        let plan = plan_redirect_hop(&base, &url).map_err(|refusal| (502u16, refusal))?;
        // Retry a retryable status up to MAX_STATUS_RETRIES times, reusing the
        // exact URL/token/Range; retries do not consume the redirect budget.
        // Nothing has been mirrored to the client yet here, so re-requesting
        // cannot corrupt a partial body.
        let mut attempt = 0usize;
        let sent = loop {
            let mut request = context.client.get(url.clone());
            if let (Some(token), HopPlan::WithCredentials) = (token, plan) {
                request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
            }
            if let Some(range) = range {
                request = request.header(reqwest::header::RANGE, range);
            }
            let sent = match tokio::time::timeout(context.headers_timeout, request.send()).await {
                Err(_elapsed) => return Err((504, format!("upstream did not respond within {:?}", context.headers_timeout))),
                Ok(Err(send_error)) => {
                    return Err((502, redact_urls(format!("upstream request failed: {send_error}"))))
                }
                Ok(Ok(sent)) => sent,
            };
            if !is_retryable_status(sent.status()) || attempt >= MAX_STATUS_RETRIES {
                // Final attempt (or a non-retryable status): pass the response
                // through; the sink sees exactly this status, once.
                break sent;
            }
            log::warn!(
                "[stream-proxy] upstream returned {} — retrying in {:?} (retry {}/{})",
                sent.status().as_u16(), STATUS_RETRY_BACKOFFS[attempt], attempt + 1, MAX_STATUS_RETRIES
            );
            tokio::time::sleep(STATUS_RETRY_BACKOFFS[attempt]).await;
            attempt += 1;
        };
        if sent.status().is_redirection() {
            let location = sent.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok())
                .ok_or_else(|| (502u16, "upstream redirect without Location header".to_string()))?;
            let target = url.join(location)
                .map_err(|e| (502u16, format!("upstream redirect has invalid Location: {e}")))?;
            if let Err(refusal) = plan_redirect_hop(&base, &target) {
                log::warn!("[stream-proxy] {refusal}");
                return Err((502, refusal));
            }
            url = target;
            continue;
        }
        return Ok(sent);
    }
    Err((502, format!("upstream exceeded {MAX_REDIRECTS} redirects")))
}

/// What to do with the URL of the next upstream request.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum HopPlan {
    /// Same origin as the configured base URL: resend the Bearer token.
    WithCredentials,
    /// Another origin (e.g. the signed `*.googleusercontent.com` URL a Drive
    /// redirect points at): follow it, but never send credentials.
    WithoutCredentials,
}

/// Decide how to treat one request URL relative to the base URL. Security
/// contract: the Bearer token only ever goes to the exact origin the base URL
/// was configured with (scheme+host+port — strictly narrower than reqwest's
/// auto-follow, which strips on host/scheme change only), and a non-https hop
/// is refused outright unless it is a plain-http test/dev base redirecting
/// within its own host (production base is https, so non-https is always
/// refused there).
pub(super) fn plan_redirect_hop(base: &url::Url, target: &url::Url) -> Result<HopPlan, String> {
    if target.scheme() != "https" {
        let same_host = target.host_str() == base.host_str();
        if base.scheme() == "https" || !same_host {
            return Err(format!(
                "refusing non-https redirect hop to {}://{}",
                target.scheme(),
                target.host_str().unwrap_or("<no host>")
            ));
        }
    }
    if target.origin() == base.origin() {
        Ok(HopPlan::WithCredentials)
    } else {
        Ok(HopPlan::WithoutCredentials)
    }
}

/// Statuses worth re-requesting: 429 (Google documents exponential backoff)
/// and the 5xx family. 403 is deliberately absent — quota/denial cases need a
/// body peek (out of scope) and permanent denials must not be retried.
fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504)
}
