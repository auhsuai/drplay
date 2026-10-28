//! Aspect-ratio lock for the PiP window: a `WM_SIZING` WndProc subclass on the
//! top-level PiP HWND.
//!
//! WHY A NATIVE SUBCLASS: neither `tauri` 2.12.4 nor `@tauri-apps/api` exposes
//! `setAspectRatio` (checked against the crate sources and the bundled JS
//! bindings — zero occurrences of `aspect_ratio`/`setAspectRatio`), so the only
//! place to constrain the rectangle while the user drags an edge is
//! `WM_SIZING`, whose `lParam` is a `RECT*` the window procedure is allowed to
//! mutate in place.
//!
//! WHY THE TOP-LEVEL WINDOW OF THIS PROCESS: the PiP window is created by JS as
//! `decorations: false`, which makes `tauri-runtime-wry`'s
//! `undecorated_resizing` module create private child HWNDs
//! (`TAURI_DRAG_RESIZE_BORDERS` / `TAURI_DRAG_RESIZE_WINDOW`) that answer
//! `WM_NCHITTEST` with the 8 resize codes on the parent's behalf. Those are
//! dependency internals and must not be subclassed; they also only ever see
//! `WM_SIZE`, never `WM_SIZING`. The top-level HWND is ours (same process), and
//! `WM_SIZING` is delivered to it — see `video_host/input.rs`'s doc comment for
//! why a WndProc address must never be written into another process's window.
//!
//! Everything except `WM_SIZING` is forwarded unchanged through
//! `CallWindowProcW` to the procedure that was installed before us, so
//! `tauri-runtime-wry`'s own `SetWindowSubclass` chain keeps working.
//!
//! Layout: `geometry` holds the pure rectangle math; this module owns the
//! `WM_SIZING` subclass, its two statics and the install/restore entry points.

use std::sync::Mutex;

use tauri::Manager;
use windows_sys::Win32::Foundation::{
    GetLastError, SetLastError, HWND, LPARAM, LRESULT, RECT, TRUE, WPARAM,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, IsWindow, SetWindowLongPtrW, GWLP_WNDPROC, WM_SIZING,
};

use super::geometry::{constrain_rect, RectI};

/// The video aspect ratio (`width / height`) the PiP window is locked to, or
/// `None` while it is unknown (at startup, and after teardown). Shared with
/// the WndProc, which is the only reader on the hot path.
static ASPECT: std::sync::LazyLock<Mutex<Option<f64>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// The window whose WndProc we replaced, plus the pointer we replaced it
/// with, so teardown can put the original back. `take()`-based access makes
/// a second restore a no-op, which is what keeps teardown order irrelevant.
static SUBCLASS: Mutex<Option<Subclass>> = Mutex::new(None);

/// One live subclass: the target handle and its previous WndProc.
struct Subclass {
    hwnd: usize,
    previous: WndProcFn,
}

/// The WndProc signature. `windows-sys` models a procedure as `Option<fn>`
/// so it can express NULL, which would wrap every stored procedure in an
/// `Option` of its own; the handle we get back from `SetWindowLongPtrW` is a
/// plain pointer and is checked for 0 explicitly instead.
type WndProcFn = unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT;

/// The aspect currently locked, or `None` while unknown.
fn current_aspect() -> Option<f64> {
    ASPECT
        .lock()
        .ok()
        .and_then(|slot| *slot)
        .filter(|aspect| aspect.is_finite() && *aspect > 0.0)
}

