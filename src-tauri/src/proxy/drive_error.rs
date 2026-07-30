use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// Classified upstream failure. Distinguishing these lets the frontend react
/// correctly instead of treating every 403 as a transient rate limit.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum DriveErr {
    /// 429 / *rateLimitExceeded / dailyLimitExceeded — retry with backoff.
    Rate,
    /// 403 downloadQuotaExceeded — this file's download cap is exhausted.
    DownloadQuota,
    /// 403 insufficientFilePermissions / fileNotDownloadable — no access.
    AccessDenied,
    /// 404 notFound — file deleted or no longer visible.
    NotFound,
    /// 401 — OAuth token expired.
    Auth,
    /// 5xx / transport / malformed — retry a few times then give up.
    Upstream,
}

/// Extract Drive's machine-readable `error.errors[0].reason`, lowercased.
pub fn extract_drive_reason(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v.get("error")?
        .get("errors")?
        .as_array()?
        .first()?
        .get("reason")?
        .as_str()
        .map(|s| s.to_ascii_lowercase())
}

/// Map an upstream HTTP status + JSON body to a `DriveErr`.
/// The reason string is authoritative; status code is the fallback.
pub fn classify_drive_error(status: u16, body: &str) -> DriveErr {
    if let Some(reason) = extract_drive_reason(body) {
        match reason.as_str() {
            "downloadquotaexceeded" => return DriveErr::DownloadQuota,
            "insufficientfilepermissions"
            | "filenotdownloadable"
            | "appnotauthorizedtofile"
            | "domainpolicy"
            | "cannotdownloadfile" => return DriveErr::AccessDenied,
            _ => {}
        }
        if reason.contains("notfound") {
            return DriveErr::NotFound;
        }
        if reason.contains("ratelimitexceeded")
            || reason.contains("dailylimitexceeded")
            || reason.contains("quotaexceeded")
        {
            return DriveErr::Rate;
        }
    }
    match status {
        401 => DriveErr::Auth,
        404 => DriveErr::NotFound,
        403 | 429 => DriveErr::Rate,
        _ => DriveErr::Upstream,
    }
}

/// Build the terminal HTTP response for a non-retryable `DriveErr`.
pub fn drive_err_response(e: DriveErr) -> Response {
    match e {
        DriveErr::NotFound => (StatusCode::FORBIDDEN, [("X-Stream-Error-Type", "permanent")], "File not found").into_response(),
        DriveErr::AccessDenied => (StatusCode::FORBIDDEN, [("X-Stream-Error-Type", "access-denied")], "Access denied").into_response(),
        DriveErr::DownloadQuota => (StatusCode::FORBIDDEN, [("X-Stream-Error-Type", "download-quota")], "Download quota exceeded").into_response(),
        DriveErr::Auth => (StatusCode::UNAUTHORIZED, [("X-Stream-Error-Type", "auth-expired")], "Auth expired").into_response(),
        _ => (StatusCode::BAD_GATEWAY, "Upstream error").into_response(),
    }
}
