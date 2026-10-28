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
//!
//! The policy is PER WEBVIEW, not per process: DrPlay has two WebView2
//! controllers (the `main` window and the JS-created `pip` window) and each one
//! keeps its own accelerator settings + its own event token. Installing on
//! `main` alone left the PiP webview behaving like a browser — Ctrl+P there
//! opened WebView2's print dialog and never reached the page.

mod classifier;
mod registration;

use tauri::{Emitter, Manager};
use webview2_com::AcceleratorKeyPressedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2AcceleratorKeyPressedEventArgs, ICoreWebView2AcceleratorKeyPressedEventArgs2,
    ICoreWebView2Controller, ICoreWebView2Settings3, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
};
use windows_core::Interface;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT,
};

use classifier::{action_for, classify_chord, Action, Chord};
use registration::{abort_install, begin_install, finish_install, handlers, take_registration};

const MAIN_WINDOW_LABEL: &str = "main";
/// Label of the JS-created floating window (see `src/lib/pipWindow.ts`). It
/// needs the same browser-accelerator policy as main, but not the reload chord.
const PIP_WINDOW_LABEL: &str = "pip";
/// Frontend event: run `requestPlayerReload()` now. The page owns the ordered
/// flow (save session -> await `mpv_shutdown` -> reload the WebView).
const RELOAD_REQUEST_EVENT: &str = "player-reload-requested";

fn key_is_down(vk: i32) -> bool {
    // SAFETY: plain read of the calling thread's keyboard state; this runs on
    // the UI thread while the key event is being delivered.
    unsafe { GetKeyState(vk) < 0 }
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

/// Register the native keyboard policy on the MAIN WebView2 controller.
/// Called once from `setup` on the UI thread, after the main window exists.
pub(crate) fn install(app: &tauri::AppHandle) {
    install_for(app, MAIN_WINDOW_LABEL, true);
}

/// Install the native keyboard policy on ONE webview window.
/// `owns_reload` is true only for the main window: it is the single window
/// whose F5 runs the app's ordered reload flow. A secondary window (PiP) has
/// nothing to reload — a plain F5 there is just a dead chord.
///
/// Idempotent per label: an `Installing`/`Installed` entry makes a second call
/// a no-op, so one F5 can never drive two shutdown flows and a window that is
/// opened twice never accumulates two handlers.
pub(crate) fn install_for(app: &tauri::AppHandle, label: &str, owns_reload: bool) {
    let generation = match begin_install(&mut handlers(), label) {
        Some(generation) => generation,
        None => return,
    };
    let Some(window) = app.get_webview_window(label) else {
        abort_install(&mut handlers(), label, generation);
        log::warn!("[keys] {label} WebView not found; browser accelerator keys stay enabled");
        return;
    };
    let app_for_handler = app.clone();
    let label_for_handler = label.to_string();
    let dispatched = window.as_ref().with_webview(move |platform| {
        let controller = platform.controller();
        // Global switch first: the browser accelerator set is off for every
        // chord, the page still receives all of them. This is the layer that
        // stops WebView2's own Ctrl+P print dialog in the PiP window.
        disable_browser_accelerator_keys(&controller);
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
            move |_sender, args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>| {
                let Some(args) = args else {
                    return Ok(());
                };
                match action_for(
                    chord_of(&args).unwrap_or(Chord::Passthrough),
                    owns_reload,
                ) {
                    Action::RunAppReload => {
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
                    Action::SkipBrowserFeature => {
                        // Ctrl+U is not on Microsoft's off-list: skip the
                        // browser feature per key, the key stays in the page.
                        set_browser_accelerator_key_enabled(&args, false, "Ctrl+U");
                    }
                    Action::AllowBrowserFeature => {
                        // Debug builds keep F12 / Ctrl+Shift+I working: the
                        // per-key lever re-enables the browser feature for THIS
                        // key only (it wins over the global setting). Release
                        // builds have no DevTools at all (wry disables them
                        // outside debug_assertions), so there is nothing to
                        // re-enable.
                        #[cfg(debug_assertions)]
                        set_browser_accelerator_key_enabled(&args, true, "DevTools");
                    }
                    // Includes a Reload chord on a window that does not own the
                    // reload (the PiP window): deliberately neither swallowed
                    // nor re-emitted, so the key reaches the page untouched.
                    Action::Passthrough => {}
                }
                Ok(())
            },
        ));
        let mut token = 0i64;
        match unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) } {
            Ok(()) => {
                if finish_install(&mut handlers(), &label_for_handler, generation, token) {
                    log::info!(
                        "[keys] native accelerator handler installed for {label_for_handler}"
                    );
                } else {
                    // The window went away while the registration was in
                    // flight: the slot is gone, so this token must not stay
                    // registered on a controller nobody owns any more.
                    if let Err(remove_error) = unsafe {
                        controller.remove_AcceleratorKeyPressed(token)
                    } {
                        log::warn!(
                            "[keys] cannot drop the late handler for {label_for_handler}: {remove_error}"
                        );
                    }
                    log::info!(
                        "[keys] discarded a late accelerator registration for {label_for_handler}"
                    );
                }
            }
            Err(add_error) => {
                abort_install(&mut handlers(), &label_for_handler, generation);
                log::error!(
                    "[keys] cannot register the accelerator handler for {label_for_handler}: {add_error}"
                );
            }
        }
    });
    if let Err(dispatch_error) = dispatched {
        abort_install(&mut handlers(), label, generation);
        log::error!(
            "[keys] cannot dispatch the accelerator registration for {label}: {dispatch_error}"
        );
    }
}

/// Register the native keyboard policy on the PiP webview. The PiP window is
/// created from JS on demand, so it cannot be covered by the `setup` install.
///
/// `owns_reload` is false: that window has nothing to reload, so a plain F5
/// there must stay a dead chord instead of asking the main window to refresh.
pub(crate) fn install_for_pip(app: &tauri::AppHandle) {
    install_for(app, PIP_WINDOW_LABEL, false);
}

/// Remove the handler of ONE window before that WebView is destroyed, and drop
/// its slot so a re-created window (close PiP -> open PiP) installs cleanly.
/// Safe to call when nothing was installed; a removal failure is logged, never
/// fatal.
pub(crate) fn uninstall_for(app: &tauri::AppHandle, label: &str) {
    let Some(token) = take_registration(&mut handlers(), label) else {
        return;
    };
    let Some(window) = app.get_webview_window(label) else {
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

/// Remove every registered handler (process exit).
pub(crate) fn uninstall_all(app: &tauri::AppHandle) {
    let labels: Vec<String> = handlers().keys().cloned().collect();
    for label in labels {
        uninstall_for(app, &label);
    }
}
