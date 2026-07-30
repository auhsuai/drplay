use axum::{response::{IntoResponse, Response}, http::StatusCode};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::proxy::backoff::{compute_cooldown_secs, equal_jitter};
use crate::proxy::constants::TOKEN_RECOVERY_TIMEOUT;
use crate::proxy::types::StreamQuery;

pub fn now_epoch_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

pub async fn recover_stream_token(old_token: &str) -> Option<String> {
    let notify = crate::GLOBAL_TOKEN_NOTIFY.clone();
    let notified = notify.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();

    if let Some(app) = crate::APP_HANDLE.get() {
        let _ = app.emit("token-expired", ());
    }

    tokio::select! {
        _ = &mut notified => {}
        _ = tokio::time::sleep(TOKEN_RECOVERY_TIMEOUT) => {
            return None;
        }
    }

    let new_token = crate::GLOBAL_STREAM_TOKEN.lock().await.clone();
    if new_token.is_empty() || new_token == old_token {
        None
    } else {
        Some(new_token)
    }
}

pub async fn handle_rate_limit(now: u64) -> Response {
    let fail_count = crate::proxy::FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
    let cooldown = equal_jitter(Duration::from_secs(compute_cooldown_secs(fail_count))).as_secs();
    crate::proxy::GLOBAL_BACKOFF_UNTIL.store(now + cooldown, Ordering::Release);
    (StatusCode::SERVICE_UNAVAILABLE, [("X-Stream-Error-Type", "rate-limited")], "Rate limited — backing off").into_response()
}

pub fn verify_signature(query: &StreamQuery, expected_secret: &str) -> Result<(), Response> {
    let now = now_epoch_secs();
    if now > query.exp {
        return Err((StatusCode::FORBIDDEN, [("X-Stream-Error-Type", "url-expired")], "URL expired").into_response());
    }

    let ext_str = query.ext.clone().unwrap_or_default();
    let payload = format!("{}:{}:{}", query.id, ext_str, query.exp);
    let mut mac = match Hmac::<Sha256>::new_from_slice(expected_secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return Err((StatusCode::INTERNAL_SERVER_ERROR, "HMAC init error").into_response()),
    };
    mac.update(payload.as_bytes());
    let expected_sig = mac.finalize().into_bytes()
        .iter().map(|b| format!("{:02x}", b)).collect::<String>();

    if expected_sig.len() != query.sig.len() {
        return Err((StatusCode::UNAUTHORIZED, "Invalid signature").into_response());
    }
    let mut diff = 0u8;
    for (a, b) in expected_sig.bytes().zip(query.sig.bytes()) {
        diff |= a ^ b;
    }
    if diff != 0 {
        return Err((StatusCode::UNAUTHORIZED, "Invalid signature").into_response());
    }
    Ok(())
}
