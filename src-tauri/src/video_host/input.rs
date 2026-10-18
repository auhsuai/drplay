//! Right-click interception for the video host: the WndProc subclass and the
//! event it emits. The window it targets is always passed in; the only native
//! state here is the one live `SUBCLASS` entry, which the WndProc needs in
//! order to find the procedure it chains to.

use std::sync::Mutex;

use tauri::Emitter;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, FindWindowExW, GetWindow, GetWindowThreadProcessId, IsWindow,
    SetWindowLongPtrW, GWLP_WNDPROC, GW_CHILD, MA_NOACTIVATE, WM_MOUSEACTIVATE, WM_RBUTTONDOWN,
    WM_RBUTTONUP,
};

use super::geometry::{client_point, screen_point, wide};
use super::{
    CONTEXT_MENU_EVENT, MPV_CHILD_ATTACH_POLL_MS, MPV_CHILD_ATTACH_TIMEOUT_MS, WEBVIEW_CLASS_NAME,
};

/// The window whose WndProc we replaced, plus the pointer we replaced it with,
/// so teardown can put the original back. `take()`-based access makes a second
/// restore a no-op, which is what keeps teardown order irrelevant.
static SUBCLASS: Mutex<Option<Subclass>> = Mutex::new(None);

/// One live subclass: the target handle and its previous WndProc.
struct Subclass {
    hwnd: usize,
    previous: WndProcFn,
}

/// The WndProc signature. `windows-sys` models a procedure as `Option<fn>` so
/// it can express NULL, which would wrap every stored procedure in an `Option`
/// of its own; the handle we get back from `SetWindowLongPtrW` is a plain
/// pointer and is checked for 0 explicitly instead.
type WndProcFn = unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT;

/// Whether the subclass slot is free: no live subclass, or a poisoned slot
/// (which is treated as "reattach anyway", exactly as the raw lock always was).
pub(super) fn subclass_slot_is_empty() -> bool {
    SUBCLASS.lock().map(|slot| slot.is_none()).unwrap_or(true)
}

/// Only the right-button PRESS opens the context menu — a press, not a
/// release, so the menu opens the instant the button goes down instead of one
/// frame late. `WM_RBUTTONUP` is deliberately NOT the trigger (see
/// `video_input_wnd_proc`).
pub(super) fn is_context_menu_click(message: u32) -> bool {
    message == WM_RBUTTONDOWN
}

/// Forward a right-click to the frontend as exactly one `{x, y}` screen-pixel
/// event. `hwnd` is the window that got the click, so the conversion is correct
/// whichever window that is.
fn emit_context_menu_event(hwnd: HWND, lparam: LPARAM) {
    let point = screen_point(hwnd, client_point(lparam));
    let Some(app) = crate::APP_HANDLE.get() else {
        log::debug!("[video-input] right-click ignored: the app handle is not initialized");
        return;
    };
    if let Err(emit_error) = app.emit(
        CONTEXT_MENU_EVENT,
        serde_json::json!({ "x": point.x, "y": point.y }),
    ) {
        log::warn!("[video-input] cannot emit '{CONTEXT_MENU_EVENT}': {emit_error}");
    }
}

/// The previous WndProc of the live subclass, so every unhandled message can
/// be forwarded to the window's real procedure.
fn previous_proc() -> Option<WndProcFn> {
    SUBCLASS
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|sub| sub.previous))
}

/// A raw address read back from `GWLP_WNDPROC` as the procedure it points at.
/// Only ever called on a non-zero value, which is checked by the caller.
fn as_wnd_proc(address: isize) -> WndProcFn {
    // SAFETY: a live window's GWLP_WNDPROC entry is either a real procedure
    // pointer or 0; the caller rejects 0, so the only value transmuted here is
    // a pointer Windows itself handed back for that exact window.
    unsafe { std::mem::transmute::<isize, WndProcFn>(address) }
}

/// The address of a window procedure, which is what `SetWindowLongPtrW` stores.
/// Goes through a raw pointer because casting a function item straight to an
/// integer is a footgun the compiler warns about.
fn proc_address(procedure: WndProcFn) -> isize {
    procedure as *const () as isize
}

