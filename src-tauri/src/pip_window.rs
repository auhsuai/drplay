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

#[cfg(not(windows))]
pub fn pip_window_hwnd(_app: &tauri::AppHandle) -> Result<usize, String> {
    Err("pip window unsupported on this platform".to_string())
}

#[cfg(not(windows))]
pub fn close_pip_window(_app: &tauri::AppHandle) {}
