//! Native child HWND video host: the single paint target mpv renders into,
//! living inside the Tauri main window's client area.
//!
//! Why a child HWND at all (VIDEO-EMBEDDING-ARCHITECTURE.md): a native child
//! window always paints ABOVE the WebView2 surface, so React can never draw on
//! top of the video, and mpv needs no window of its own — `--wid` makes it
//! render straight into the handle returned here. DrPlay's own controls stay
//! where they already are, structurally OUTSIDE the video rect.
//!
//! Threading: the window is created by `video_host_acquire`, a SYNCHRONOUS
//! Tauri command. Tauri invokes a sync command inline on the thread that
//! received the webview IPC message — the UI/main thread — so the child window
//! is created on, and its WndProc dispatched by, the thread that owns the
//! main window. `mpv_spawn` (async, tokio worker) therefore only READS the
//! stored handle; it never creates a window, because a window created on a tokio
//! worker would have no message pump.
//!
//! Right-click: the WND that the mouse actually lands on is subclassed (mpv's
//! own child HWND when it is there, the host otherwise) — no overlay window, no
//! per-mousemove work of any kind. See `video_input_wnd_proc`.
//!
//! Every Win32 call that can fail returns `Err`/`false` and is logged with
//! context. Nothing here panics: a missing video host degrades to mpv's own
//! window, which is the pre-slice behavior.
//!
//! Layout: `geometry` holds the pure helpers, `input` owns the one live
//! `SUBCLASS` entry, and `window` owns the one live `HOST` handle; this module
//! is the public entry point (Tauri commands and the crate-facing re-exports).

use windows_sys::Win32::Foundation::{COLORREF, HWND};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
};

#[cfg(test)]
use geometry::{client_point, screen_point};
#[cfg(test)]
use input::{
    install_subclass, is_context_menu_click, mpv_child, restore_subclass, video_input_wnd_proc,
    window_process,
};
#[cfg(test)]
use std::sync::Mutex;
#[cfg(test)]
use window::{own_visible, register_host_class};
#[cfg(test)]
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, POINT};
#[cfg(test)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetWindowLongPtrW, GWLP_WNDPROC, GWL_STYLE, MA_NOACTIVATE,
    WM_MOUSEACTIVATE, WM_RBUTTONUP, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_VISIBLE,
};

mod geometry;
mod input;
mod window;

pub(crate) use geometry::{clamp_rect, wide};
pub(crate) use window::{current_hwnd, destroy, main_window_hwnd};

use input::{attach_input_subclass, focus_webview, subclass_slot_is_empty};
use window::{ensure, set_rect_raw, set_visible_raw, HOST};

/// Label of the one Tauri window the host is parented to.
const MAIN_WINDOW_LABEL: &str = "main";

/// Window class name. Own class (not a built-in one like "STATIC") so the WndProc
/// and the class background are stated here instead of inherited from a class
/// whose behavior we do not control.
const HOST_CLASS_NAME: &str = "DrPlayVideoHost";

/// Frontend event carrying a right-click on the video area; payload is
/// `{ "x": i32, "y": i32 }` in PHYSICAL screen pixels. Kept verbatim so the
/// frontend contract (`useVideoContextMenu.ts`) is unaffected by this slice.
const CONTEXT_MENU_EVENT: &str = "video-context-menu";

/// How long we wait for mpv to create its child window inside the host before
/// falling back to subclassing the host itself. mpv attaches asynchronously,
/// so the child is NOT there yet when `video_host_acquire` returns (mpv is
/// spawned by a later command).
const MPV_CHILD_ATTACH_TIMEOUT_MS: u32 = 2_000;

/// Gap between the child-window probes inside that budget.
const MPV_CHILD_ATTACH_POLL_MS: u32 = 50;

/// Win32 error `ERROR_CLASS_ALREADY_EXISTS` (1410, NOT 141 — measured: a wrong
/// constant here turns the benign re-registration case into a hard failure).
/// Registering the same class from the same module twice fails with exactly
/// this, and the class is usable either way.
const ERROR_CLASS_ALREADY_EXISTS: u32 = 1410;

/// Black class background. The host starts hidden, but between `ShowWindow` and
/// mpv's first present the client area would otherwise hold whatever the parent
/// DC happened to contain (a white flash in the player area). Black is also
/// what a letterboxed video paints there, so a repaint mid-playback is invisible.
const HOST_BACKGROUND_COLOR: COLORREF = 0x0000_0000;

