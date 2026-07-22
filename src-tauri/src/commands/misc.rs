use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::command;

use crate::{STREAM_URL_TTL_SECS, NOMINAL_BYTES_PER_SEC, MIN_BUFFER_BYTES, MAX_BUFFER_BYTES, DEFAULT_BUFFER_SECONDS_F64};

pub fn buffer_bytes_for_seconds(seconds: u64) -> u64 {
    let bytes = seconds * NOMINAL_BYTES_PER_SEC;
    bytes.clamp(MIN_BUFFER_BYTES, MAX_BUFFER_BYTES)
}

pub fn build_stream_url(file_id: &str, ext: Option<&str>) -> String {
    let ext_str = ext.unwrap_or("");
    let ext_param = if ext_str.is_empty() { String::new() } else { format!("&ext={}", ext_str) };

    let exp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() + STREAM_URL_TTL_SECS;
    let payload = format!("{}:{}:{}", file_id, ext_str, exp);
    let secret = crate::PROXY_SECRET.get().expect("PROXY_SECRET not initialized");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC key from PROXY_SECRET");
    mac.update(payload.as_bytes());
    let sig = mac.finalize().into_bytes().iter().map(|b| format!("{:02x}", b)).collect::<String>();

    format!("http://drplay.localhost/stream?id={}{}&exp={}&sig={}", file_id, ext_param, exp, sig)
}

#[command]
pub async fn get_stream_url(file_id: String, _bitrate: Option<f64>, _buffer_seconds: Option<f64>, ext: Option<String>) -> Result<String, String> {
    let start = Instant::now();
    let result = build_stream_url(&file_id, ext.as_deref());
    crate::diag_log("get_stream_url", start.elapsed());
    Ok(result)
}

#[command]
pub fn register_download_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;
    let scope = app.fs_scope();
    scope.allow_directory(path, true).map_err(|e| format!("failed to extend fs scope for download dir: {}", e))?;
    Ok(())
}

#[command]
pub fn update_buffer_settings(seconds: usize) {
    crate::GLOBAL_BUFFER_SECONDS.store(seconds, Ordering::SeqCst);
}

#[command]
pub async fn update_stream_token(token: String) -> Result<(), String> {
    *crate::GLOBAL_STREAM_TOKEN.lock().await = token;
    crate::GLOBAL_TOKEN_NOTIFY.notify_waiters();
    Ok(())
}

#[command]
pub async fn clear_stream_token() -> Result<(), String> {
    crate::GLOBAL_STREAM_TOKEN.lock().await.clear();
    Ok(())
}

#[command]
pub fn update_minimize_to_tray(minimize: bool) {
    crate::MINIMIZE_TO_TRAY.store(minimize, Ordering::SeqCst);
}

#[command]
pub async fn clear_local_cache(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}
