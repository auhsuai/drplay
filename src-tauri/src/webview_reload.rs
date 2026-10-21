//! Native WebView2 reload accelerator bridge (F5 / Ctrl+R).
//!
//! A JavaScript `keydown` + `preventDefault()` is not a reliable way to stop
//! WebView2's own browser accelerator: the refresh can be handled by the
//! browser independently of the page handler. That is how a reload used to
//! happen while the native mpv engine kept playing. The host-level
//! `CoreWebView2Controller.AcceleratorKeyPressed` event runs synchronously
//! before the accelerator is handled (windowed mode), and `SetHandled(true)`
//! suppresses the default refresh.
//!
//! The handler only turns the key into "the app must run its reload flow":
//! the ordered session-save + engine-shutdown + page-reload lives in
//! `src/player/reloadPlayer.ts` — ONE orchestration shared with the JS path.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use webview2_com::AcceleratorKeyPressedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2AcceleratorKeyPressedEventArgs, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_F5, VK_MENU};

const MAIN_WINDOW_LABEL: &str = "main";
/// Frontend event: run `requestPlayerReload()` now. The page owns the ordered
/// flow (save session -> await `mpv_shutdown` -> reload the WebView).
const RELOAD_REQUEST_EVENT: &str = "player-reload-requested";
/// `R` virtual-key code, used for Ctrl+R / Ctrl+Shift+R.
const VK_R: i32 = b'R' as i32;

/// Set while the accelerator handler is registered, so a second install can
/// never make one F5 drive two shutdown flows.
static INSTALLED: AtomicBool = AtomicBool::new(false);
/// WebView2 event token, needed to unsubscribe when the window goes away.
static TOKEN: Mutex<Option<i64>> = Mutex::new(None);

fn key_is_down(vk: i32) -> bool {
    // SAFETY: plain read of the calling thread's keyboard state; this runs on
    // the UI thread while the key event is being delivered.
    unsafe { GetKeyState(vk) < 0 }
}

/// The reload chords DrPlay owns: F5 (also Shift/Ctrl+F5) and Ctrl+R (also
/// Ctrl+Shift+R). Alt combinations stay with the OS.
fn is_reload_chord(args: &ICoreWebView2AcceleratorKeyPressedEventArgs) -> bool {
    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
    if unsafe { args.KeyEventKind(&mut kind) }.is_err() {
        return false;
    }
    if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
        && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
    {
        return false;
    }
    let mut virtual_key = 0u32;
    if unsafe { args.VirtualKey(&mut virtual_key) }.is_err() {
        return false;
    }
    if key_is_down(VK_MENU as i32) {
        return false;
    }
    if virtual_key == u32::from(VK_F5) {
        return true;
    }
    virtual_key == VK_R as u32 && key_is_down(VK_CONTROL as i32)
}

/// Auto-repeated key events must still be blocked (`Handled`) but must not
/// start a second reload request.
fn is_auto_repeat(args: &ICoreWebView2AcceleratorKeyPressedEventArgs) -> bool {
    let mut status = Default::default();
    match unsafe { args.PhysicalKeyStatus(&mut status) } {
        Ok(()) => status.RepeatCount > 1,
        Err(_) => false,
    }
}

/// Register the native accelerator handler on the main WebView2 controller.
/// Called once from `setup` on the UI thread, after the main window exists.
pub(crate) fn install(app: &tauri::AppHandle) {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        INSTALLED.store(false, Ordering::SeqCst);
        log::warn!("[reload] main WebView not found; F5 keeps the browser default");
        return;
    };
    let app_for_handler = app.clone();
    let dispatched = window.as_ref().with_webview(move |platform| {
        let controller = platform.controller();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
            move |_sender, args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>| {
                let Some(args) = args else {
                    return Ok(());
                };
                if !is_reload_chord(&args) {
                    return Ok(());
                }
                // Synchronous suppression: from here the ONLY refresh is the
                // app's ordered flow, never WebView2's own reload.
                if let Err(handled_error) = unsafe { args.SetHandled(true) } {
                    log::error!("[reload] cannot suppress the accelerator: {handled_error}");
                    return Ok(());
                }
                if !is_auto_repeat(&args) {
                    let _ = app_for_handler.emit(RELOAD_REQUEST_EVENT, ());
                }
                Ok(())
            },
        ));
        let mut token = 0i64;
        match unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) } {
            Ok(()) => {
                *TOKEN
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(token);
                log::info!("[reload] native F5/Ctrl+R accelerator handler installed");
            }
            Err(add_error) => {
                log::error!("[reload] cannot register the accelerator handler: {add_error}");
            }
        }
    });
    if let Err(dispatch_error) = dispatched {
        INSTALLED.store(false, Ordering::SeqCst);
        log::error!("[reload] cannot dispatch the accelerator registration: {dispatch_error}");
    }
}

/// Remove the handler before the WebView is destroyed. Safe to call when
/// nothing was installed; a removal failure is logged, never fatal.
pub(crate) fn uninstall(app: &tauri::AppHandle) {
    if !INSTALLED.swap(false, Ordering::SeqCst) {
        return;
    }
    let token = TOKEN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    let Some(token) = token else {
        return;
    };
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let dispatched = window.as_ref().with_webview(move |platform| {
        if let Err(remove_error) =
            unsafe { platform.controller().remove_AcceleratorKeyPressed(token) }
        {
            log::warn!("[reload] cannot remove the accelerator handler: {remove_error}");
        }
    });
    if let Err(dispatch_error) = dispatched {
        log::warn!("[reload] cannot dispatch the accelerator removal: {dispatch_error}");
    }
}
