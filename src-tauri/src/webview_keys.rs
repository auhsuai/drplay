//! Native WebView2 keyboard policy: browser accelerators + the app's own
//! reload chord.
//!
//! WebView2 behaves like a browser unless the host says otherwise: Ctrl+P
//! opens the print dialog, Ctrl+F/F3 the find bar, Ctrl+R/F5 reload,
//! Ctrl+=/-/0 zoom, F12/Ctrl+Shift+I open DevTools and Alt+Left/Right walk
//! the webview history. A JavaScript `keydown` + `preventDefault()` is not a
//! reliable defence: WebView2 can consume an accelerator before the page
//! sees it.
//!
//! Two levers are used, in this order:
//! - `ICoreWebView2Settings3::SetAreBrowserAcceleratorKeysEnabled(false)`
//!   turns off the whole browser-accelerator set (Microsoft's spec:
//!   <https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/AreBrowserAcceleratorKeysEnabled.md>).
//!   The key STILL reaches the page, so every app shortcut and every text
//!   editing key keeps working.
//! - `ICoreWebView2AcceleratorKeyPressedEventArgs2::SetIsBrowserAcceleratorKeyEnabled(false)`
//!   is the per-key lever for chords Microsoft does not list (Ctrl+U /
//!   view-source). It skips the browser feature and keeps the key in the
//!   page.
//!
//! `SetHandled(true)` is used for ONE chord only: the app's own reload
//! (a plain F5), which must run DrPlay's ordered reload flow instead of the
//! browser's refresh. That flow lives in `src/player/reloadPlayer.ts` — ONE
//! orchestration shared with the JS path.
//!
//! Every other variant (Shift+F5, Ctrl+F5, Ctrl+R, Ctrl+Shift+R) is NOT a
//! reload: the browser accelerator set is off, so those chords do nothing at
//! all. F5 alone is the app's refresh key.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use webview2_com::AcceleratorKeyPressedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2AcceleratorKeyPressedEventArgs, ICoreWebView2AcceleratorKeyPressedEventArgs2,
    ICoreWebView2Controller, ICoreWebView2Settings3, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
};
use windows_core::Interface;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, VK_CONTROL, VK_F5, VK_F12, VK_MENU, VK_SHIFT,
};

const MAIN_WINDOW_LABEL: &str = "main";
/// Frontend event: run `requestPlayerReload()` now. The page owns the ordered
/// flow (save session -> await `mpv_shutdown` -> reload the WebView).
const RELOAD_REQUEST_EVENT: &str = "player-reload-requested";
/// `U` virtual-key code, used for Ctrl+U (view source).
const VK_U: u32 = b'U' as u32;
/// `I` virtual-key code, used for Ctrl+Shift+I (DevTools).
const VK_I: u32 = b'I' as u32;
/// `J` virtual-key code, used for Ctrl+Shift+J (DevTools).
const VK_J: u32 = b'J' as u32;

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

/// What DrPlay does with one accelerator chord.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chord {
    /// The app's own reload flow (a plain F5): swallow the key and ask the
    /// frontend to run the ordered reload.
    Reload,
    /// DevTools chord (F12 / Ctrl+Shift+I / Ctrl+Shift+J): re-enable the
    /// browser feature for THIS key only (debug builds).
    DevTools,
    /// Ctrl+U (view source): skip the browser feature for THIS key only.
    ViewSource,
    /// Everything else: the page keeps the key, untouched.
    Passthrough,
}

/// Classify one accelerator chord. Pure: no COM, no keyboard state, so the
/// policy is unit-testable.
///
/// Order matters: Alt belongs to the OS, F5 is the app's reload before it is
/// the browser's, F12 is DevTools before the browser's zoom family, and only
/// then does Ctrl+U become "view source".
fn classify_chord(vk: u32, ctrl: bool, alt: bool, shift: bool) -> Chord {
    // Alt belongs to the OS (the app's own Ctrl+Alt+audio-delay chord and
    // Alt+Left/Right must not be touched here).
    if alt {
        return Chord::Passthrough;
    }
    // Plain F5 is the app's reload, not the browser's. Every variant
    // (Shift+F5, Ctrl+F5, Ctrl+R) is deliberately NOT a reload: the browser
    // accelerator set is off, so those chords do nothing at all.
    if vk == VK_F5 as u32 && !ctrl && !shift {
        return Chord::Reload;
    }
    // F12 opens DevTools.
    if vk == VK_F12 as u32 {
        return Chord::DevTools;
    }
    // Ctrl+Shift+I / Ctrl+Shift+J open DevTools.
    if ctrl && shift && (vk == VK_I || vk == VK_J) {
        return Chord::DevTools;
    }
    // Ctrl+U is view-source: not on Microsoft's off-list, so it needs the
    // per-key lever.
    if ctrl && vk == VK_U {
        return Chord::ViewSource;
    }
    Chord::Passthrough
}

