use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

pub mod commands;
pub mod error;
pub mod player;
pub mod protocol;
pub mod slice_cache;
mod proxy;

pub use error::AppError;

// --- Stream URL / buffer sizing constants (shared with commands/misc.rs) ---
pub(crate) const STREAM_URL_TTL_SECS: u64 = 86_400;
pub(crate) const NOMINAL_BYTES_PER_SEC: u64 = 320_000 / 8;
pub(crate) const MIN_BUFFER_BYTES: u64 = 5 * 1024 * 1024;
pub(crate) const MAX_BUFFER_BYTES: u64 = 500 * 1024 * 1024;
const DEFAULT_BUFFER_SECONDS_USIZE: usize = 300;

// --- Globals ---
pub static GLOBAL_STREAM_TOKEN: LazyLock<tokio::sync::Mutex<String>> =
    LazyLock::new(|| tokio::sync::Mutex::new(String::new()));
pub static GLOBAL_TOKEN_NOTIFY: LazyLock<std::sync::Arc<tokio::sync::Notify>> =
    LazyLock::new(|| std::sync::Arc::new(tokio::sync::Notify::new()));

pub static PROXY_SECRET: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub static PROXY_PORT: AtomicU16 = AtomicU16::new(0);
// `buffer_seconds`/`slice_cache` used to live here too (as
// GLOBAL_BUFFER_SECONDS: AtomicUsize / GLOBAL_SLICE_CACHE: OnceLock<..>),
// reached via `crate::`-qualified paths from both the Tauri command layer
// and the Axum proxy server. They're *mutable* values genuinely shared
// across both frameworks -- exactly what AUDIT.md 5.2/7.1 flagged as the
// one real "could improve" item for this app's state sharing (citing
// v2.tauri.app/develop/state-management): no official bridge exists between
// `tauri::State` and Axum `State`, so each side had to reach for its own
// ambient global. They're now constructed once in `run()` below as
// `Arc`s, handed to `app.manage(...)` for Tauri commands and to
// `proxy::start_proxy(...)` (folded into `AppState`, see proxy/types.rs)
// for the Axum handlers -- the same shared instances reach both sides
// through each framework's own idiomatic state-injection mechanism instead
// of a crate-level static. `PROXY_SECRET`/`PROXY_PORT` directly above are
// deliberately NOT part of this: audit's own research calls out write-once
// values (a secret generated once at startup, a port bound once at startup)
// as fine to leave as statics -- only the mutable, continuously-read/written
// ones needed the change.
pub(crate) static MINIMIZE_TO_TRAY: AtomicBool = AtomicBool::new(true);
static IS_QUITTING: AtomicBool = AtomicBool::new(false);
pub static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

// Re-export commands for the invoke handler
pub use commands::auth::{login_google_native, refresh_google_token};
pub use commands::metadata::{get_local_metadata_batch, get_db_path, get_local_metadata_internal, LocalMetadata, LocalMetadataQuery};
pub use commands::misc::{
    buffer_bytes_for_seconds, build_stream_url, get_stream_url, register_download_path,
    update_buffer_settings, update_stream_token, clear_stream_token,
    update_minimize_to_tray, clear_local_cache,
};
pub use commands::token_store::{store_token, get_token, clear_token};
pub use commands::download::download_file_to_disk;
pub use commands::player::{
    native_play, native_pause, native_resume, native_seek,
    native_set_volume, native_stop, native_get_playback_state,
};

pub(crate) const DB_POOL_MAX_SIZE: u32 = 10;

