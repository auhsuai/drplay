use std::sync::atomic::{Ordering, AtomicU64};
use std::sync::OnceLock;
use tauri::Manager;

pub mod protocol;
mod thumbnail;
mod auth;
mod db;
mod tray;
mod memory;

use auth::{login_google_native, refresh_google_token};
use db::metadata::{get_local_metadata, get_track_data, verify_track_exists, update_track_duration_in_db, clear_local_cache};
use memory::{apply_window_activity, WindowActivityEvent};
use tray::{setup_tray, update_minimize_to_tray, IS_QUITTING, MINIMIZE_TO_TRAY};

pub static HAS_FILE_TYPE: OnceLock<bool> = OnceLock::new();
pub static HAS_THUMB: OnceLock<bool> = OnceLock::new();
pub static HAS_COVER_URL: OnceLock<bool> = OnceLock::new();
pub static HAS_EXTENDED_META: OnceLock<bool> = OnceLock::new();
pub static HAS_DURATION_ESTIMATED: OnceLock<bool> = OnceLock::new();
pub static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[tauri::command]
fn register_download_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;
    let scope = app.fs_scope();
    scope
        .allow_directory(path, true)
        .map_err(|e| format!("failed to extend fs scope for download dir: {}", e))?;
    Ok(())
}

// Extend the fs READ scope for the user-picked upload source (drag-drop or
// folder picker). Directories are allowed recursively so walkDiskFolder can
// descend; single files get a file pattern. The plugin's resolve_path checks
// `fs_scope.scope.is_allowed()` (runtime-extended scope) as an OR against the
// capability paths, so bare fs:allow-read-* capabilities + this extension are
// sufficient (verified against plugins-workspace v2 fs commands.rs 2026-08-02).
#[tauri::command]
fn register_upload_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;
    let scope = app.fs_scope();
    if std::path::Path::new(&path).is_dir() {
        scope
            .allow_directory(path, true)
            .map_err(|e| format!("failed to extend fs scope for upload dir: {}", e))?;
    } else {
        scope
            .allow_file(path)
            .map_err(|e| format!("failed to extend fs scope for upload file: {}", e))?;
    }
    Ok(())
}

pub(crate) fn get_db_path() -> Option<std::path::PathBuf> {
    if let Ok(mut exe_path) = std::env::current_exe() {
        exe_path.pop();
        let path = exe_path.join("music_database.db");
        if path.exists() { return Some(path); }
    }
    if std::path::Path::new("music_database.db").exists() {
        Some(std::path::PathBuf::from("music_database.db"))
    } else if std::path::Path::new("../music_database.db").exists() {
        Some(std::path::PathBuf::from("../music_database.db"))
    } else {
        None
    }
}

pub fn diag_log(module: &str, dur: std::time::Duration) {
    static DIAG_COUNT: AtomicU64 = AtomicU64::new(0);
    let c = DIAG_COUNT.fetch_add(1, Ordering::Relaxed);
    eprintln!("[PERF] {} took {:?} (call #{})", module, dur, c);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn apply_window_activity_for_window(window: &tauri::Window, event: WindowActivityEvent) {
    if let Some(webview_window) = window.get_webview_window("main") {
        apply_window_activity(&webview_window, event);
    }
}

pub fn run() {
    let app_result = protocol::register(tauri::Builder::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_keepawake::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            APP_HANDLE.set(app.handle().clone()).ok();

            if let Ok(cache_dir) = app.path().app_cache_dir() {
                let access_log = cache_dir.join(".thumbnails").join("access_log.json");
                crate::protocol::init_access_recorder(access_log);
            }

            use r2d2_sqlite::SqliteConnectionManager;
            use r2d2::Pool;
            let db_path = get_db_path().unwrap_or_else(|| std::path::PathBuf::from("music_database.db"));
            let manager = SqliteConnectionManager::file(&db_path);
            if let Ok(pool) = Pool::new(manager) {
                let migration_pool = pool.clone();
                app.manage(pool);

                if let Ok(conn) = migration_pool.get() {
                    db::migration::run_migrations(&conn);
                }
            }

            setup_tray(app)?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if !IS_QUITTING.load(std::sync::atomic::Ordering::SeqCst) && MINIMIZE_TO_TRAY.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = window.hide();
                    apply_window_activity_for_window(window, WindowActivityEvent::HiddenToTray);
                    api.prevent_close();
                }
            }
            tauri::WindowEvent::Focused(focused) => {
                let event = if *focused { WindowActivityEvent::Focused } else { WindowActivityEvent::Unfocused };
                apply_window_activity_for_window(window, event);
            }
            tauri::WindowEvent::Resized(size) => {
                let event = if size.width == 0 || size.height == 0 {
                    WindowActivityEvent::Minimized
                } else {
                    WindowActivityEvent::ResizedToNormal
                };
                apply_window_activity_for_window(window, event);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            login_google_native,
            refresh_google_token,
            register_download_path,
            register_upload_path,
            get_track_data,
            get_local_metadata,
            update_minimize_to_tray,
            verify_track_exists,
            update_track_duration_in_db,
            clear_local_cache,
        ])
        .build(tauri::generate_context!());

    let app = match app_result {
        Ok(app) => app,
        Err(e) => {
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