/// The chord of the current accelerator event, or `None` when the event is
/// not a key press we act on.
fn chord_of(args: &ICoreWebView2AcceleratorKeyPressedEventArgs) -> Option<Chord> {
    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
    if unsafe { args.KeyEventKind(&mut kind) }.is_err() {
        return None;
    }
    if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
        && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
    {
        return None;
    }
    let mut virtual_key = 0u32;
    if unsafe { args.VirtualKey(&mut virtual_key) }.is_err() {
        return None;
    }
    Some(classify_chord(
        virtual_key,
        key_is_down(VK_CONTROL as i32),
        key_is_down(VK_MENU as i32),
        key_is_down(VK_SHIFT as i32),
    ))
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

/// Apply the per-key browser-accelerator lever to the current event. The key
/// keeps reaching the page; only the browser feature behind it is skipped.
/// A missing interface or a failed call is logged, never fatal.
fn set_browser_accelerator_key_enabled(
    args: &ICoreWebView2AcceleratorKeyPressedEventArgs,
    enabled: bool,
    chord: &str,
) {
    match args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>() {
        Ok(args2) => {
            if let Err(set_error) = unsafe { args2.SetIsBrowserAcceleratorKeyEnabled(enabled) } {
                log::warn!(
                    "[keys] {chord}: cannot set the per-key browser accelerator flag: {set_error}"
                );
            }
        }
        Err(cast_error) => {
            log::warn!(
                "[keys] {chord}: cast to ICoreWebView2AcceleratorKeyPressedEventArgs2 failed: {cast_error}"
            );
        }
    }
}

/// Turn off the WebView2 browser accelerator set (print, find, zoom,
/// DevTools, history, ...). The keys still reach the page, so the app's own
/// shortcuts and every text-editing key keep working.
fn disable_browser_accelerator_keys(controller: &ICoreWebView2Controller) {
    let core = match unsafe { controller.CoreWebView2() } {
        Ok(core) => core,
        Err(core_error) => {
            log::warn!(
                "[keys] CoreWebView2() failed: {core_error}; browser accelerator keys stay enabled"
            );
            return;
        }
    };
    let settings = match unsafe { core.Settings() } {
        Ok(settings) => settings,
        Err(settings_error) => {
            log::warn!(
                "[keys] CoreWebView2.Settings() failed: {settings_error}; browser accelerator keys stay enabled"
            );
            return;
        }
    };
    let settings3 = match settings.cast::<ICoreWebView2Settings3>() {
        Ok(settings3) => settings3,
        Err(cast_error) => {
            log::warn!(
                "[keys] cast to ICoreWebView2Settings3 failed: {cast_error}; browser accelerator keys stay enabled"
            );
            return;
        }
    };
    if let Err(set_error) = unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(false) } {
        log::warn!(
            "[keys] SetAreBrowserAcceleratorKeysEnabled(false) failed: {set_error}; browser accelerator keys stay enabled"
        );
        return;
    }
    let mut enabled = windows_core::BOOL::default();
    match unsafe { settings3.AreBrowserAcceleratorKeysEnabled(&mut enabled) } {
        Ok(()) => log::info!(
            "[keys] browser accelerator keys disabled (readback={})",
            enabled.0
        ),
        Err(read_error) => log::warn!(
            "[keys] browser accelerator keys disabled but the readback failed: {read_error}"
        ),
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
        log::warn!("[keys] main WebView not found; browser accelerator keys stay enabled");
        return;
    };
    let app_for_handler = app.clone();
    let dispatched = window.as_ref().with_webview(move |platform| {
        let controller = platform.controller();
        // Global switch first: the browser accelerator set is off for every
        // chord, the page still receives all of them.
        disable_browser_accelerator_keys(&controller);
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
            move |_sender, args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>| {
                let Some(args) = args else {
                    return Ok(());
                };
                match chord_of(&args) {
                    Some(Chord::Reload) => {
                        // Synchronous suppression: from here the ONLY refresh is
                        // the app's ordered flow, never WebView2's own reload.
                        if let Err(handled_error) = unsafe { args.SetHandled(true) } {
                            log::error!("[keys] cannot suppress the reload accelerator: {handled_error}");
                            return Ok(());
                        }
                        if !is_auto_repeat(&args) {
                            let _ = app_for_handler.emit(RELOAD_REQUEST_EVENT, ());
                        }
                    }
                    Some(Chord::ViewSource) => {
                        // Ctrl+U is not on Microsoft's off-list: skip the
                        // browser feature per key, the key stays in the page.
                        set_browser_accelerator_key_enabled(&args, false, "Ctrl+U");
                    }
                    Some(Chord::DevTools) => {
                        // Debug builds keep F12 / Ctrl+Shift+I working: the
                        // per-key lever re-enables the browser feature for THIS
                        // key only (it wins over the global setting). Release
                        // builds have no DevTools at all (wry disables them
                        // outside debug_assertions), so there is nothing to
                        // re-enable.
                        #[cfg(debug_assertions)]
                        set_browser_accelerator_key_enabled(&args, true, "DevTools");
                    }
                    _ => {}
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
                log::info!("[keys] native accelerator handler installed");
            }
            Err(add_error) => {
                log::error!("[keys] cannot register the accelerator handler: {add_error}");
            }
        }
    });
    if let Err(dispatch_error) = dispatched {
        INSTALLED.store(false, Ordering::SeqCst);
        log::error!("[keys] cannot dispatch the accelerator registration: {dispatch_error}");
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
            log::warn!("[keys] cannot remove the accelerator handler: {remove_error}");
        }
    });
    if let Err(dispatch_error) = dispatched {
        log::warn!("[keys] cannot dispatch the accelerator removal: {dispatch_error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        VK_0, VK_F8, VK_LEFT, VK_OEM_MINUS, VK_OEM_PLUS, VK_RIGHT,
    };

    #[test]
    fn plain_f5_is_the_app_reload() {
        assert_eq!(classify_chord(VK_F5 as u32, false, false, false), Chord::Reload);
    }

    #[test]
    fn f5_variants_are_not_reload_chords() {
        // Shift+F5 / Ctrl+F5 are not a reload any more: the browser
        // accelerator set is off, so they do nothing at all.
        assert_eq!(classify_chord(VK_F5 as u32, false, false, true), Chord::Passthrough);
        assert_eq!(classify_chord(VK_F5 as u32, true, false, false), Chord::Passthrough);
    }

    #[test]
    fn ctrl_r_is_not_a_reload_chord() {
        // Ctrl+R / Ctrl+Shift+R are a complete no-op: the browser reload is
        // off and the app does not refresh on them either.
        assert_eq!(classify_chord(b'R' as u32, true, false, false), Chord::Passthrough);
        assert_eq!(classify_chord(b'R' as u32, true, false, true), Chord::Passthrough);
    }

    #[test]
    fn alt_chords_stay_with_the_os() {
        assert_eq!(classify_chord(VK_F5 as u32, false, true, false), Chord::Passthrough);
        assert_eq!(classify_chord(VK_LEFT as u32, false, true, false), Chord::Passthrough);
        assert_eq!(classify_chord(VK_RIGHT as u32, false, true, false), Chord::Passthrough);
        assert_eq!(classify_chord(VK_LEFT as u32, true, true, false), Chord::Passthrough);
    }

    #[test]
    fn devtools_chords_are_classified() {
        assert_eq!(classify_chord(VK_F12 as u32, false, false, false), Chord::DevTools);
        assert_eq!(classify_chord(VK_I, true, false, true), Chord::DevTools);
        assert_eq!(classify_chord(VK_J, true, false, true), Chord::DevTools);
    }

    #[test]
    fn ctrl_u_is_view_source() {
        assert_eq!(classify_chord(VK_U, true, false, false), Chord::ViewSource);
    }

    #[test]
    fn app_shortcuts_reach_the_page() {
        // App shortcuts (src/player/commands/definitions.ts).
        assert_eq!(classify_chord(b'S' as u32, true, false, false), Chord::Passthrough);
        assert_eq!(classify_chord(b'S' as u32, true, false, true), Chord::Passthrough);
        assert_eq!(classify_chord(b'F' as u32, true, false, false), Chord::Passthrough);
        assert_eq!(classify_chord(VK_OEM_PLUS as u32, true, false, false), Chord::Passthrough);
        assert_eq!(classify_chord(VK_OEM_MINUS as u32, true, false, false), Chord::Passthrough);
        assert_eq!(classify_chord(VK_0 as u32, true, false, false), Chord::Passthrough);
        assert_eq!(classify_chord(VK_F8 as u32, false, false, false), Chord::Passthrough);
        assert_eq!(classify_chord(b'S' as u32, false, false, false), Chord::Passthrough);
    }

    #[test]
    fn editing_keys_reach_the_page() {
        assert_eq!(classify_chord(b'A' as u32, true, false, false), Chord::Passthrough);
        assert_eq!(classify_chord(b'C' as u32, true, false, false), Chord::Passthrough);
        assert_eq!(classify_chord(b'V' as u32, true, false, false), Chord::Passthrough);
        assert_eq!(classify_chord(b'X' as u32, true, false, false), Chord::Passthrough);
        assert_eq!(classify_chord(b'Z' as u32, true, false, false), Chord::Passthrough);
    }
}