/// Message pump of the window mpv renders into — mpv's own child HWND when it
/// is there, the host itself otherwise. Three messages are ours:
///
/// * `WM_MOUSEACTIVATE` -> `MA_NOACTIVATE`: the video NEVER activates. Without
///   it the click activates the top-level window and moves keyboard focus out
///   of the WebView, which is exactly the focus bug this replaces (React's key
///   handlers live in the WebView and nowhere else).
/// * `WM_RBUTTONDOWN` -> ONE event with the screen position, return 0.
/// * `WM_RBUTTONUP` -> return 0 and emit NOTHING. Forwarding the release would
///   let Windows synthesize a `WM_CONTEXTMENU` from it and the menu would open
///   twice.
///
/// Everything else — mouse move, wheel, left drag — is handed to the previous
/// procedure untouched, so mpv's own input handling is bit-for-bit unchanged
/// and no per-mousemove work is added anywhere.
///
/// # Safety
/// Contractually an `extern "system"` WndProc installed through
/// `SetWindowLongPtrW(GWLP_WNDPROC)`: Windows guarantees `hwnd`, `wparam` and
/// `lparam` are passed through unchanged, and the previous procedure is the
/// one the window was using before this one replaced it.
pub(super) unsafe extern "system" fn video_input_wnd_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
        _ if is_context_menu_click(message) => {
            emit_context_menu_event(hwnd, lparam);
            0
        }
        WM_RBUTTONUP => 0,
        _ => match previous_proc() {
            // SAFETY: `previous` is the WndProc this window was using before
            // the subclass was installed, i.e. exactly what CallWindowProcW
            // documents as its first argument.
            Some(previous) => unsafe {
                CallWindowProcW(Some(previous), hwnd, message, wparam, lparam)
            },
            // Unreachable in production (the slot is filled before the
            // subclass is installed); DefWindowProcW is the documented default
            // handling and is strictly better than dispatching through a null
            // pointer.
            None => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        },
    }
}

/// Swap in `video_input_wnd_proc` on `hwnd`, remembering the procedure it
/// replaces. `SetWindowLongPtrW` returns the PREVIOUS value and uses 0 for
/// failure, and "the previous value was 0" is not a thing for a live window —
/// so the documented disambiguation (clear the last error first, then treat
/// 0 + non-zero error as failure) is used instead of a bare `!= 0`.
pub(super) fn install_subclass(hwnd: HWND) -> Result<(), String> {
    let target = hwnd as usize;
    let existing = SUBCLASS
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|sub| sub.hwnd));
    match existing {
        Some(current) if current == target => return Ok(()),
        // A DIFFERENT window (mpv was restarted and created a new child): put
        // the old WndProc back FIRST. Overwriting the slot instead would leave
        // the window we stopped tracking dispatching through a previous
        // procedure that is not its own — CallWindowProcW into the wrong
        // window's chain is exactly the kind of crash this must not have.
        Some(_) => restore_subclass(),
        None => {}
    }
    // SAFETY: clearing this thread's last-error value; no preconditions.
    unsafe { windows_sys::Win32::Foundation::SetLastError(0) };
    // SAFETY: `hwnd` is a live window owned by this process, and the pointer
    // replaces the whole GWLP_WNDPROC entry with a `extern "system"` function
    // of the documented WndProc signature.
    let previous =
        unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, proc_address(video_input_wnd_proc)) };
    // SAFETY: reading this thread's last-error value; no preconditions.
    let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
    if previous == 0 && error != 0 {
        return Err(format!(
            "video input: SetWindowLongPtrW({target}, GWLP_WNDPROC) failed (win32 error {error})"
        ));
    }
    if previous == 0 {
        return Err(format!(
            "video input: window {target} reports no window procedure to chain to"
        ));
    }
    let previous = as_wnd_proc(previous);
    let mut slot = SUBCLASS
        .lock()
        .map_err(|_| "video input: subclass slot mutex poisoned".to_string())?;
    *slot = Some(Subclass {
        hwnd: target,
        previous,
    });
    log::info!("[video-input] right-click interception attached to window {target}");
    Ok(())
}

/// Put the original WndProc back and forget the subclass. `take()` makes a
/// second call a no-op, and `IsWindow` guards the case where the target is
/// already gone (mpv killed, window destroyed), so teardown order — host first,
/// mpv's child after — cannot turn into a write through a dead handle.
pub(super) fn restore_subclass() {
    let Some(entry) = SUBCLASS.lock().ok().and_then(|mut slot| slot.take()) else {
        return;
    };
    let hwnd = entry.hwnd as HWND;
    // SAFETY: plain query on a handle value we stored ourselves; a stale handle
    // only ever answers FALSE, it does not trap.
    if unsafe { IsWindow(hwnd) } == 0 {
        log::info!(
            "[video-input] window {} is already gone; no WndProc to restore",
            entry.hwnd
        );
        return;
    }
    let previous = entry.previous as *const () as isize;
    // SAFETY: `hwnd` was just confirmed live and `previous` is the WndProc
    // this window used before we subclassed it.
    if unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, previous) } == 0 && previous != 0 {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        log::warn!(
            "[video-input] cannot restore the WndProc of {} (win32 error {error})",
            entry.hwnd
        );
    } else {
        log::info!(
            "[video-input] restored the original WndProc of {}",
            entry.hwnd
        );
    }
}

