#[cfg(windows)]
use tauri::{AppHandle, Manager};

#[cfg(windows)]
pub fn pip_window_hwnd(app: &AppHandle) -> Result<usize, String> {
    let window = app
        .get_webview_window("pip")
        .ok_or_else(|| "pip window not found".to_string())?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    Ok(hwnd.0 as usize)
}

#[cfg(windows)]
pub fn close_pip_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("pip") {
        // destroy() bypasses CloseRequested entirely: neither the global
        // minimize-to-tray handler nor a JS close-request listener can turn a
        // programmatic PiP teardown into a hidden-but-alive window.
        if let Err(error) = window.destroy() {
            log::error!("[pip] failed to destroy pip window: {error}");
        }
    }
}

/// Apply the app's keyboard policy to the PiP webview.
///
/// Why an explicit command instead of the `tauri://webview-created` event: the
/// event fires from inside `attach_webview`, i.e. while the window creation is
/// still on the stack. Installing from there would re-enter Tauri's event-loop
/// dispatch synchronously (`with_webview` short-circuits to
/// `handle_user_message` when already on the main thread). Doing it from the
/// PiP view's own mount is one queued message on an idle loop instead, and it
/// is exactly the moment the window is known to be alive.
///
/// Idempotent per label, and the registration slot is dropped on window
/// destroy (see `lib.rs` `WindowEvent::Destroyed`), so closing and reopening
/// the PiP window installs again.
#[cfg(windows)]
pub fn install_pip_keys(app: &AppHandle) {
    crate::webview_keys::install_for_pip(app);
}

#[cfg(not(windows))]
pub fn install_pip_keys(_app: &tauri::AppHandle) {}

#[cfg(not(windows))]
pub fn pip_window_hwnd(_app: &tauri::AppHandle) -> Result<usize, String> {
    Err("pip window unsupported on this platform".to_string())
}

#[cfg(not(windows))]
pub fn close_pip_window(_app: &tauri::AppHandle) {}
