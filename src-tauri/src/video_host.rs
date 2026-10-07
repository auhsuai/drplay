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
//! Every Win32 call that can fail returns `Err`/`false` and is logged with
//! context. Nothing here panics: a missing video host degrades to mpv's own
//! window, which is the pre-slice behavior.

use std::sync::Mutex;

use tauri::Manager;
use windows_sys::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::CreateSolidBrush;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowLongPtrW, RegisterClassW, SetWindowPos,
    ShowWindow, WNDCLASSW, GWL_STYLE, HWND_TOP, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE, SW_HIDE,
    SW_SHOW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_VISIBLE,
};

/// Label of the one Tauri window the host is parented to.
const MAIN_WINDOW_LABEL: &str = "main";

/// Window class name. Own class (not a built-in one like "STATIC") so the WndProc
/// and the class background are stated here instead of inherited from a class
/// whose behavior we do not control.
const HOST_CLASS_NAME: &str = "DrPlayVideoHost";

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

/// The one live host, as a raw handle value. `HWND` is a raw pointer, which is
/// `!Send`, and the Tauri command may be invoked from any thread; storing the
/// handle as an integer keeps this static `Sync` with no wrapper type.
static HOST: Mutex<Option<usize>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without a window)
// ---------------------------------------------------------------------------

/// NUL-terminated UTF-16 for the Win32 `*W` entry points. The terminator is
/// what makes the pointer safe to hand to `RegisterClassW`/`CreateWindowExW`.
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The rect the frontend hands us is PHYSICAL pixels relative to the parent
/// window's client area (React's `getBoundingClientRect`, unscaled by us).
/// Clamp to what `SetWindowPos` can express (`i32`) and keep the size
/// non-negative: a negative width is not a meaningful window, and a minimized
/// window legitimately reports a zero-sized rect.
fn clamp_rect(x: i64, y: i64, w: i64, h: i64) -> (i32, i32, i32, i32) {
    let fit = |value: i64| value.clamp(0, i32::MAX as i64) as i32;
    (fit(x), fit(y), fit(w), fit(h))
}

/// Hand the stored handle back to mpv's spawn path. Read-only on purpose: this
/// runs on a tokio worker, and a window must not be created there.
pub(crate) fn current_hwnd() -> Option<i64> {
    HOST
        .lock()
        .ok()
        .and_then(|slot| *slot)
        .filter(|hwnd| *hwnd != 0)
        .map(|hwnd| hwnd as i64)
}

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
unsafe extern "system" fn host_wnd_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // SAFETY: forwarding to DefWindowProcW is exactly what a WndProc must do;
    // it is a plain user32 call that tolerates every message and argument pair.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

/// Register the host window class once per process. Re-registration is treated
/// as success (see `ERROR_CLASS_ALREADY_EXISTS`), so this is safe to call on
/// every acquire without any "already done" bookkeeping.
fn register_host_class() -> Result<HINSTANCE, String> {
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
    let class = wide(HOST_CLASS_NAME);
    let window_class = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(host_wnd_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        // SAFETY: a plain gdi32 brush factory; the class background brush must
        // stay alive for the life of the class, which it does (it is never
        // deleted) — leaking one process-lifetime GDI object is the documented
        // contract for a class background.
        hbrBackground: unsafe { CreateSolidBrush(HOST_BACKGROUND_COLOR) },
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
            return Err(format!("video host: RegisterClassW({HOST_CLASS_NAME}) failed (win32 error {error})"));
        }
    }
    Ok(instance)
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
fn ensure(slot: &Mutex<Option<usize>>, parent: HWND) -> Result<usize, String> {
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
fn set_rect_raw(hwnd: HWND, x: i32, y: i32, width: i32, height: i32) -> bool {
    // SAFETY: `hwnd` is a live window we created (see `ensure`); HWND_TOP is the
    // documented "top of the z-order" sentinel and SWP_NOACTIVATE keeps focus
    // in the WebView, which is where the user's keystrokes must land.
    unsafe { SetWindowPos(hwnd, HWND_TOP, x, y, width, height, SWP_NOACTIVATE) != 0 }
}

/// The window's OWN `WS_VISIBLE` style bit, i.e. exactly what `ShowWindow`
/// toggles. Deliberately NOT `IsWindowVisible`, which also walks the ancestors:
/// a shown child of a hidden parent reports FALSE, which would make the
/// post-condition below wrong for any parent that is not itself visible.
fn own_visible(hwnd: HWND) -> bool {
    // SAFETY: `GetWindowLongPtrW` is a plain style query on a live window.
    unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 & WS_VISIBLE != 0 }
}