/// Hand keyboard focus to the WebView2 child of `parent`.
///
/// Needed because the video must never hold focus (React's shortcuts live in
/// the WebView), and a WebView that never received focus reports
/// `document.hasFocus() === false` — the keyboard is simply dead. The video
/// side of that is `WM_MOUSEACTIVATE -> MA_NOACTIVATE` (it never steals);
/// this is the other side: the WebView is the one window that SHOULD have it.
pub(super) fn focus_webview(parent: HWND) {
    // SAFETY: `child_class` is a NUL-terminated buffer that outlives the call.
    let class = wide(WEBVIEW_CLASS_NAME);
    // SAFETY: `parent` is the live Tauri main window; a null match window and a
    // null title mean "first direct child of this class".
    let webview = unsafe {
        FindWindowExW(
            parent,
            std::ptr::null_mut(),
            class.as_ptr(),
            std::ptr::null(),
        )
    };
    if webview.is_null() {
        log::warn!("[video-input] no '{WEBVIEW_CLASS_NAME}' child under window {}; keyboard focus left alone", parent as usize);
        return;
    }
    // SAFETY: `webview` is a live child window of this process and the calling
    // (main) thread owns it, which is SetFocus's only requirement.
    let previous = unsafe { SetFocus(webview) };
    if previous.is_null() {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        log::warn!(
            "[video-input] SetFocus({}) failed (win32 error {error}); keyboard focus left alone",
            webview as usize
        );
    } else {
        log::info!(
            "[video-input] keyboard focus moved to the WebView (from {})",
            previous as usize
        );
    }
}

/// mpv's own child window inside the host, once it exists. mpv creates it
/// asynchronously when it attaches to `--wid`, so this returns `None` until
/// then — the caller polls.
pub(super) fn mpv_child(host: HWND) -> Option<HWND> {
    // SAFETY: `host` is a live window; GW_CHILD asks for its first child
    // window, and a null result simply means mpv has not attached yet.
    let child = unsafe { GetWindow(host, GW_CHILD) };
    (!child.is_null()).then_some(child)
}

/// The process that owns `hwnd`, or `None` when the query fails.
pub(super) fn window_process(hwnd: HWND) -> Option<u32> {
    let mut owner = 0u32;
    // SAFETY: `owner` is a live local u32 that this call writes.
    if unsafe { GetWindowThreadProcessId(hwnd, &mut owner) } == 0 {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        log::warn!(
            "[video-input] GetWindowThreadProcessId({}) failed (win32 error {error})",
            hwnd as usize
        );
        return None;
    }
    Some(owner)
}

/// Wait, bounded, for mpv's child window to appear under `host`, then subclass
/// it so a right-click over the video reaches the app. Falls back to
/// subclassing the host itself whenever the child cannot be subclassed — which
/// is the common case, see the ownership check below.
///
/// WHY THE OWNERSHIP CHECK IS MANDATORY: mpv runs as a separate sidecar
/// process, so its child HWND belongs to `mpv.exe`, not to us. A WndProc is an
/// ADDRESS IN A PROCESS: writing ours into another process's window leaves that
/// process calling an unmapped address the next time it pumps a message, i.e. it
/// crashes the engine. MSDN says so outright for `SetWindowLongPtrW` —
/// "should not subclass a window class created by another process" — and the
/// same hazard is documented in the long form at
/// jdearden.org/programming_windows_notebook/safe_subclassing_in_win32.html
/// ("an application cannot subclass a window or class that belongs to another
/// process"). So a foreign child is deliberately NEVER subclassed.
///
/// The wait runs on the main thread, so it is capped hard
/// (`MPV_CHILD_ATTACH_TIMEOUT_MS`): a video that never starts costs one bounded
/// delay, not a hang. Every failure is logged here and NOT propagated: the only
/// thing lost is the context menu, never playback.
pub(super) fn attach_input_subclass(host: HWND) {
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_millis(u64::from(MPV_CHILD_ATTACH_TIMEOUT_MS));
    let candidate = loop {
        if let Some(child) = mpv_child(host) {
            break Some(child);
        }
        if std::time::Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(u64::from(
            MPV_CHILD_ATTACH_POLL_MS,
        )));
    };
    let target = match candidate {
        Some(child) if window_process(child) == Some(std::process::id()) => child,
        Some(child) => {
            log::info!(
                "[video-input] window {child:?} belongs to another process (mpv); subclassing the host instead"
            );
            host
        }
        None => {
            log::info!(
                "[video-input] mpv created no child window; intercepting on the host instead"
            );
            host
        }
    };
    if let Err(attach_error) = install_subclass(target) {
        log::error!("[video-input] {attach_error}");
        // One retry against the host: it is always live and always ours, so a
        // child-specific failure must not cost the context menu entirely.
        if target != host {
            if let Err(host_error) = install_subclass(host) {
                log::error!("[video-input] fallback to the host window failed: {host_error}");
            }
        }
    }
}
