use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use tauri::Manager;

#[cfg(test)]
use std::path::{Path, PathBuf};

pub mod protocol;
mod thumbnail;
mod auth;
mod tray;
mod memory;
mod token_store;
mod seed;
#[cfg(windows)]
mod mpv;
// In-process libmpv engine (S1 migration slice): the default engine; the
// legacy sidecar is opt-in (DRPLAY_PLAYER_ENGINE=legacy) or the silent
// fallback when libmpv cannot start.
#[cfg(windows)]
mod player;
#[cfg(windows)]
mod media_controls;
#[cfg(windows)]
mod video_host;
#[cfg(windows)]
mod context_menu;
#[cfg(windows)]
mod webview_keys;
mod pip_window;
mod stream_proxy;
mod path_scope;

use auth::{login_google_native, refresh_google_token};
use memory::{apply_window_activity, WindowActivityEvent};
use path_scope::validate_path_for_scope;
#[cfg(test)]
use path_scope::path_starts_with_ci;
#[cfg(windows)]
use mpv::{mpv_command, mpv_get_property, mpv_kill_sync_best_effort, mpv_shutdown, mpv_spawn};
use protocol::cover::{clear_local_cache, clear_thumbnail_dir, get_cache_info};
use tray::{setup_tray, update_minimize_to_tray, IS_QUITTING, MINIMIZE_TO_TRAY, restore_main_window};
#[cfg(windows)]
use video_host::{video_host_acquire, video_host_first_frame_presented, video_host_set_rect, video_host_set_visible};

#[cfg(windows)]
use context_menu::show_context_menu;
#[cfg(windows)]
use pip_window::{close_pip_window, pip_window_hwnd};

pub static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[cfg(windows)]
#[tauri::command]
fn pip_window_hwnd_cmd(app: tauri::AppHandle) -> i64 {
    pip_window_hwnd(&app).map(|h| h as i64).unwrap_or(0)
}

#[cfg(windows)]
#[tauri::command]
fn pip_window_close_cmd(app: tauri::AppHandle) {
    close_pip_window(&app);
}

#[cfg(windows)]
#[tauri::command]
async fn video_surface_retarget_to_pip_cmd(app: tauri::AppHandle) -> Result<(), String> {
    // The HWND can only come from the Tauri-managed webview window with the
    // "pip" label — never from a frontend-supplied value.
    let hwnd = pip_window_hwnd(&app)?;
    // The retarget waits for an acknowledged switch on the render thread;
    // keep that blocking work off the Tauri UI/main thread.
    tauri::async_runtime::spawn_blocking(move || {
        crate::player::video_surface_retarget(hwnd, "pip")
    })
    .await
    .map_err(|join_error| format!("pip retarget task failed: {join_error}"))?
}

#[cfg(windows)]
#[tauri::command]
async fn video_surface_retarget_to_main_cmd(app: tauri::AppHandle) -> Result<(), String> {
    // Only the Tauri-managed webview window with the "main" label can be a
    // retarget destination.
    let hwnd = crate::video_host::main_window_hwnd(&app)
        .map_err(|window_error| window_error.to_string())?;
    let hwnd = hwnd as usize;
    // Same as to-pip: the acknowledged switch blocks, so run it on the
    // blocking pool instead of the UI/main thread.
    tauri::async_runtime::spawn_blocking(move || {
        crate::player::video_surface_retarget(hwnd, "main")
    })
    .await
    .map_err(|join_error| format!("main retarget task failed: {join_error}"))?
}

#[tauri::command(async)]
fn register_download_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;
    let canonical = validate_path_for_scope(&path)?;
    if !canonical.is_dir() {
        return Err(format!("cannot extend fs scope: download path must be a directory: \"{path}\""));
    }
    let scope = app.fs_scope();
    scope
        .allow_directory(path, true)
        .map_err(|e| format!("failed to extend fs scope for download dir: {e}"))?;
    Ok(())
}

fn apply_window_activity_for_window(window: &tauri::Window, event: WindowActivityEvent) {
    // Only the main window owns the WebView2 activity state. PiP focus,
    // resize or minimize events must never pause/trim the main player.
    if window.label() != "main" {
        return;
    }
    if let Some(webview_window) = window.get_webview_window("main") {
        apply_window_activity(&webview_window, event);
    }
}

/// Log file size cap before the plugin rotates (KeepOne: only the newest file
/// survives) — bounded log dir by design.
const LOG_MAX_FILE_SIZE_BYTES: u128 = 5 * 1024 * 1024;

