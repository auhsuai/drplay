use super::*;
use windows_sys::Win32::Foundation::BOOL;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetClassNameW, GetParent, WM_LBUTTONDOWN, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_RBUTTONDOWN, WS_POPUP,
};

#[test]
fn wide_nul_terminates_the_utf16_encoding() {
    let encoded = wide("DrPlay");
    assert_eq!(
        &encoded[..6],
        &[
            b'D' as u16,
            b'r' as u16,
            b'P' as u16,
            b'l' as u16,
            b'a' as u16,
            b'y' as u16
        ]
    );
    assert_eq!(
        encoded.last(),
        Some(&0),
        "a Win32 string must be NUL terminated"
    );
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
    assert_eq!(
        clamp_rect(i64::MIN, i64::MIN, i64::MAX, i64::MAX),
        (0, 0, i32::MAX, i32::MAX)
    );
    assert_eq!(
        clamp_rect(i64::MAX, i64::MAX, 0, 0),
        (i32::MAX, i32::MAX, 0, 0)
    );
}

/// Count the children the OS actually knows about — the ground truth, not
/// our own bookkeeping: a second host would show up here even if the slot
/// were wrong.
fn child_count(parent: HWND) -> usize {
    extern "system" fn visit(_child: HWND, param: LPARAM) -> BOOL {
        // SAFETY: `param` is the `&mut usize` this function just created and
        // outlives the synchronous enumeration; the callback contract
        // requires exactly this cast.
        let count = unsafe { &mut *(param as *mut usize) };
        *count += 1;
        1
    }
    let mut count = 0usize;
    // SAFETY: enumerating a live window we created; the callback only
    // touches the counter borrowed by this stack frame.
    let ok =
        unsafe { EnumChildWindows(parent, Some(visit), (&mut count as *mut usize) as LPARAM) };
    assert_ne!(ok, 0, "EnumChildWindows must work on a live parent window");
    count
}

/// A hidden top-level window standing in for the Tauri main window, so the
/// real create/idempotency path runs in a test process with no app.
fn throwaway_parent() -> HWND {
    let instance =
        register_host_class().expect("the host class must register in a test process");
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
    assert!(
        !parent.is_null(),
        "the throwaway parent window must be creatable"
    );
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
    assert_eq!(
        child_count(parent),
        1,
        "the first acquire must create exactly one child"
    );

    let second = ensure(&slot, parent).expect("a second acquire must reuse the host");
    assert_eq!(
        first, second,
        "acquire must be idempotent: same HWND, never a second window"
    );
    assert_eq!(
        child_count(parent),
        1,
        "a second acquire must NOT create another child"
    );

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
    let class_len =
        unsafe { GetClassNameW(hwnd, class_buffer.as_mut_ptr(), class_buffer.len() as i32) };
    let class = String::from_utf16_lossy(&class_buffer[..class_len.max(0) as usize]);

    assert_eq!(
        parent_of_host, parent,
        "the host must be a child of the main window"
    );
    assert_eq!(style & WS_CHILD, WS_CHILD, "the host must carry WS_CHILD");
    assert_eq!(style & WS_POPUP, 0, "the host must never be a popup");
    assert_eq!(style & WS_VISIBLE, 0, "the host must start hidden");
    assert_eq!(
        style & (WS_CLIPCHILDREN | WS_CLIPSIBLINGS),
        WS_CLIPCHILDREN | WS_CLIPSIBLINGS
    );
    assert_eq!(class, HOST_CLASS_NAME);
    assert!(!own_visible(hwnd), "the host must not be visible yet");

    // SAFETY: destroying windows we created on this thread.
    unsafe { DestroyWindow(hwnd) };
    // SAFETY: destroying the throwaway parent.
    unsafe { DestroyWindow(parent) };
}

/// The right-button PRESS opens the context menu; every other mouse
/// message must stay with the previous WndProc.
#[test]
fn only_the_right_button_press_opens_the_context_menu() {
    assert!(
        is_context_menu_click(WM_RBUTTONDOWN),
        "WM_RBUTTONDOWN must open the menu"
    );
    assert!(
        !is_context_menu_click(WM_RBUTTONUP),
        "the release must emit nothing"
    );
    assert!(!is_context_menu_click(WM_LBUTTONDOWN));
    assert!(!is_context_menu_click(WM_MOUSEACTIVATE));
    assert!(!is_context_menu_click(WM_MOUSEMOVE));
}

