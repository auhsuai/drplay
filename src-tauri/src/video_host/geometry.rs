//! Pure geometry helpers for the native video host: Win32 UTF-16 encoding and
//! the client/screen coordinate conversions. Nothing here touches a static.

use windows_sys::Win32::Foundation::{HWND, LPARAM, POINT};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without a window)
// ---------------------------------------------------------------------------

/// NUL-terminated UTF-16 for the Win32 `*W` entry points. The terminator is
/// what makes the pointer safe to hand to `RegisterClassW`/`CreateWindowExW`.
/// Shared with `context_menu` (same `*W` contract).
pub(crate) fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The rect the frontend hands us is PHYSICAL pixels relative to the parent
/// window's client area (React's `getBoundingClientRect`, unscaled by us).
/// Clamp to what `SetWindowPos` can express (`i32`) and keep the size
/// non-negative: a negative width is not a meaningful window, and a minimized
/// window legitimately reports a zero-sized rect. Also reused by the libmpv
/// surface path (player/mod.rs), where the same contract holds.
pub(crate) fn clamp_rect(x: i64, y: i64, w: i64, h: i64) -> (i32, i32, i32, i32) {
    let fit = |value: i64| value.clamp(0, i32::MAX as i64) as i32;
    (fit(x), fit(y), fit(w), fit(h))
}

/// The signed client coordinates a mouse message carries in `lparam`
/// (GET_X_LPARAM / GET_Y_LPARAM: the low/high 16-bit words, sign extended).
/// Pure, so the sign handling — the part that silently breaks left of / above
/// the screen origin — is unit tested.
pub(super) fn client_point(lparam: LPARAM) -> POINT {
    POINT {
        x: (lparam as u32 & 0xFFFF) as u16 as i16 as i32,
        y: ((lparam as u32 >> 16) & 0xFFFF) as u16 as i16 as i32,
    }
}

/// Client coordinates -> absolute physical screen pixels, which is what the
/// native menu command (`show_context_menu`) expects. On failure the client
/// point is returned unchanged and the reason logged: a wrong anchor position
/// is a cosmetic bug, never a reason to drop the menu.
pub(super) fn screen_point(hwnd: HWND, client: POINT) -> POINT {
    let mut point = client;
    // SAFETY: `hwnd` is the live window the message was dispatched to and
    // `point` is a live local POINT, which is what ClientToScreen writes.
    if unsafe { ClientToScreen(hwnd, &mut point) } == 0 {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        log::warn!(
            "[video-input] ClientToScreen({}) failed (win32 error {error}); anchoring at the client coordinates",
            hwnd as usize
        );
    }
    point
}
