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

use std::sync::Mutex;

use tauri::{Emitter, Manager};
use windows_sys::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{ClientToScreen, CreateSolidBrush};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, CreateWindowExW, DefWindowProcW, DestroyWindow, FindWindowExW, GetWindow,
    GetWindowLongPtrW, GetWindowThreadProcessId, IsWindow, RegisterClassW, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, GWLP_WNDPROC, GWL_STYLE, GW_CHILD, HWND_TOP, MA_NOACTIVATE,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOW, WM_MOUSEACTIVATE, WM_RBUTTONDOWN,
    WM_RBUTTONUP, WNDCLASSW, WNDPROC, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_VISIBLE,
};

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

/// The one live host, as a raw handle value. `HWND` is a raw pointer, which is
/// `!Send`, and the Tauri command may be invoked from any thread; storing the
/// handle as an integer keeps this static `Sync` with no wrapper type.
static HOST: Mutex<Option<usize>> = Mutex::new(None);

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

/// Hand the stored handle back to mpv's spawn path. Read-only on purpose: this
/// runs on a tokio worker, and a window must not be created there.
pub(crate) fn current_hwnd() -> Option<i64> {
    HOST.lock()
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

/// Only the right-button PRESS opens the context menu — a press, not a
/// release, so the menu opens the instant the button goes down instead of one
/// frame late. `WM_RBUTTONUP` is deliberately NOT the trigger (see
/// `video_input_wnd_proc`).
fn is_context_menu_click(message: u32) -> bool {
    message == WM_RBUTTONDOWN
}

/// The signed client coordinates a mouse message carries in `lparam`
/// (GET_X_LPARAM / GET_Y_LPARAM: the low/high 16-bit words, sign extended).
/// Pure, so the sign handling — the part that silently breaks left of / above
/// the screen origin — is unit tested.
fn client_point(lparam: LPARAM) -> POINT {
    POINT {
        x: (lparam as u32 & 0xFFFF) as u16 as i16 as i32,
        y: ((lparam as u32 >> 16) & 0xFFFF) as u16 as i16 as i32,
    }
}

/// Client coordinates -> absolute physical screen pixels, which is what the
/// native menu command (`show_context_menu`) expects. On failure the client
/// point is returned unchanged and the reason logged: a wrong anchor position
/// is a cosmetic bug, never a reason to drop the menu.
fn screen_point(hwnd: HWND, client: POINT) -> POINT {
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
unsafe extern "system" fn video_input_wnd_proc(
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
fn install_subclass(hwnd: HWND) -> Result<(), String> {
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
fn restore_subclass() {
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
fn focus_webview(parent: HWND) {
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
fn register_host_class() -> Result<HINSTANCE, String> {
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

/// mpv's own child window inside the host, once it exists. mpv creates it
/// asynchronously when it attaches to `--wid`, so this returns `None` until
/// then — the caller polls.
fn mpv_child(host: HWND) -> Option<HWND> {
    // SAFETY: `host` is a live window; GW_CHILD asks for its first child
    // window, and a null result simply means mpv has not attached yet.
    let child = unsafe { GetWindow(host, GW_CHILD) };
    (!child.is_null()).then_some(child)
}

/// The process that owns `hwnd`, or `None` when the query fails.
fn window_process(hwnd: HWND) -> Option<u32> {
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
fn attach_input_subclass(host: HWND) {
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

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

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
        if SUBCLASS.lock().map(|slot| slot.is_none()).unwrap_or(true) {
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