/// The video must NEVER activate: React's keyboard shortcuts live in the
/// WebView, so a video that takes focus makes every shortcut dead. This is
/// the real window procedure, so it also proves the routing is what the
/// installed subclass does — `MA_NOACTIVATE` out, nothing forwarded.
#[test]
fn the_subclass_refuses_activation_and_swallows_the_right_button_release() {
    // SAFETY: a direct call into the installed WndProc with a live window
    // and plain message arguments; the procedure only reads them.
    let activate =
        unsafe { video_input_wnd_proc(std::ptr::null_mut(), WM_MOUSEACTIVATE, 0, 0) };
    assert_eq!(
        activate, MA_NOACTIVATE as LRESULT,
        "WM_MOUSEACTIVATE must return MA_NOACTIVATE"
    );

    // SAFETY: as above. WM_RBUTTONUP must be swallowed (0) so Windows cannot
    // synthesize the duplicate WM_CONTEXTMENU that would open a second menu.
    let release = unsafe { video_input_wnd_proc(std::ptr::null_mut(), WM_RBUTTONUP, 0, 0) };
    assert_eq!(
        release, 0,
        "WM_RBUTTONUP must be swallowed without emitting"
    );
}

/// ONE event per right-click: the press emits, the release does not. Counted
/// over the exact message sequence Windows sends for a right-click, so a
/// future "also handle the release" change cannot silently double the menu.
#[test]
fn a_right_click_emits_exactly_one_event() {
    let right_click_sequence = [WM_MOUSEMOVE, WM_RBUTTONDOWN, WM_MOUSEMOVE, WM_RBUTTONUP];
    let emitted = right_click_sequence
        .iter()
        .filter(|message| is_context_menu_click(**message))
        .count();
    assert_eq!(emitted, 1, "exactly one emit for exactly one right-click");
}

/// Mouse move, wheel and the left button must reach the previous procedure
/// untouched — mpv's own input handling, bit for bit.
#[test]
fn mouse_move_wheel_and_left_button_are_never_the_context_menu_click() {
    assert!(!is_context_menu_click(WM_MOUSEMOVE));
    assert!(!is_context_menu_click(WM_MOUSEWHEEL));
    assert!(!is_context_menu_click(WM_LBUTTONDOWN));
}

/// `lparam` carries SIGNED client coordinates; a right-click left of or
/// above the window must not come out as a ~65000 value.
#[test]
fn client_point_sign_extends_the_lparam_words() {
    let packed = ((-5i32 as u16 as u32) << 16) | (-7i32 as u16 as u32);
    let point = client_point(packed as LPARAM);
    assert_eq!(
        (point.x, point.y),
        (-7, -5),
        "negative client coordinates stay negative"
    );

    let packed = ((300i32 as u32) << 16) | 200u32;
    let point = client_point(packed as LPARAM);
    assert_eq!((point.x, point.y), (200, 300));
}

/// Client -> screen conversion, against the real API: the result must be the
/// window's absolute screen origin plus the client offset, NOT the raw client
/// point. `show_context_menu` anchors the popup at these numbers, so getting
/// this wrong puts the menu somewhere else on the screen entirely.
#[test]
fn screen_point_is_absolute_not_client_space() {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let parent = throwaway_parent();
    let origin = (120i32, 90i32);
    assert!(
        set_rect_raw(parent, origin.0, origin.1, 320, 180),
        "the throwaway window must move"
    );
    let slot: Mutex<Option<usize>> = Mutex::new(None);
    let child = ensure(&slot, parent).expect("the host must be creatable") as HWND;
    assert!(
        set_rect_raw(child, 10, 20, 100, 50),
        "the host must move inside it"
    );

    let mut window_rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: `child` is live and `window_rect` is a live local RECT.
    assert_ne!(
        unsafe { GetWindowRect(child, &mut window_rect) },
        0,
        "GetWindowRect must work"
    );

    let screen = screen_point(child, POINT { x: 5, y: 7 });
    assert_eq!(
        (screen.x, screen.y),
        (window_rect.left + 5, window_rect.top + 7),
        "ClientToScreen must offset by the window's screen origin"
    );
    assert_ne!(
        (screen.x, screen.y),
        (5, 7),
        "the result must not be the untouched client point"
    );

    // SAFETY: destroying windows we created on this thread.
    unsafe { DestroyWindow(child) };
    // SAFETY: destroying the throwaway parent.
    unsafe { DestroyWindow(parent) };
}

