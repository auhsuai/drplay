//! Native window lifecycle for the video host: class registration, the single
//! `HOST` slot, and the create/rect/visibility/destroy operations behind the
//! Tauri commands.

use std::sync::Mutex;

use tauri::Manager;
use windows_sys::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::CreateSolidBrush;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowLongPtrW, RegisterClassW,
    SetWindowPos, ShowWindow, GWL_STYLE, HWND_TOP, SWP_NOACTIVATE, SW_HIDE, SW_SHOW, WNDCLASSW,
    WNDPROC, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_VISIBLE,
};

use super::geometry::wide;
use super::input::restore_subclass;
use super::{
    ERROR_CLASS_ALREADY_EXISTS, HOST_BACKGROUND_COLOR, HOST_CLASS_NAME, MAIN_WINDOW_LABEL,
};

/// The one live host, as a raw handle value. `HWND` is a raw pointer, which is
/// `!Send`, and the Tauri command may be invoked from any thread; storing the
/// handle as an integer keeps this static `Sync` with no wrapper type.
pub(super) static HOST: Mutex<Option<usize>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Win32
// ---------------------------------------------------------------------------

/// The host does no custom window handling: it exists to be a client area mpv
/// can present into, and Windows must keep doing the show/move/resize work.
/// So every message goes straight to `DefWindowProcW`.
///
/// # Safety
/// Contractually an `extern "system"` WndProc: Windows guarantees `hwnd`,
/// `wparam` and `lparam` are passed through unchanged, and the body adds no
/// further requirement.
unsafe extern "system" fn host_wnd_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: forwarding to DefWindowProcW is exactly what a WndProc must do;
    // it is a plain user32 call that tolerates every message and argument pair.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

/// Hand the stored handle back to mpv's spawn path. Read-only on purpose: this
/// runs on a tokio worker, and a window must not be created there.
pub(crate) fn current_hwnd() -> Option<i64> {
    HOST.lock()
        .ok()
        .and_then(|slot| *slot)
        .filter(|hwnd| *hwnd != 0)
        .map(|hwnd| hwnd as i64)
}

/// Register a window class once per process. Re-registration is treated as
/// success (see `ERROR_CLASS_ALREADY_EXISTS`), so this is safe to call on
/// every acquire without any "already done" bookkeeping. `background: None`
/// asks for no class background brush.
fn register_class(
    class_name: &str,
    wndproc: WNDPROC,
    background: Option<COLORREF>,
) -> Result<HINSTANCE, String> {
    // SAFETY: a NULL module name asks for this process's own image handle; the
    // only failure is a null return, which is checked below.
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    if instance.is_null() {
        return Err(format!(
            "video host: GetModuleHandleW(NULL) failed (win32 error {})",
            // SAFETY: reads this thread's last-error value; no preconditions.
            unsafe { windows_sys::Win32::Foundation::GetLastError() }
        ));
    }
    let class = wide(class_name);
    let window_class = WNDCLASSW {
        style: 0,
        lpfnWndProc: wndproc,
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        // SAFETY: a plain gdi32 brush factory; the class background brush must
        // stay alive for the life of the class, which it does (it is never
        // deleted) — leaking one process-lifetime GDI object is the documented
        // contract for a class background.
        hbrBackground: match background {
            Some(color) => unsafe { CreateSolidBrush(color) },
            None => std::ptr::null_mut(),
        },
        lpszMenuName: std::ptr::null(),
        lpszClassName: class.as_ptr(),
    };
    // SAFETY: `window_class` is a fully initialized WNDCLASSW whose
    // `lpszClassName`/`lpszMenuName` point into `class`, which outlives this
    // call (Windows copies the strings during the call).
    let atom = unsafe { RegisterClassW(&window_class) };
    if atom == 0 {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        if error != ERROR_CLASS_ALREADY_EXISTS {
            return Err(format!(
                "video host: RegisterClassW({class_name}) failed (win32 error {error})"
            ));
        }
    }
    Ok(instance)
}

/// The host class: black background (see `HOST_BACKGROUND_COLOR`).
pub(super) fn register_host_class() -> Result<HINSTANCE, String> {
    register_class(
        HOST_CLASS_NAME,
        Some(host_wnd_proc),
        Some(HOST_BACKGROUND_COLOR),
    )
}

/// Create the hidden child window under `parent`. Never creates a popup and
/// never starts visible: the host exists from the start of the session but must
/// not paint or take a slot in the parent's z-order until a video actually plays.
fn create_child(parent: HWND) -> Result<usize, String> {
    let instance = register_host_class()?;
    let class = wide(HOST_CLASS_NAME);
    // WS_CHILD|WS_CLIPCHILDREN|WS_CLIPSIBLINGS, deliberately WITHOUT WS_VISIBLE
    // and WITHOUT WS_POPUP. WS_CLIPCHILDREN (the real name is the PLURAL; there
    // is no WS_CLIPCHILD) keeps this window from painting outside the parent's
    // client area, WS_CLIPSIBLINGS keeps siblings from bleeding into it.
    let style = WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
    // SAFETY: class/instance are valid for the duration of the call (Windows
    // copies the class name), `parent` is a live top-level window owned by this
    // process, and a null hmenu/lpparam is required for a child window.
    let child = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            std::ptr::null(),
            style,
            0,
            0,
            1,
            1,
            parent,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        )
    };
    if child.is_null() {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        return Err(format!(
            "video host: CreateWindowExW under parent {} failed (win32 error {error})",
            parent as usize
        ));
    }
    Ok(child as usize)
}