/// Default log level; overridable at runtime via `DRPLAY_LOG_LEVEL` (an
/// invalid value falls back to Info). Before R05-6 the app had no logger at
/// all, so every `log::*` call site was silently dropped.
fn log_level_from_env() -> log::LevelFilter {
    std::env::var("DRPLAY_LOG_LEVEL")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(log::LevelFilter::Info)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Single-instance guard MUST be registered before anything else so a second
    // launch never spins up its own session/player/tray. It restores the main
    // window of the already-running instance and exits the second one.
    let builder = tauri::Builder::default().plugin(
        tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            restore_main_window(app);
        }),
    );
    let app_result = protocol::register(builder)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_keepawake::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                // File target: OS log dir (Windows:
                // %LOCALAPPDATA%/<bundle id>/logs/drplay.log) + stdout so dev
                // runs still see records in the terminal.
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("drplay".to_string()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .max_file_size(LOG_MAX_FILE_SIZE_BYTES)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .level(log_level_from_env())
                .build(),
        )
        .setup(|app| {
            APP_HANDLE.set(app.handle().clone()).ok();

            // One engine decision for the whole session, BEFORE the frontend
            // acquires the video surface: libmpv by default, sidecar when the
            // DLL probe fails (or the env var asks for it). No user-visible UI.
            #[cfg(windows)]
            crate::player::initialize_engine_state();

            // WebView2 browser accelerators (Ctrl+P, Ctrl+F, Ctrl+=, F12,
            // Alt+Left/Right, ...) are handled inside WebView2, not reliably
            // stoppable from a JavaScript keydown handler. The native module
            // owns the whole keyboard policy: it turns the browser
            // accelerator set off and keeps F5 for the app's ordered
            // reload flow (session save -> mpv shutdown -> WebView reload).
            #[cfg(windows)]
            webview_keys::install(app.handle());

            if let Ok(cache_dir) = app.path().app_cache_dir() {
                // S3: on-disk cover cache root + background GC thread (runs
                // once now, then every GC_INTERVAL_SECS; detached, never
                // blocks setup and dies with the process).
                let covers_root = cache_dir.join("covers");
                crate::protocol::cover::init_covers_root(covers_root.clone());
                crate::protocol::cover::spawn_covers_gc(covers_root);
                // Seed offline import: <app_cache_dir>/metadata holds the
                // imported metadata JSONs (read disk-first by the pipeline).
                crate::seed::init_metadata_root(cache_dir.join("metadata"));
            } else {
                eprintln!(
                    "[drplay] app_cache_dir unavailable - cover cache, thumbnail GC and seed metadata will not be initialized"
                );
            }

            setup_tray(app)?;

            // Windows media flyout (SMTC): the app-owned session must be
            // registered after the main window exists. A failure only costs
            // the flyout — playback and the tray keep working.
            #[cfg(windows)]
            if let Err(controls_error) = media_controls::init(app.handle()) {
                log::warn!("[media-controls] init failed: {controls_error}");
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Minimize-to-tray applies to the main window only. The PiP
                // window must stay closable: hiding it here would leave a
                // live native surface with no visible window.
                if window.label() == "main"
                    && !IS_QUITTING.load(std::sync::atomic::Ordering::SeqCst)
                    && MINIMIZE_TO_TRAY.load(std::sync::atomic::Ordering::SeqCst)
                {
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
            tauri::WindowEvent::Destroyed => {
                // With minimize-to-tray disabled, closing the main window must
                // not leave a lone PiP window as the only video surface: tear
                // it down deterministically. A no-op when no PiP exists.
                if window.label() == "main" {
                    crate::pip_window::close_pip_window(window.app_handle());
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            login_google_native,
            refresh_google_token,
            register_download_path,
            update_minimize_to_tray,
            clear_local_cache,
            get_cache_info,
            clear_thumbnail_dir,
            seed::import_metadata_seed,
            seed::read_metadata_disk,
            token_store::set_refresh_token,
            token_store::get_refresh_token,
            token_store::delete_refresh_token,
            stream_proxy::stream_proxy_start,
            #[cfg(windows)] mpv_spawn,
            #[cfg(windows)] mpv_command,
            #[cfg(windows)] mpv_get_property,
            #[cfg(windows)] mpv_shutdown,
            #[cfg(windows)] media_controls::media_controls_update,
            #[cfg(windows)] video_host_acquire,
            #[cfg(windows)] video_host_set_rect,
            #[cfg(windows)] video_host_set_visible,
            #[cfg(windows)] video_host_first_frame_presented,
            #[cfg(windows)] show_context_menu,
            #[cfg(windows)] pip_window_hwnd_cmd,
            #[cfg(windows)] pip_window_close_cmd,
            #[cfg(windows)] video_surface_retarget_to_pip_cmd,
            #[cfg(windows)] video_surface_retarget_to_main_cmd,
        ])
        .build(tauri::generate_context!());

    let app = match app_result {
        Ok(app) => app,
        Err(e) => {
            eprintln!("[drplay] failed to build tauri application: {e}");
            std::process::exit(1);
        }
    };

    app.run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                IS_QUITTING.store(true, Ordering::SeqCst);
                // Belt-and-suspenders next to the Job Object guarantee: signal
                // mpv now (sync; cannot await mpv_shutdown here) so the child
                // is gone within ~ms on graceful quit. Abrupt deaths that skip
                // this handler entirely are still covered by KILL_ON_JOB_CLOSE.
                #[cfg(windows)]
                mpv_kill_sync_best_effort(app_handle);
                // Drop the native keyboard handler while the WebView still
                // exists; the controller releases it on teardown anyway, but
                // an explicit unsubscribe keeps one owner of the registration.
                #[cfg(windows)]
                webview_keys::uninstall(app_handle);
                // In-process engine counterpart: ordered destroy (event thread
                // join + mpv_destroy). No-op when no engine was spawned.
                #[cfg(windows)]
                player::teardown_for_exit();
                // The video host is OUR child window, not mpv's, so nothing
                // else reclaims it: destroying it here is what keeps a
                // painting surface from outliving the app. A no-op when no host
                // was ever acquired (audio-only session).
                #[cfg(windows)]
                video_host::destroy();
            }
            _ => {}
    });
}

#[cfg(test)]
mod tests;