/// Store (or clear) the locked aspect. A poisoned slot only costs the lock,
/// never a panic: the window then simply resizes freely.
fn store_aspect(aspect: Option<f64>) {
    match ASPECT.lock() {
        Ok(mut slot) => *slot = aspect,
        Err(_) => log::warn!("[pip-aspect] aspect slot mutex poisoned; aspect not updated"),
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

/// A raw address read back from `GWLP_WNDPROC` as the procedure it points
/// at. Only ever called on a non-zero value, which is checked by the caller.
fn as_wnd_proc(address: isize) -> WndProcFn {
    // SAFETY: a live window's GWLP_WNDPROC entry is either a real procedure
    // pointer or 0; the caller rejects 0, so the only value transmuted here
    // is a pointer Windows itself handed back for that exact window.
    unsafe { std::mem::transmute::<isize, WndProcFn>(address) }
}

/// The address of a window procedure, which is what `SetWindowLongPtrW`
/// stores. Goes through a raw pointer because casting a function item
/// straight to an integer is a footgun the compiler warns about.
fn proc_address(procedure: WndProcFn) -> isize {
    procedure as *const () as isize
}

/// Message pump of the top-level PiP window. Exactly one message is ours:
///
/// * `WM_SIZING` -> rewrite the `RECT` in `lParam` to the locked aspect and
///   return `TRUE` so Windows uses the modified rectangle. `lParam` is a
///   `RECT*` the window procedure is documented to mutate in place; `wParam`
///   is the edge/corner being dragged.
///
/// While no aspect is known (startup, or after teardown) the rectangle is
/// left untouched and the message is forwarded with the previous procedure's
/// own return value, so the window still resizes normally.
///
/// Everything else — `WM_SIZE` (which `tauri-runtime-wry`'s
/// `undecorated_resizing` relies on to re-apply its drag-region cutout),
/// `WM_NCHITTEST`, `WM_GETMINMAXINFO`, painting — is handed to the previous
/// procedure untouched.
///
/// # Safety
/// Contractually an `extern "system"` WndProc installed through
/// `SetWindowLongPtrW(GWLP_WNDPROC)`: Windows guarantees `hwnd`, `wparam` and
/// `lparam` are passed through unchanged, and the previous procedure is the
/// one the window was using before this one replaced it.
unsafe extern "system" fn pip_aspect_wnd_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_SIZING && lparam != 0 {
        if let Some(aspect) = current_aspect() {
            // SAFETY: WM_SIZING documents lParam as a non-null, writable
            // RECT* owned by the caller of the window procedure for the
            // duration of this call, which is exactly this stack frame.
            let proposed = unsafe {
                let rect = lparam as *const RECT;
                RectI {
                    left: (*rect).left,
                    top: (*rect).top,
                    right: (*rect).right,
                    bottom: (*rect).bottom,
                }
            };
            let constrained = constrain_rect(proposed, wparam as u32, aspect);
            if constrained != proposed {
                // SAFETY: same pointer as above; only the four i32 fields of
                // the caller's RECT are written, in place.
                unsafe {
                    let rect = lparam as *mut RECT;
                    (*rect).left = constrained.left;
                    (*rect).top = constrained.top;
                    (*rect).right = constrained.right;
                    (*rect).bottom = constrained.bottom;
                }
            }
            // TRUE advertises that the modified rectangle is the one to use.
            return TRUE as LRESULT;
        }
    }
    match previous_proc() {
        // SAFETY: `previous` is the WndProc this window was using before the
        // subclass was installed, i.e. exactly what CallWindowProcW
        // documents as its first argument.
        Some(previous) => unsafe { CallWindowProcW(Some(previous), hwnd, message, wparam, lparam) },
        // Unreachable in production (the slot is filled before the subclass
        // is installed); DefWindowProcW is the documented default handling
        // and is strictly better than dispatching through a null pointer.
        None => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

/// Swap in `pip_aspect_wnd_proc` on `target`, remembering the procedure it
/// replaces. Idempotent for the same handle.
///
/// `SetWindowLongPtrW` returns the PREVIOUS value and uses 0 for failure, and
/// "the previous value was 0" is not a thing for a live window — so the
/// documented disambiguation (clear the last error first, then treat
/// 0 + non-zero error as failure) is used instead of a bare `!= 0`.
fn install_subclass(target: usize) -> Result<(), String> {
    let existing = SUBCLASS
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|sub| sub.hwnd));
    match existing {
        // Already subclassed: the caller only wanted the aspect updated.
        Some(current) if current == target => return Ok(()),
        // A DIFFERENT window (the PiP window was closed and re-created): put
        // the old WndProc back FIRST. Overwriting the slot instead would
        // leave the window we stopped tracking dispatching through a
        // previous procedure that is not its own — CallWindowProcW into the
        // wrong window's chain is exactly the kind of crash this must not
        // have.
        Some(_) => restore_subclass(),
        None => {}
    }
    // SAFETY: clearing this thread's last-error value; no preconditions.
    unsafe { SetLastError(0) };
    let hwnd = target as HWND;
    // SAFETY: `hwnd` is a live window owned by this process, and the pointer
    // replaces the whole GWLP_WNDPROC entry with a `extern "system"`
    // function of the documented WndProc signature.
    let previous =
        unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, proc_address(pip_aspect_wnd_proc)) };
    // SAFETY: reading this thread's last-error value; no preconditions.
    let error = unsafe { GetLastError() };
    if previous == 0 && error != 0 {
        return Err(format!(
            "pip aspect lock: SetWindowLongPtrW({target}, GWLP_WNDPROC) failed (win32 error {error})"
        ));
    }
    if previous == 0 {
        return Err(format!(
            "pip aspect lock: window {target} reports no window procedure to chain to"
        ));
    }
    let previous = as_wnd_proc(previous);
    let mut slot = SUBCLASS
        .lock()
        .map_err(|_| "pip aspect lock: subclass slot mutex poisoned".to_string())?;
    *slot = Some(Subclass {
        hwnd: target,
        previous,
    });
    log::info!("[pip-aspect] aspect lock attached to window {target}");
    Ok(())
}