/// Idempotent acquire: return the existing host, or create it once.
///
/// The slot is the injectable half, so this exact function is what the unit test
/// drives against a throwaway parent window — the idempotency guarantee is
/// therefore tested in production code, not re-implemented for the test.
pub(super) fn ensure(slot: &Mutex<Option<usize>>, parent: HWND) -> Result<usize, String> {
    let mut guard = slot
        .lock()
        .map_err(|_| "video host: host slot mutex poisoned".to_string())?;
    if let Some(hwnd) = *guard {
        return Ok(hwnd);
    }
    let hwnd = create_child(parent)?;
    *guard = Some(hwnd);
    Ok(hwnd)
}

/// Move/resize the host inside the parent's client area and re-raise it, so a
/// native child stays above the WebView2 child window no matter when it moves.
pub(super) fn set_rect_raw(hwnd: HWND, x: i32, y: i32, width: i32, height: i32) -> bool {
    // SAFETY: `hwnd` is a live window we created (see `ensure`); HWND_TOP is the
    // documented "top of the z-order" sentinel and SWP_NOACTIVATE keeps focus
    // in the WebView, which is where the user's keystrokes must land.
    unsafe { SetWindowPos(hwnd, HWND_TOP, x, y, width, height, SWP_NOACTIVATE) != 0 }
}

/// The window's OWN `WS_VISIBLE` style bit, i.e. exactly what `ShowWindow`
/// toggles. Deliberately NOT `IsWindowVisible`, which also walks the ancestors:
/// a shown child of a hidden parent reports FALSE, which would make the
/// post-condition below wrong for any parent that is not itself visible.
pub(super) fn own_visible(hwnd: HWND) -> bool {
    // SAFETY: `GetWindowLongPtrW` is a plain style query on a live window.
    unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 & WS_VISIBLE != 0 }
}

/// Show or hide, and report whether the window ended up in the requested state.
///
/// `ShowWindow`'s BOOL is NOT a success flag: it is the window's PREVIOUS
/// visibility state (measured — hiding an already-hidden window returns FALSE),
/// so trusting it would log a spurious failure on every idempotent hide. The
/// post-condition is checked instead, which is also what "idempotent" means.
pub(super) fn set_visible_raw(hwnd: HWND, visible: bool) -> bool {
    // SAFETY: `hwnd` is a live window we created; SW_SHOW/SW_HIDE are the
    // documented commands and neither one is a no-arg hazard. The return value
    // is deliberately ignored (see above).
    unsafe { ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE }) };
    own_visible(hwnd) == visible
}

/// Restore the original WndProc, then destroy the host. Safe when nothing was
/// created (nothing to do), which is the normal path for an audio-only
/// session.
///
/// The subclass is undone FIRST: the pointer we installed belongs to this
/// module, and `restore_subclass` refuses to touch a window that is already
/// gone, so the host-then-mpv-child destruction order the engine implies cannot
/// turn into a write through a dead handle.
pub(crate) fn destroy() {
    restore_subclass();
    let Some(hwnd) = HOST.lock().ok().and_then(|mut slot| slot.take()) else {
        return;
    };
    // SAFETY: the handle came out of our own slot, so it is a window this
    // process created on this thread. DestroyWindow fails (rather than trapping)
    // if the handle is already invalid, which is why the result is only logged.
    if unsafe { DestroyWindow(hwnd as HWND) } == 0 {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        log::warn!("[video-host] DestroyWindow({hwnd}) failed (win32 error {error}); continuing");
    }
    log::info!("[video-host] destroyed host {hwnd}");
}

/// Resolve the main window's raw handle. Tauri returns
/// `windows::Win32::Foundation::HWND` (the `windows` crate's newtype) while
/// this module speaks `windows-sys`; both wrap the same `*mut c_void`, so the
/// newtype is unwrapped here at the single boundary. Shared with the in-process
/// engine dispatcher (player/mod.rs), which needs the same handle for the S3
/// DirectComposition target.
pub(crate) fn main_window_hwnd(app: &tauri::AppHandle) -> Result<HWND, String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| format!("window '{MAIN_WINDOW_LABEL}' not found"))?;
    window
        .hwnd()
        .map(|hwnd| hwnd.0)
        .map_err(|hwnd_error| format!("cannot resolve the main window HWND: {hwnd_error}"))
}
