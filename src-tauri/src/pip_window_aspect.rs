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
//! Layout: `geometry` holds the pure rectangle math (`constrain_rect`, with no
//! Win32 types, so it is unit-testable without a window) and `win32` owns the
//! subclass, its statics and `install`/`restore`. This file re-exports the two
//! entry points and carries the non-Windows stubs the crate builds against.

/// The pure rectangle math, compiled only where it is used (Windows) or tested.
#[cfg(any(windows, test))]
mod geometry;

#[cfg(windows)]
mod win32;

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
