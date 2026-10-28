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
//! The rectangle math lives in a pure function (`constrain_rect`) with no Win32
//! types, so it is unit-testable without a window.

/// The pure rectangle math, compiled only where it is used (Windows) or tested.
#[cfg(any(windows, test))]
mod geom {
    /// The eight `wParam` values `WM_SIZING` documents, mirrored here as plain
    /// numbers so the rect math (and its tests) carries no Win32 dependency.
    /// They are frozen Win32 ABI values; the windows-only test
    /// `local_edges_match_win32` pins them against `windows-sys`.
    pub(crate) const WMSZ_LEFT: u32 = 1;
    pub(crate) const WMSZ_RIGHT: u32 = 2;
    pub(crate) const WMSZ_TOP: u32 = 3;
    pub(crate) const WMSZ_TOPLEFT: u32 = 4;
    pub(crate) const WMSZ_TOPRIGHT: u32 = 5;
    pub(crate) const WMSZ_BOTTOM: u32 = 6;
    pub(crate) const WMSZ_BOTTOMLEFT: u32 = 7;
    pub(crate) const WMSZ_BOTTOMRIGHT: u32 = 8;

    /// A window rectangle in PHYSICAL pixels, the unit `WM_SIZING` works in (the
    /// coordinates are already DPI-scaled by the time a window procedure sees
    /// them). Deliberately not a Win32 type: `constrain_rect` stays testable.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) struct RectI {
        pub(crate) left: i32,
        pub(crate) top: i32,
        pub(crate) right: i32,
        pub(crate) bottom: i32,
    }

    impl RectI {
        /// `(width, height)` as i64 so a pathological rect cannot overflow the
        /// subtraction before it is clamped.
        fn size(self) -> (i64, i64) {
            (
                self.right as i64 - self.left as i64,
                self.bottom as i64 - self.top as i64,
            )
        }
    }

    /// Round a computed dimension to whole pixels and keep it inside
    /// `[1, i32::MAX]`. NaN saturates to 0 through the `as i64` cast and then
    /// clamps to 1, so a non-finite intermediate can never produce a
    /// zero/negative dimension.
    fn dimension(value: f64) -> i64 {
        (value.round() as i64).clamp(1, i32::MAX as i64)
    }

    /// Clamp an i64 coordinate back into i32 without wrapping around.
    fn coordinate(value: i64) -> i32 {
        value.clamp(i32::MIN as i64, i32::MAX as i64) as i32
    }

    /// Total fallback for the pathological case where an anchor sits at the very
    /// edge of the i32 coordinate space and the clamped far edge lands ON it: the
    /// rectangle must still enclose at least one pixel, moving the far edge if it
    /// can and the anchor if it cannot. Unreachable for any real screen, but it
    /// is what makes "never a zero/negative rect" unconditional.
    fn normalise(mut rect: RectI) -> RectI {
        if rect.right <= rect.left {
            match rect.left.checked_add(1) {
                Some(right) => rect.right = right,
                None => rect.left = rect.right.saturating_sub(1),
            }
        }
        if rect.bottom <= rect.top {
            match rect.top.checked_add(1) {
                Some(bottom) => rect.bottom = bottom,
                None => rect.top = rect.bottom.saturating_sub(1),
            }
        }
        rect
    }

    /// Force `rect` to `aspect` (`width / height`) while honouring which edge or
    /// corner the user is dragging (`edge`, i.e. `WM_SIZING`'s `wParam`).
    ///
    /// Anchoring rules — the edge/corner the user did NOT grab stays where it
    /// was:
    ///
    /// * `WMSZ_LEFT` / `WMSZ_RIGHT` (horizontal edge dragged): the width is what
    ///   the user just chose, so `height = round(width / aspect)` and the TOP
    ///   edge is fixed. `LEFT` keeps `right`, `RIGHT` keeps `left`.
    /// * `WMSZ_TOP` / `WMSZ_BOTTOM` (vertical edge dragged): the height is what
    ///   the user just chose, so `width = round(height * aspect)` and the LEFT
    ///   edge is fixed. `TOP` keeps `bottom`, `BOTTOM` keeps `top`.
    /// * Corners: the dragged corner is the grabbed one, so the width the drag
    ///   produced is authoritative and `height = round(width / aspect)`; the
    ///   OPPOSITE corner stays fixed.
    ///
    /// A non-finite or non-positive `aspect` (unknown yet at startup) and an
    /// unknown `edge` return `rect` untouched — the caller must not claim the
    /// message in that case.
    pub(crate) fn constrain_rect(rect: RectI, edge: u32, aspect: f64) -> RectI {
        if !aspect.is_finite() || aspect <= 0.0 {
            return rect;
        }
        let (raw_width, raw_height) = rect.size();
        let mut width = raw_width.max(1);
        let mut height = raw_height.max(1);
        match edge {
            // Horizontal edges: the dragged axis is the width, derive the height.
            WMSZ_LEFT | WMSZ_RIGHT => {
                height = dimension(width as f64 / aspect);
            }
            // Vertical edges: the dragged axis is the height, derive the width.
            WMSZ_TOP | WMSZ_BOTTOM => {
                width = dimension(height as f64 * aspect);
            }
            // Corners: derive the height from the dragged width.
            WMSZ_TOPLEFT | WMSZ_TOPRIGHT | WMSZ_BOTTOMLEFT | WMSZ_BOTTOMRIGHT => {
                height = dimension(width as f64 / aspect);
            }
            _ => return rect,
        }
        width = width.clamp(1, i32::MAX as i64);
        height = height.clamp(1, i32::MAX as i64);
        let out = match edge {
            WMSZ_LEFT => RectI {
                left: coordinate(rect.right as i64 - width),
                top: rect.top,
                right: rect.right,
                bottom: coordinate(rect.top as i64 + height),
            },
            WMSZ_RIGHT => RectI {
                left: rect.left,
                top: rect.top,
                right: coordinate(rect.left as i64 + width),
                bottom: coordinate(rect.top as i64 + height),
            },
            WMSZ_TOP => RectI {
                left: rect.left,
                top: coordinate(rect.bottom as i64 - height),
                right: coordinate(rect.left as i64 + width),
                bottom: rect.bottom,
            },
            WMSZ_BOTTOM => RectI {
                left: rect.left,
                top: rect.top,
                right: coordinate(rect.left as i64 + width),
                bottom: coordinate(rect.top as i64 + height),
            },
            WMSZ_TOPLEFT => RectI {
                left: coordinate(rect.right as i64 - width),
                top: coordinate(rect.bottom as i64 - height),
                right: rect.right,
                bottom: rect.bottom,
            },
            WMSZ_TOPRIGHT => RectI {
                left: rect.left,
                top: coordinate(rect.bottom as i64 - height),
                right: coordinate(rect.left as i64 + width),
                bottom: rect.bottom,
            },
            WMSZ_BOTTOMLEFT => RectI {
                left: coordinate(rect.right as i64 - width),
                top: rect.top,
                right: rect.right,
                bottom: coordinate(rect.top as i64 + height),
            },
            WMSZ_BOTTOMRIGHT => RectI {
                left: rect.left,
                top: rect.top,
                right: coordinate(rect.left as i64 + width),
                bottom: coordinate(rect.top as i64 + height),
            },
            _ => return rect,
        };
        normalise(out)
    }
}