/// The WebView2 child's window class (wry/Chromium). It is the only descendant
/// of the Tauri window that ever holds keyboard focus for the app: React's key
/// handlers live in the WebView, so focus must sit here and never on a native
/// window of ours.
const WEBVIEW_CLASS_NAME: &str = "Chrome_RenderWidgetHostHWND";

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Create the child host if needed and return its HWND as an i64, or 0 on
/// failure. A second call returns the SAME handle: exactly one host per app
/// session, so mpv's render target never moves under a running video.
///
/// Right-click interception is attached here too, on the host: mpv creates its
/// own child inside it asynchronously, so this also covers the window mpv has
/// not created yet. A failure costs only the context menu.
#[tauri::command]
pub fn video_host_acquire(app: tauri::AppHandle) -> i64 {
    if crate::player::is_libmpv_mode() {
        // S3: libmpv mode owns the video surface through DirectComposition on
        // the main window; no native host window may ever be created or shown.
        // The DComp target is created with the engine (render thread owns it),
        // so acquire validates the main window and answers the established
        // non-zero "surface available" handle; idempotent, never creates a
        // window.
        return crate::player::video_surface_acquire(&app);
    }
    let parent = match main_window_hwnd(&app) {
        Ok(parent) => Some(parent),
        Err(window_error) => {
            if current_hwnd().is_none() {
                log::error!("[video-host] cannot acquire: {window_error}");
                return 0;
            }
            None
        }
    };
    if let Some(existing) = current_hwnd() {
        // Already acquired: mpv may only just have created its child window, so
        // this is the natural retry point for the interception.
        if subclass_slot_is_empty() {
            if let Some(parent) = parent {
                attach_input_subclass(parent as HWND);
            }
        }
        return existing;
    }
    let Some(parent) = parent else {
        return 0;
    };
    match ensure(&HOST, parent) {
        Ok(hwnd) => {
            log::info!(
                "[video-host] acquired host {hwnd} under main window {}",
                parent as usize
            );
            hwnd as i64
        }
        Err(acquire_error) => {
            log::error!("[video-host] acquire failed: {acquire_error}");
            0
        }
    }
}

/// Position the host inside the parent window's CLIENT area, in PHYSICAL pixels,
/// as reported by the frontend (`getBoundingClientRect`). Re-raises the host so
/// it keeps painting above the WebView2 child window.
#[tauri::command]
pub fn video_host_set_rect(x: i64, y: i64, w: i64, h: i64) {
    if crate::player::is_libmpv_mode() {
        // S3: forward to the DirectComposition visual rect (physical px,
        // client area). Clamping happens inside the player path.
        crate::player::video_surface_set_rect(x, y, w, h);
        return;
    }
    let Some(hwnd) = current_hwnd() else {
        // Not an error: an audio-only session never acquires a host, and this
        // command can be called before the first video is loaded.
        log::debug!("[video-host] set_rect ignored: no host acquired");
        return;
    };
    let (x, y, width, height) = clamp_rect(x, y, w, h);
    if !set_rect_raw(hwnd as HWND, x, y, width, height) {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        log::warn!("[video-host] SetWindowPos({hwnd}, {x}, {y}, {width}, {height}) failed (win32 error {error})");
        return;
    }
    log::info!("[video-host] rect {x},{y} {width}x{height}");
}

/// Show or hide the host. Idempotent both ways.
///
/// Showing is also where the player surface opens, so it is where the two
/// one-time native wirings happen: right-click interception on the video window
/// (mpv's child if it attached by now, the host otherwise) and keyboard focus
/// on the WebView.
#[tauri::command]
pub fn video_host_set_visible(app: tauri::AppHandle, visible: bool) {
    if crate::player::is_libmpv_mode() {
        // S3: forward to the DirectComposition visual (SetContent surface/null
        // on the render thread). Nothing is created or shown natively here.
        crate::player::video_surface_set_visible(visible);
        return;
    }
    let Some(hwnd) = current_hwnd() else {
        log::debug!("[video-host] set_visible({visible}) ignored: no host acquired");
        return;
    };
    if visible {
        // A hidden child loses its place in the parent's z-order, and the
        // WebView2 child would paint over it again, so re-raise on show.
        // SAFETY: `hwnd` is live and owned by this process.
        if unsafe {
            SetWindowPos(
                hwnd as HWND,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            )
        } == 0
        {
            // SAFETY: reading this thread's last-error value; no preconditions.
            let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            log::warn!("[video-host] re-raise of {hwnd} failed (win32 error {error})");
        }
    }
    if !set_visible_raw(hwnd as HWND, visible) {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        log::warn!(
            "[video-host] ShowWindow({hwnd}, visible={visible}) failed (win32 error {error})"
        );
    }
    if !visible {
        return;
    }
    // The video window can swallow the right-click while mpv is still attaching
    // its child, so the interception is (re)attached every time the surface is
    // shown; `install_subclass` is a no-op when the same window is already done.
    attach_input_subclass(hwnd as HWND);
    // The video never activates (MA_NOACTIVATE), so it never takes focus away
    // from the WebView — but a WebView that was never focused reports
    // document.hasFocus() === false and every keyboard shortcut is dead. Give it
    // the focus explicitly, once, as the player surface opens.
    match main_window_hwnd(&app) {
        Ok(parent) => focus_webview(parent),
        Err(window_error) => log::debug!("[video-input] focus skipped: {window_error}"),
    }
}

/// Read-only pull complement to the one-shot `video-first-frame` event: has the
/// render thread already handed a frame of the CURRENT media load to the
/// composition surface? The event has no replay (player/render/mod.rs), so a
/// frontend that missed it — page reload while the engine kept playing, a
/// listener re-registration racing a warm-engine first present — can ask this
/// instead and recover. The push event stays the fast path.
///
/// The legacy engine has no such signal (no composition surface), so the
/// answer there is always false — exactly today's behavior, where the legacy
/// engine never emits the event either.
#[tauri::command]
pub fn video_host_first_frame_presented() -> bool {
    if crate::player::is_libmpv_mode() {
        return crate::player::video_surface_first_frame_presented();
    }
    false
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