// Diagnostic IPC timing logger
pub fn diag_log(module: &str, dur: Duration) {
    static DIAG_COUNT: AtomicU64 = AtomicU64::new(0);
    let c = DIAG_COUNT.fetch_add(1, Ordering::Relaxed);
    // debug, not info: fires on every get_stream_url/get_local_metadata_batch
    // IPC call (i.e. every track load), too frequent for the default
    // production log level.
    log::debug!(target: "perf", "[PERF] {} took {:?} (call #{})", module, dur, c);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::PROXY_SECRET.get_or_init(|| uuid::Uuid::new_v4().to_string());

    // Constructed once, shared (via Arc::clone, cheap) with both the Axum
    // proxy (through AppState, see proxy/types.rs) and Tauri's own command
    // layer (through app.manage() below) -- see the doc comment above
    // MINIMIZE_TO_TRAY for why this replaced the old GLOBAL_BUFFER_SECONDS/
    // GLOBAL_SLICE_CACHE statics.
    let buffer_seconds = Arc::new(AtomicUsize::new(DEFAULT_BUFFER_SECONDS_USIZE));
    let slice_cache = {
        let seconds = buffer_seconds.load(Ordering::Relaxed) as u64;
        let max_bytes = buffer_bytes_for_seconds(seconds);
        Arc::new(slice_cache::SliceCache::new(max_bytes))
    };

    proxy::start_proxy(slice_cache.clone(), buffer_seconds.clone());
    let app_result = protocol::register(tauri::Builder::default())
        .manage(slice_cache)
        .manage(buffer_seconds)
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                ])
                // Debug in dev (surfaces diag_log/content-type-override
                // traces), Info in release (keeps the persisted log file
                // small for end users while still capturing every warn!/
                // error! from the proxy/auth paths).
                .level(if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info })
                .level_for("h2", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("stream_download", log::LevelFilter::Warn)
                .level_for("tracing", log::LevelFilter::Warn)
                .level_for("keyring", log::LevelFilter::Warn)
                .level_for("perf", log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_keepawake::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            APP_HANDLE.set(app.handle().clone()).ok();

            // Initialize native audio player
            player::init_player();
            player::start_progress_ticker(app.handle().clone());

            // Best-effort SQLite pool for local tag lookup
            {
                use r2d2_sqlite::SqliteConnectionManager;
                use r2d2::Pool;
                let db_path = get_db_path().unwrap_or_else(|| std::path::PathBuf::from("music_database.db"));
                let manager = SqliteConnectionManager::file(&db_path);
                if let Ok(pool) = Pool::builder().max_size(DB_POOL_MAX_SIZE).build(manager) {
                    if let Ok(conn) = pool.get() {
                        if let Err(e) = conn.execute_batch(
                            "CREATE INDEX IF NOT EXISTS idx_tracks_size_bytes ON tracks(size_bytes); \
                             CREATE INDEX IF NOT EXISTS idx_tracks_id ON tracks(id);"
                        ) {
                            log::warn!("[lib] tracks-index-migration-failed (non-fatal): {}", e);
                        }
                    }
                    app.manage(pool);
                }
            }

            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show DrPlay", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let icon = app.default_window_icon().map(|i| i.clone());
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false);
            if let Some(icon) = icon {
                tray = tray.icon(icon);
            }
            let _tray = tray
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        IS_QUITTING.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if !IS_QUITTING.load(Ordering::SeqCst) && MINIMIZE_TO_TRAY.load(Ordering::SeqCst) {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            login_google_native,
            refresh_google_token,
            register_download_path,
            get_stream_url,
            update_buffer_settings,
            get_local_metadata_batch,
            update_stream_token,
            clear_stream_token,
            update_minimize_to_tray,
            clear_local_cache,
            store_token,
            get_token,
            clear_token,
            download_file_to_disk,
            native_play,
            native_pause,
            native_resume,
            native_seek,
            native_set_volume,
            native_stop,
            native_get_playback_state,
        ])
        .build(tauri::generate_context!());

    let app = match app_result {
        Ok(app) => app,
        Err(e) => {
            // Belt-and-suspenders on this one line only: this is the single
            // most consequential failure in the app (fatal, about to
            // process::exit), and it's the one place a logging backend
            // failing to have initialized yet would make the outage
            // undiagnosable. The log plugin is registered first in the
            // chain above and plugin setup hooks run before this point in
            // practice, so log::error! should reach Stdout/LogDir -- but if
            // `build()` failed because the log plugin's own init (e.g. an
            // unwritable log dir) didn't complete, `log` would silently
            // no-op. eprintln! is unconditional stderr, no init required.
            log::error!("[drplay] failed to build tauri application: {e}");
            eprintln!("[drplay] failed to build tauri application: {e}");
            std::process::exit(1);
        }
    };

    app.run(|_app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            IS_QUITTING.store(true, Ordering::SeqCst);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use commands::metadata::get_local_metadata_internal;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE tracks (
                id TEXT, title TEXT, artist TEXT, album TEXT,
                duration REAL, file_path TEXT,
                file_type TEXT, size_bytes INTEGER
            )",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn dedup_by_size_prefers_name() {
        let conn = setup();
        conn.execute(
            "INSERT INTO tracks (id, title, artist, duration, file_path, size_bytes) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["AAA", "Song A", "Artist A", 200.0, "/content/drive/v1/files/AAA", 1000i64],
        ).unwrap();
        conn.execute(
            "INSERT INTO tracks (id, title, artist, duration, file_path, size_bytes) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["BBB", "Song B", "Artist B", 200.0, "/content/drive/v1/files/BBB", 1000i64],
        ).unwrap();
        let m = get_local_metadata_internal(1000, "Song A", &conn).unwrap();
        assert_eq!(m.id, "AAA");
        assert_eq!(m.artist, "Artist A");
    }

    #[test]
    fn legacy_drive_path_still_reads() {
        let conn = setup();
        conn.execute(
            "INSERT INTO tracks (id, title, artist, duration, file_path, size_bytes) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["ZZZ", "My Song", "Someone", 200.0, "/content/drive/v1/files/ZZZ?alt=media", 1000i64],
        ).unwrap();
        let m = get_local_metadata_internal(1000, "My Song", &conn).unwrap();
        assert_eq!(m.id, "ZZZ");
    }

    #[test]
    fn no_match_returns_first_row_as_fallback() {
        let conn = setup();
        conn.execute(
            "INSERT INTO tracks (id, title, artist, duration, file_path, size_bytes) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["ONLY", "Unrelated Name", "Artist", 200.0, "/content/drive/v1/files/ONLY", 2000i64],
        ).unwrap();
        let m = get_local_metadata_internal(2000, "totally-different-name.mp3", &conn).unwrap();
        assert_eq!(m.id, "ONLY");
    }

    #[test]
    fn missing_size_returns_none() {
        let conn = setup();
        assert!(get_local_metadata_internal(999_999, "anything.mp3", &conn).is_none());
    }
}