/// Show or hide, and report whether the window ended up in the requested state.
///
/// `ShowWindow`'s BOOL is NOT a success flag: it is the window's PREVIOUS
/// visibility state (measured — hiding an already-hidden window returns FALSE),
/// so trusting it would log a spurious failure on every idempotent hide. The
/// post-condition is checked instead, which is also what "idempotent" means.
fn set_visible_raw(hwnd: HWND, visible: bool) -> bool {
    // SAFETY: `hwnd` is a live window we created; SW_SHOW/SW_HIDE are the
    // documented commands and neither one is a no-arg hazard. The return value
    // is deliberately ignored (see above).
    unsafe { ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE }) };
    own_visible(hwnd) == visible
}

/// Destroy the host. Safe when it was never created (nothing to do), which is
/// the normal path for an audio-only session.
pub(crate) fn destroy() {
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

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Create the child host if needed and return its HWND as an i64, or 0 on
/// failure. A second call returns the SAME handle: exactly one host per app
/// session, so mpv's render target never moves under a running video.
#[tauri::command]
pub fn video_host_acquire(app: tauri::AppHandle) -> i64 {
    if let Some(existing) = current_hwnd() {
        return existing;
    }
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        log::error!("[video-host] cannot acquire: window '{MAIN_WINDOW_LABEL}' not found");
        return 0;
    };
    // The repo's existing native-window path (src/media_controls.rs::init).
    // Tauri returns `windows::Win32::Foundation::HWND` (the `windows` crate's
    // newtype) while this module speaks `windows-sys`; both wrap the same
    // `*mut c_void`, so unwrap it here at the single boundary.
    let parent = match window.hwnd() {
        Ok(hwnd) => hwnd.0,
        Err(hwnd_error) => {
            log::error!("[video-host] cannot acquire: cannot resolve the main window HWND: {hwnd_error}");
            return 0;
        }
    };
    match ensure(&HOST, parent) {
        Ok(hwnd) => {
            log::info!("[video-host] acquired host {hwnd} under main window {}", parent as usize);
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
#[tauri::command]
pub fn video_host_set_visible(visible: bool) {
    let Some(hwnd) = current_hwnd() else {
        log::debug!("[video-host] set_visible({visible}) ignored: no host acquired");
        return;
    };
    if visible {
        // A hidden child loses its place in the parent's z-order, and the
        // WebView2 child would paint over it again, so re-raise on show.
        // SAFETY: `hwnd` is live and owned by this process.
        if unsafe { SetWindowPos(hwnd as HWND, HWND_TOP, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE) } == 0 {
            // SAFETY: reading this thread's last-error value; no preconditions.
            let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            log::warn!("[video-host] re-raise of {hwnd} failed (win32 error {error})");
        }
    }
    if !set_visible_raw(hwnd as HWND, visible) {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        log::warn!("[video-host] ShowWindow({hwnd}, visible={visible}) failed (win32 error {error})");
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::BOOL;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, GetParent, WS_POPUP,
    };

    #[test]
    fn wide_nul_terminates_the_utf16_encoding() {
        let encoded = wide("DrPlay");
        assert_eq!(
            &encoded[..6],
            &[b'D' as u16, b'r' as u16, b'P' as u16, b'l' as u16, b'a' as u16, b'y' as u16]
        );
        assert_eq!(encoded.last(), Some(&0), "a Win32 string must be NUL terminated");
        assert_eq!(encoded.len(), 7, "6 chars + the terminator");
    }

    #[test]
    fn clamp_rect_keeps_a_valid_rect_untouched() {
        assert_eq!(clamp_rect(12, 34, 640, 360), (12, 34, 640, 360));
    }

    #[test]
    fn clamp_rect_rejects_a_negative_size_and_overflowing_coordinates() {
        // React can report a collapsed rect while a modal is animating; a
        // negative width is not a window, and SetWindowPos takes i32.
        assert_eq!(clamp_rect(10, 20, -5, -1), (10, 20, 0, 0));
        assert_eq!(clamp_rect(i64::MIN, i64::MIN, i64::MAX, i64::MAX), (0, 0, i32::MAX, i32::MAX));
        assert_eq!(clamp_rect(i64::MAX, i64::MAX, 0, 0), (i32::MAX, i32::MAX, 0, 0));
    }

    /// Count the children the OS actually knows about — the ground truth, not
    /// our own bookkeeping: a second host would show up here even if the slot
    /// were wrong.
    fn child_count(parent: HWND) -> usize {
        extern "system" fn visit(_child: HWND, param: LPARAM) -> BOOL {
            // SAFETY: `param` is the `&mut usize` this function just created and
            // outlives the synchronous enumeration; the callback contract
            // requires exactly this cast.
            let count = unsafe { &mut *((param as *mut usize)) };
            *count += 1;
            1
        }
        let mut count = 0usize;
        // SAFETY: enumerating a live window we created; the callback only
        // touches the counter borrowed by this stack frame.
        let ok = unsafe { EnumChildWindows(parent, Some(visit), (&mut count as *mut usize) as LPARAM) };
        assert_ne!(ok, 0, "EnumChildWindows must work on a live parent window");
        count
    }

    /// A hidden top-level window standing in for the Tauri main window, so the
    /// real create/idempotency path runs in a test process with no app.
    fn throwaway_parent() -> HWND {
        let instance = register_host_class().expect("the host class must register in a test process");
        let class = wide(HOST_CLASS_NAME);
        // SAFETY: same invariants as `create_child`, with WS_POPUP instead of
        // WS_CHILD so the throwaway window is a valid parent.
        let parent = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                0,
                0,
                8,
                8,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            )
        };
        assert!(!parent.is_null(), "the throwaway parent window must be creatable");
        parent
    }

    /// The idempotency contract, exercised against the real Win32 API: calling
    /// acquire twice must hand back the SAME handle and leave exactly one child
    /// window under the parent.
    #[test]
    fn ensure_creates_exactly_one_child_and_is_idempotent() {
        let parent = throwaway_parent();
        let slot: Mutex<Option<usize>> = Mutex::new(None);

        let first = ensure(&slot, parent).expect("the first acquire must create the host");
        assert_ne!(first, 0, "a created host is never a null handle");
        assert_eq!(child_count(parent), 1, "the first acquire must create exactly one child");

        let second = ensure(&slot, parent).expect("a second acquire must reuse the host");
        assert_eq!(first, second, "acquire must be idempotent: same HWND, never a second window");
        assert_eq!(child_count(parent), 1, "a second acquire must NOT create another child");

        // SAFETY: destroying a window we created on this thread.
        unsafe { DestroyWindow(first as HWND) };
        // SAFETY: destroying the throwaway parent, now childless.
        unsafe { DestroyWindow(parent) };
    }

    /// The host must start hidden and child-styled: a popup would escape the
    /// main window, a visible-at-birth host would paint before any video loads.
    #[test]
    fn the_created_host_is_a_hidden_child_window() {
        let parent = throwaway_parent();
        let slot: Mutex<Option<usize>> = Mutex::new(None);
        let hwnd = ensure(&slot, parent).expect("the host must be creatable") as HWND;

        // SAFETY: `hwnd` is live; GetParent/GetWindowLongPtrW/GetClassNameW are
        // plain queries that tolerate any live window handle.
        let parent_of_host = unsafe { GetParent(hwnd) };
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32;
        let mut class_buffer = [0u16; 64];
        // SAFETY: the buffer is 64 units, which is passed as the capacity.
        let class_len = unsafe { GetClassNameW(hwnd, class_buffer.as_mut_ptr(), class_buffer.len() as i32) };
        let class = String::from_utf16_lossy(&class_buffer[..class_len.max(0) as usize]);

        assert_eq!(parent_of_host, parent, "the host must be a child of the main window");
        assert_eq!(style & WS_CHILD, WS_CHILD, "the host must carry WS_CHILD");
        assert_eq!(style & WS_POPUP, 0, "the host must never be a popup");
        assert_eq!(style & WS_VISIBLE, 0, "the host must start hidden");
        assert_eq!(style & (WS_CLIPCHILDREN | WS_CLIPSIBLINGS), WS_CLIPCHILDREN | WS_CLIPSIBLINGS);
        assert_eq!(class, HOST_CLASS_NAME);
        assert!(!own_visible(hwnd), "the host must not be visible yet");

        // SAFETY: destroying windows we created on this thread.
        unsafe { DestroyWindow(hwnd) };
        // SAFETY: destroying the throwaway parent.
        unsafe { DestroyWindow(parent) };
    }

    /// Hiding is idempotent and showing really shows — the two halves of the
    /// release/show cycle the audio<->video switch depends on.
    #[test]
    fn visibility_toggles_and_stays_put_when_repeated() {
        let parent = throwaway_parent();
        let slot: Mutex<Option<usize>> = Mutex::new(None);
        let hwnd = ensure(&slot, parent).expect("the host must be creatable") as HWND;

        assert!(set_visible_raw(hwnd, false), "hiding an already-hidden host must succeed");
        assert!(set_visible_raw(hwnd, false), "hiding twice must be idempotent");
        assert!(!own_visible(hwnd));

        assert!(set_visible_raw(hwnd, true), "showing the host must succeed");
        assert!(set_visible_raw(hwnd, true), "showing twice must be idempotent");
        assert!(own_visible(hwnd), "a shown host must carry WS_VISIBLE");

        assert!(set_visible_raw(hwnd, false), "hiding a shown host must succeed");
        assert!(!own_visible(hwnd), "a hidden host must drop WS_VISIBLE");

        assert!(set_rect_raw(hwnd, 4, 8, 320, 180), "the rect must be applied");
        assert!(set_rect_raw(hwnd, 0, 0, 0, 0), "a collapsed rect must not fail");

        // SAFETY: destroying windows we created on this thread.
        unsafe { DestroyWindow(hwnd) };
        // SAFETY: destroying the throwaway parent.
        unsafe { DestroyWindow(parent) };
    }
}