/// The subclass mechanism itself, against the real API: install swaps the
/// WndProc, a second install is a no-op, and the restore puts the original
/// back — which is what keeps teardown safe no matter the order windows die
/// in.
#[test]
fn installing_the_subclass_replaces_the_window_procedure_and_restores_it() {
    let parent = throwaway_parent();
    let slot: Mutex<Option<usize>> = Mutex::new(None);
    let hwnd = ensure(&slot, parent).expect("the host must be creatable") as HWND;

    // SAFETY: `hwnd` is live; GWLP_WNDPROC is a plain query.
    let original = unsafe { GetWindowLongPtrW(hwnd, GWLP_WNDPROC) };
    assert_ne!(
        original, 0,
        "a live window always reports a window procedure"
    );

    install_subclass(hwnd).expect("the subclass must install");
    // SAFETY: `hwnd` is live; GWLP_WNDPROC is a plain query.
    assert_eq!(
        unsafe { GetWindowLongPtrW(hwnd, GWLP_WNDPROC) } as usize,
        video_input_wnd_proc as *const () as usize,
        "GWLP_WNDPROC must now be our procedure"
    );
    // SAFETY: `hwnd` is live.
    assert_eq!(
        unsafe { GetWindowLongPtrW(hwnd, GWLP_WNDPROC) } as usize,
        video_input_wnd_proc as *const () as usize,
        "our procedure is installed"
    );

    install_subclass(hwnd).expect("a repeated install must not fail");
    restore_subclass();
    // SAFETY: `hwnd` is live; GWLP_WNDPROC is a plain query.
    assert_eq!(
        unsafe { GetWindowLongPtrW(hwnd, GWLP_WNDPROC) } as usize,
        original as usize,
        "the original procedure must be back"
    );
    // Second restore: the slot is empty, so this must not touch the window.
    restore_subclass();
    // SAFETY: `hwnd` is live; GWLP_WNDPROC is a plain query.
    assert_eq!(
        unsafe { GetWindowLongPtrW(hwnd, GWLP_WNDPROC) } as usize,
        original as usize,
        "a repeated restore must be a no-op"
    );

    // SAFETY: destroying windows we created on this thread.
    unsafe { DestroyWindow(hwnd) };
    // SAFETY: destroying the throwaway parent.
    unsafe { DestroyWindow(parent) };
}

/// mpv's child is discovered once it exists; before that the host has no
/// child at all and the fallback must be the host itself. Asserted on the
/// real window tree so the discovery cannot silently start matching the
/// wrong window, and together with the ownership probe that decides whether
/// a discovered window may be subclassed at all.
#[test]
fn the_mpv_child_is_discovered_only_once_it_exists() {
    let parent = throwaway_parent();
    let slot: Mutex<Option<usize>> = Mutex::new(None);
    let host = ensure(&slot, parent).expect("the host must be creatable") as HWND;
    assert!(
        mpv_child(host).is_none(),
        "a host with no children has no mpv child"
    );

    let nested: Mutex<Option<usize>> = Mutex::new(None);
    let child = ensure(&nested, host).expect("the nested window must be creatable") as HWND;
    assert_eq!(
        mpv_child(host),
        Some(child),
        "the created child must be discovered"
    );
    assert_eq!(
        window_process(child),
        Some(std::process::id()),
        "a window this process created is ours to subclass"
    );

    // SAFETY: destroying windows we created on this thread.
    unsafe { DestroyWindow(child) };
    // SAFETY: destroying windows we created on this thread.
    unsafe { DestroyWindow(host) };
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

    assert!(
        set_visible_raw(hwnd, false),
        "hiding an already-hidden host must succeed"
    );
    assert!(
        set_visible_raw(hwnd, false),
        "hiding twice must be idempotent"
    );
    assert!(!own_visible(hwnd));

    assert!(set_visible_raw(hwnd, true), "showing the host must succeed");
    assert!(
        set_visible_raw(hwnd, true),
        "showing twice must be idempotent"
    );
    assert!(own_visible(hwnd), "a shown host must carry WS_VISIBLE");

    assert!(
        set_visible_raw(hwnd, false),
        "hiding a shown host must succeed"
    );
    assert!(!own_visible(hwnd), "a hidden host must drop WS_VISIBLE");

    assert!(
        set_rect_raw(hwnd, 4, 8, 320, 180),
        "the rect must be applied"
    );
    assert!(
        set_rect_raw(hwnd, 0, 0, 0, 0),
        "a collapsed rect must not fail"
    );

    // SAFETY: destroying windows we created on this thread.
    unsafe { DestroyWindow(hwnd) };
    // SAFETY: destroying the throwaway parent.
    unsafe { DestroyWindow(parent) };
}
