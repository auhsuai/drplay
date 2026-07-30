use std::time::Duration;
use std::sync::atomic::Ordering;
use tauri::Emitter;

use super::state::PLAYER;

const PROGRESS_INTERVAL_MS: u64 = 250;

pub fn start_progress_ticker(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(PROGRESS_INTERVAL_MS));
            let state = PLAYER.lock().ok();
            let state = match state {
                Some(s) => s,
                None => continue,
            };
            if state.is_seeking.load(Ordering::SeqCst) {
                drop(state);
                continue;
            }
            let is_playing = state
                .sink
                .as_ref()
                .map(|s| !s.is_paused())
                .unwrap_or(false);
            let pos = state
                .sink
                .as_ref()
                .map(|s| s.get_pos().as_secs_f64())
                .unwrap_or(0.0);
            let dur = state.duration;
            let file_id = state.current_file_id.clone();
            drop(state);
            let _ = app_handle.emit(
                "playback_time_update",
                serde_json::json!({
                    "position": pos,
                    "duration": dur,
                    "is_playing": is_playing,
                    "file_id": file_id,
                }),
            );
        }
    });
}
