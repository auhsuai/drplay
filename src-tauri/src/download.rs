// Module: Rust streaming download — bytes KHÔNG BAO GIỜ chạm WebView heap.
// reqwest stream → std::fs::File, progress via Channel, cancel via AtomicBool flag.

use futures_util::StreamExt;
use reqwest::Client;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::Channel;

use crate::validate_path_for_scope;

// ---------------------------------------------------------------------------
// Cancel registry
// ---------------------------------------------------------------------------

static CANCEL_FLAGS: OnceLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> = OnceLock::new();
static NEXT_ID: OnceLock<Mutex<u64>> = OnceLock::new();

fn cancel_map() -> &'static Mutex<HashMap<u64, Arc<AtomicBool>>> {
    CANCEL_FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    let counter = NEXT_ID.get_or_init(|| Mutex::new(1u64));
    let mut guard = counter.lock().expect("next_id mutex poisoned");
    let id = *guard;
    *guard = id + 1;
    id
}

fn register_cancel() -> (u64, Arc<AtomicBool>) {
    let id = next_id();
    let flag = Arc::new(AtomicBool::new(false));
    cancel_map()
        .lock()
        .expect("cancel_map mutex poisoned")
        .insert(id, flag.clone());
    (id, flag)
}

fn unregister_cancel(id: u64) {
    cancel_map()
        .lock()
        .expect("cancel_map mutex poisoned")
        .remove(&id);
}

// ---------------------------------------------------------------------------
// Download events (serde tagged — frontend matches on `event` field)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(tag = "event")]
#[allow(dead_code)]
pub enum DownloadEvent {
    Started { #[serde(rename = "downloadId")] download_id: u64, total: Option<u64> },
    Progress { downloaded: u64 },
    Finished,
    Error { message: String },
}

// ---------------------------------------------------------------------------
// download_file command
// ---------------------------------------------------------------------------

/// Chunk size for streaming reads: 64 KiB.
#[allow(dead_code)]
const CHUNK_SIZE: usize = 64 * 1024;

/// Send a progress event at most every PROGRESS_INTERVAL_BYTES to avoid
/// flooding the channel with tiny updates.
const PROGRESS_INTERVAL_BYTES: u64 = 256 * 1024;

#[tauri::command]
pub async fn download_file(
    app: tauri::AppHandle,
    url: String,
    token: String,
    dest_dir: String,
    file_name: String,
    on_progress: Channel<DownloadEvent>,
) -> Result<String, String> {
    let _ = app; // AppHandle available for future scope extensions if needed

    // Validate destination directory
    let dest_path = validate_path_for_scope(&dest_dir)?;
    if !dest_path.is_dir() {
        return Err(format!("dest_dir is not a directory: \"{dest_dir}\""));
    }
    let file_path = dest_path.join(&file_name);

    // Register cancel flag
    let (download_id, cancel_flag) = register_cancel();

    // Build HTTP client
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("failed to create HTTP client: {e}"))?;

    // Send GET with Bearer token
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            unregister_cancel(download_id);
            format!("HTTP request failed: {e}")
        })?;

    let status = response.status();
    if !status.is_success() {
        unregister_cancel(download_id);
        return Err(format!("HTTP {status}"));
    }

    let total: Option<u64> = response.content_length();
    let _ = on_progress.send(DownloadEvent::Started { download_id, total });

    // Open output file
    let mut file = std::fs::File::create(&file_path).map_err(|e| {
        unregister_cancel(download_id);
        format!("cannot create file: {e}")
    })?;

    // Stream chunks
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_progress: u64 = 0;

    while let Some(chunk_result) = stream.next().await {
        // Check cancellation
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(&file_path);
            unregister_cancel(download_id);
            return Err("download cancelled".to_string());
        }

        let chunk = chunk_result.map_err(|e| {
            let _ = std::fs::remove_file(&file_path);
            unregister_cancel(download_id);
            format!("stream error: {e}")
        })?;

        file.write_all(&chunk).map_err(|e| {
            let _ = std::fs::remove_file(&file_path);
            unregister_cancel(download_id);
            format!("write error: {e}")
        })?;

        downloaded += chunk.len() as u64;

        // Throttle progress events
        if downloaded - last_progress >= PROGRESS_INTERVAL_BYTES || total.is_none() {
            let _ = on_progress.send(DownloadEvent::Progress { downloaded });
            last_progress = downloaded;
        }
    }

    // Flush final progress if we had any chunks
    if last_progress < downloaded {
        let _ = on_progress.send(DownloadEvent::Progress { downloaded });
    }

    // Done
    let _ = on_progress.send(DownloadEvent::Finished);
    unregister_cancel(download_id);

    Ok(file_path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// cancel_download command
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn cancel_download(download_id: u64) {
    let map = cancel_map().lock().expect("cancel_map mutex poisoned");
    if let Some(flag) = map.get(&download_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_map_round_trip() {
        let (id, flag) = register_cancel();
        assert!(!flag.load(Ordering::Relaxed));

        // Simulate cancel
        {
            let map = cancel_map().lock().unwrap();
            if let Some(f) = map.get(&id) {
                f.store(true, Ordering::Relaxed);
            }
        }
        assert!(flag.load(Ordering::Relaxed));

        unregister_cancel(id);
        let map = cancel_map().lock().unwrap();
        assert!(!map.contains_key(&id));
    }

    #[test]
    fn started_event_serializes_correctly() {
        let event = DownloadEvent::Started {
            download_id: 1,
            total: Some(1024),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["event"], "Started");
        assert_eq!(json["downloadId"], 1);
        assert_eq!(json["total"], 1024);

        let event_none = DownloadEvent::Started { download_id: 2, total: None };
        let json_none = serde_json::to_value(&event_none).unwrap();
        assert_eq!(json_none["event"], "Started");
        assert_eq!(json_none["downloadId"], 2);
        assert!(json_none["total"].is_null());
    }

    #[test]
    fn progress_event_serializes_correctly() {
        let event = DownloadEvent::Progress { downloaded: 512 };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["event"], "Progress");
        assert_eq!(json["downloaded"], 512);
    }

    #[test]
    fn finished_event_serializes_correctly() {
        let event = DownloadEvent::Finished;
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["event"], "Finished");
    }

    #[test]
    fn error_event_serializes_correctly() {
        let event = DownloadEvent::Error {
            message: "timeout".to_string(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["event"], "Error");
        assert_eq!(json["message"], "timeout");
    }

    #[test]
    fn missing_total_is_handled() {
        let event = DownloadEvent::Started { download_id: 1, total: None };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["event"], "Started");
        assert!(json["total"].is_null());
    }

    #[test]
    fn multiple_cancel_flags_are_independent() {
        let (id1, flag1) = register_cancel();
        let (id2, flag2) = register_cancel();

        // Cancel only id1
        {
            let map = cancel_map().lock().unwrap();
            if let Some(f) = map.get(&id1) {
                f.store(true, Ordering::Relaxed);
            }
        }

        assert!(flag1.load(Ordering::Relaxed));
        assert!(!flag2.load(Ordering::Relaxed));

        unregister_cancel(id1);
        unregister_cancel(id2);
    }
}