#[cfg(any(windows, test))]
pub(crate) use geom::{constrain_rect, RectI};

#[cfg(windows)]
mod win32 {
    use std::sync::Mutex;

    use tauri::Manager;
    use windows_sys::Win32::Foundation::{
        GetLastError, SetLastError, HWND, LPARAM, LRESULT, RECT, TRUE, WPARAM,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, IsWindow, SetWindowLongPtrW, GWLP_WNDPROC, WM_SIZING,
    };

    use super::{constrain_rect, RectI};

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
            Some(previous) => unsafe {
                CallWindowProcW(Some(previous), hwnd, message, wparam, lparam)
            },
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
}

#[cfg(windows)]
pub(crate) use win32::{install, restore};

/// Non-Windows counterpart, mirroring `pip_window.rs`: the module still builds,
/// the feature is simply unavailable.
#[cfg(not(windows))]
pub(crate) fn install(_app: &tauri::AppHandle, _aspect: f64) -> Result<(), String> {
    Err("pip aspect lock unsupported on this platform".to_string())
}

/// Non-Windows counterpart, mirroring `pip_window.rs`: nothing was ever
/// installed, so teardown is a no-op. Not reached from `lib.rs` on that platform
/// (the whole `Destroyed` arm is Windows-only), hence the `dead_code` allowance.
#[cfg(not(windows))]
#[allow(dead_code)]
pub(crate) fn restore(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::geom::{
        constrain_rect, RectI, WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT, WMSZ_LEFT,
        WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
    };

    /// 16:9, the ratio every rectangle case below uses.
    const SIXTEEN_BY_NINE: f64 = 16.0 / 9.0;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RectI {
        RectI {
            left,
            top,
            right,
            bottom,
        }
    }

    fn size(candidate: RectI) -> (i32, i32) {
        (
            candidate.right - candidate.left,
            candidate.bottom - candidate.top,
        )
    }

    /// Dragging the RIGHT edge keeps the drag's width and derives the height;
    /// the top edge must not move. 480 / (16/9) = 270.
    #[test]
    fn wmsz_right_derives_height_from_kept_width() {
        let out = constrain_rect(rect(0, 0, 480, 300), WMSZ_RIGHT, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(0, 0, 480, 270));
        assert_eq!(size(out), (480, 270));
    }

    /// Dragging the BOTTOM edge keeps the drag's height and derives the width;
    /// the left edge must not move. 300 * (16/9) = 533.
    #[test]
    fn wmsz_bottom_derives_width_from_dragged_height() {
        let out = constrain_rect(rect(0, 0, 480, 300), WMSZ_BOTTOM, SIXTEEN_BY_NINE);
        assert_eq!(size(out), (533, 300));
        assert_eq!((out.left, out.top), (0, 0));
    }

    /// Dragging the LEFT edge moves `left` (it follows the drag), keeps `right`
    /// and `top`, and recomputes the height from the new width. 450 * 9/16 =
    /// 253.125 -> 253.
    #[test]
    fn wmsz_left_keeps_right_edge() {
        let out = constrain_rect(rect(130, 50, 580, 350), WMSZ_LEFT, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(130, 50, 580, 303));
    }

    /// Dragging the TOP edge moves `top`, keeps `bottom` and `left`, and
    /// recomputes the width from the dragged height. 330 * 16/9 = 586.67 -> 587.
    #[test]
    fn wmsz_top_keeps_bottom_edge() {
        let out = constrain_rect(rect(100, 20, 580, 350), WMSZ_TOP, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(100, 20, 687, 350));
    }

    /// Dragging the top-left corner: `left` follows the drag because the width
    /// comes from the dragged rect, `top` is derived, and the OPPOSITE corner
    /// (bottom-right) stays exactly where it was. 450 * 9/16 = 253.
    #[test]
    fn wmsz_topleft_keeps_opposite_corner() {
        let out = constrain_rect(rect(130, 20, 580, 350), WMSZ_TOPLEFT, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(130, 97, 580, 350));
    }

    /// Dragging the top-right corner: `right` follows the drag, `top` is derived,
    /// and the bottom-left corner stays fixed. 540 * 9/16 = 303.75 -> 304.
    #[test]
    fn wmsz_topright_keeps_opposite_corner() {
        let out = constrain_rect(rect(100, 20, 640, 350), WMSZ_TOPRIGHT, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(100, 46, 640, 350));
    }

    /// Dragging the bottom-left corner: `left` follows the drag, `bottom` is
    /// derived, and the top-right corner stays fixed.
    #[test]
    fn wmsz_bottomleft_keeps_opposite_corner() {
        let out = constrain_rect(rect(130, 50, 580, 380), WMSZ_BOTTOMLEFT, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(130, 50, 580, 303));
    }

    /// Dragging the bottom-right corner: `right` follows the drag, `bottom` is
    /// derived, and the top-left corner stays fixed. 540 * 9/16 = 303.75 -> 304,
    /// so `bottom = 50 + 304`.
    #[test]
    fn wmsz_bottomright_keeps_opposite_corner() {
        let out = constrain_rect(rect(100, 50, 640, 380), WMSZ_BOTTOMRIGHT, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(100, 50, 640, 354));
    }

    /// A fast drag can hand us a zero-sized or inverted rect. Every dimension
    /// must still be at least one pixel — never zero, never inverted, never NaN
    /// (the aspect is a float, so a 0-height input would otherwise divide to a
    /// non-finite height).
    #[test]
    fn degenerate_drags_never_go_below_one_pixel() {
        let cases = [
            (rect(0, 0, 480, 0), WMSZ_BOTTOM),
            (rect(0, 100, 480, 40), WMSZ_BOTTOM),
            (rect(10, 0, 0, 300), WMSZ_LEFT),
            (rect(0, 0, 0, 0), WMSZ_BOTTOMRIGHT),
        ];
        for (input, edge) in cases {
            let out = constrain_rect(input, edge, SIXTEEN_BY_NINE);
            let (width, height) = size(out);
            assert!(width >= 1, "width {width} for {input:?} / {edge}");
            assert!(height >= 1, "height {height} for {input:?} / {edge}");
            assert!(out.right > out.left, "inverted horizontally: {out:?}");
            assert!(out.bottom > out.top, "inverted vertically: {out:?}");
        }
    }

    /// An anchor pinned to the very edge of the i32 coordinate space cannot have
    /// its far edge moved (it would clamp back onto the anchor). The rect must
    /// still enclose at least one pixel instead of collapsing — this is the
    /// `normalise` fallback, unreachable on any real screen but the reason
    /// "never a zero/negative rect" is unconditional.
    #[test]
    fn extreme_coordinates_still_enclose_one_pixel() {
        // `WMSZ_RIGHT` at `left == i32::MAX`: `left + width` clamps back onto the
        // anchor, so the far edge cannot be moved and the ANCHOR has to give way.
        let out = constrain_rect(
            rect(i32::MAX, 0, i32::MAX, 300),
            WMSZ_RIGHT,
            SIXTEEN_BY_NINE,
        );
        assert!(out.right > out.left, "inverted horizontally: {out:?}");
        assert!(out.bottom > out.top, "inverted vertically: {out:?}");
        let (width, height) = size(out);
        assert!(width >= 1, "width {width} for {out:?}");
        assert!(height >= 1, "height {height} for {out:?}");
    }

    /// No aspect known yet (startup), or a nonsense one: the rect must come back
    /// byte-for-byte unchanged so the caller can forward the message.
    #[test]
    fn invalid_aspect_leaves_rect_untouched() {
        let input = rect(100, 50, 580, 350);
        for aspect in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -1.6] {
            for edge in [
                WMSZ_LEFT,
                WMSZ_RIGHT,
                WMSZ_TOP,
                WMSZ_BOTTOM,
                WMSZ_TOPLEFT,
                WMSZ_TOPRIGHT,
                WMSZ_BOTTOMLEFT,
                WMSZ_BOTTOMRIGHT,
            ] {
                assert_eq!(
                    constrain_rect(input, edge, aspect),
                    input,
                    "aspect {aspect} / edge {edge} must not touch the rect"
                );
            }
        }
    }

    /// The mirrored constants are only as good as their values: pin them to the
    /// real Win32 ones so a typo cannot silently map an edge to the wrong axis.
    #[cfg(windows)]
    #[test]
    fn local_edges_match_win32() {
        use windows_sys::Win32::UI::WindowsAndMessaging as wam;
        assert_eq!(WMSZ_LEFT, wam::WMSZ_LEFT);
        assert_eq!(WMSZ_RIGHT, wam::WMSZ_RIGHT);
        assert_eq!(WMSZ_TOP, wam::WMSZ_TOP);
        assert_eq!(WMSZ_TOPLEFT, wam::WMSZ_TOPLEFT);
        assert_eq!(WMSZ_TOPRIGHT, wam::WMSZ_TOPRIGHT);
        assert_eq!(WMSZ_BOTTOM, wam::WMSZ_BOTTOM);
        assert_eq!(WMSZ_BOTTOMLEFT, wam::WMSZ_BOTTOMLEFT);
        assert_eq!(WMSZ_BOTTOMRIGHT, wam::WMSZ_BOTTOMRIGHT);
    }
}