/// Put the original WndProc back and forget the subclass. `take()` makes a
/// second call a no-op, and `IsWindow` guards the case where the target is
/// already gone (window destroyed), so teardown order cannot turn into a
/// write through a dead handle.
fn restore_subclass() {
    let Some(entry) = SUBCLASS.lock().ok().and_then(|mut slot| slot.take()) else {
        return;
    };
    let hwnd = entry.hwnd as HWND;
    // SAFETY: plain query on a handle value we stored ourselves; a stale
    // handle only ever answers FALSE, it does not trap.
    if unsafe { IsWindow(hwnd) } == 0 {
        log::info!(
            "[pip-aspect] window {} is already gone; no WndProc to restore",
            entry.hwnd
        );
        return;
    }
    let previous = entry.previous as *const () as isize;
    // SAFETY: `hwnd` was just confirmed live and `previous` is the WndProc
    // this window used before we subclassed it.
    if unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, previous) } == 0 && previous != 0 {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { GetLastError() };
        log::warn!(
            "[pip-aspect] cannot restore the WndProc of {} (win32 error {error})",
            entry.hwnd
        );
    } else {
        log::info!(
            "[pip-aspect] restored the original WndProc of {}",
            entry.hwnd
        );
    }
}

/// Lock the PiP client area to `aspect` (`width / height`).
///
/// Stores the aspect first, then subclasses the top-level PiP HWND once.
/// Calling it again with a new aspect only updates the stored value — that
/// is what a video switch does, and it must not chain a second WndProc.
///
/// Must run on the thread that owns the window (a synchronous Tauri command
/// runs on the main thread), which is the only thread allowed to write its
/// `GWLP_WNDPROC`.
pub(crate) fn install(app: &tauri::AppHandle, aspect: f64) -> Result<(), String> {
    if !aspect.is_finite() || aspect <= 0.0 {
        return Err(format!(
            "pip aspect lock: refusing aspect {aspect} (must be finite and greater than 0)"
        ));
    }
    store_aspect(Some(aspect));
    let window = app
        .get_webview_window("pip")
        .ok_or_else(|| "pip aspect lock: pip window not found".to_string())?;
    let hwnd = window.hwnd().map_err(|hwnd_error| {
        format!("pip aspect lock: cannot resolve the pip HWND: {hwnd_error}")
    })?;
    let target = hwnd.0 as usize;
    install_subclass(target)?;
    log::info!("[pip-aspect] locked window {target} to aspect {aspect:.6}");
    Ok(())
}

/// Unlock and give the window its original WndProc back. Called from the
/// `WindowEvent::Destroyed` arm for the `pip` label, so a re-created PiP
/// window starts from a clean slot and installs again.
pub(crate) fn restore(app: &tauri::AppHandle) {
    let live = app
        .get_webview_window("pip")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as usize);
    match live {
        Some(hwnd) => log::debug!("[pip-aspect] tearing down the lock of window {hwnd}"),
        None => log::debug!("[pip-aspect] pip window already gone from the manager"),
    }
    // The aspect is per-window: drop it so a re-created PiP never inherits a
    // stale ratio from the previous video.
    store_aspect(None);
    restore_subclass();
}
