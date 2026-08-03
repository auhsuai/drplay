use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use tauri::Manager;

pub mod protocol;
mod thumbnail;
mod auth;
mod tray;
mod memory;

use auth::{login_google_native, refresh_google_token};
use memory::{apply_window_activity, WindowActivityEvent};
use protocol::cover::clear_local_cache;
use tray::{setup_tray, update_minimize_to_tray, IS_QUITTING, MINIMIZE_TO_TRAY};

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
            update_minimize_to_tray,
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

#[cfg(test)]
mod tests {
    /// Guards against re-adding the SQLite backend after its removal
    /// (2026-08-03): the DB pool, migrations and 4 DB commands were deleted,
    /// so this crate must never pull in rusqlite/r2d2 again. Compiled in at
    /// build time via include_str! — a false positive is impossible.
    #[test]
    fn sqlite_backend_dependencies_are_absent() {
        let manifest = include_str!("../Cargo.toml");
        assert!(
            !manifest.contains("rusqlite"),
            "Cargo.toml must not depend on rusqlite — the SQLite backend was removed"
        );
        assert!(
            !manifest.contains("r2d2"),
            "Cargo.toml must not depend on r2d2 — the SQLite backend was removed"
        );
    }
}
