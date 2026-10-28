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

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};

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
/// Label of the JS-created floating window (see `src/lib/pipWindow.ts`). It
/// needs the same browser-accelerator policy as main, but not the reload chord.
const PIP_WINDOW_LABEL: &str = "pip";
/// Frontend event: run `requestPlayerReload()` now. The page owns the ordered
/// flow (save session -> await `mpv_shutdown` -> reload the WebView).
const RELOAD_REQUEST_EVENT: &str = "player-reload-requested";
/// `U` virtual-key code, used for Ctrl+U (view source).
const VK_U: u32 = b'U' as u32;
/// `I` virtual-key code, used for Ctrl+Shift+I (DevTools).
const VK_I: u32 = b'I' as u32;
/// `J` virtual-key code, used for Ctrl+Shift+J (DevTools).
const VK_J: u32 = b'J' as u32;

/// Where one window's registration stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// `install_for` dispatched the work but the COM call has not returned yet.
    /// A second call in this window must be a no-op: the `with_webview`
    /// dispatch is asynchronous, so it can arrive before the registration
    /// lands.
    Installing,
    /// The handler is on that window's controller with this event token.
    Installed(i64),
}

/// Registration state for ONE window label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Registration {
    /// Bumped on every install attempt. The COM closure carries the generation
    /// it started with, so a registration that lands AFTER the window was
    /// destroyed (an `Installing` entry removed mid-flight) can detect that its
    /// slot is gone and drop the handler instead of re-occupying the label with
    /// a token that belongs to a dead controller.
    generation: u64,
    phase: Phase,
}

/// Per-window registration state, keyed by window label. The map is what makes
/// a RE-CREATED window installable: the entry is removed when the window is
/// destroyed (see `uninstall_for`), so opening the PiP window a second time
/// starts from an empty slot instead of hitting a stale token.
static HANDLERS: LazyLock<Mutex<HashMap<String, Registration>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

fn handlers() -> MutexGuard<'static, HashMap<String, Registration>> {
    HANDLERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Claim the label for one install attempt. `None` means another attempt owns
/// it (in flight or already installed) — the caller must return.
fn begin_install(
    state: &mut HashMap<String, Registration>,
    label: &str,
) -> Option<u64> {
    if state.contains_key(label) {
        return None;
    }
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::SeqCst);
    state.insert(
        label.to_string(),
        Registration {
            generation,
            phase: Phase::Installing,
        },
    );
    Some(generation)
}

/// Record the COM token, but ONLY while this attempt still owns the label.
/// Returns `true` when the slot was written; `false` means the window was torn
/// down while the registration was in flight and the caller must remove the
/// handler it just added.
fn finish_install(
    state: &mut HashMap<String, Registration>,
    label: &str,
    generation: u64,
    token: i64,
) -> bool {
    match state.get_mut(label) {
        Some(entry) if entry.generation == generation => {
            entry.phase = Phase::Installed(token);
            true
        }
        _ => false,
    }
}

/// Drop this attempt's claim after a failure, without touching a NEWER attempt
/// that may already have taken the label over.
fn abort_install(
    state: &mut HashMap<String, Registration>,
    label: &str,
    generation: u64,
) {
    if state.get(label).map(|entry| entry.generation) == Some(generation) {
        state.remove(label);
    }
}

/// Remove one label entirely, returning the token to unsubscribe when the
/// handler had actually landed.
fn take_registration(
    state: &mut HashMap<String, Registration>,
    label: &str,
) -> Option<i64> {
    match state.remove(label) {
        // Still mid-install: the controller dies with the window and takes the
        // handler with it, so there is no token to hand back.
        Some(Registration {
            phase: Phase::Installing,
            ..
        })
        | None => None,
        Some(Registration {
            phase: Phase::Installed(token),
            ..
        }) => Some(token),
    }
}

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

/// What the handler DOES with one chord on one window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    /// Swallow the key and (unless auto-repeating) ask the page to reload.
    RunAppReload,
    /// Skip the browser feature for THIS key only (the key still reaches the
    /// page).
    SkipBrowserFeature,
    /// Re-enable the browser feature for THIS key only (debug DevTools).
    AllowBrowserFeature,
    /// Leave the key alone.
    Passthrough,
}

/// Per-window policy: the same chord can mean different things depending on
/// which webview received it. Pure, so the split is unit-testable.
///
/// Only the window that OWNS the reload turns F5 into the app's ordered flow.
/// A secondary window (PiP) has nothing to reload, and swallowing F5 there
/// would either do nothing useful or ask the main window to refresh behind the
/// user's back — so it stays a plain passthrough.
fn action_for(chord: Chord, owns_reload: bool) -> Action {
    match chord {
        Chord::Reload if owns_reload => Action::RunAppReload,
        Chord::Reload => Action::Passthrough,
        Chord::ViewSource => Action::SkipBrowserFeature,
        Chord::DevTools => Action::AllowBrowserFeature,
        Chord::Passthrough => Action::Passthrough,
    }
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

    // -- per-window policy -------------------------------------------------

    #[test]
    fn only_the_reload_owner_runs_the_app_reload() {
        assert_eq!(action_for(Chord::Reload, true), Action::RunAppReload);
        // The PiP window has nothing to reload: F5 must stay a dead chord
        // instead of asking the main window to refresh behind the user's back.
        assert_eq!(action_for(Chord::Reload, false), Action::Passthrough);
    }

    #[test]
    fn devtools_and_view_source_are_window_independent() {
        for owns_reload in [true, false] {
            assert_eq!(
                action_for(Chord::ViewSource, owns_reload),
                Action::SkipBrowserFeature
            );
            assert_eq!(
                action_for(Chord::DevTools, owns_reload),
                Action::AllowBrowserFeature
            );
            assert_eq!(
                action_for(Chord::Passthrough, owns_reload),
                Action::Passthrough
            );
        }
    }

    #[test]
    fn ctrl_p_is_never_a_native_action_so_it_reaches_the_page() {
        // Ctrl+P is the PiP chord handled by the page (main: PLAYER_PIP_TOGGLE,
        // PiP window: close). The native layer must only DISABLE the browser
        // print dialog — never swallow the key — on BOTH windows.
        let ctrl_p = classify_chord(b'P' as u32, true, false, false);
        assert_eq!(ctrl_p, Chord::Passthrough);
        assert_eq!(action_for(ctrl_p, true), Action::Passthrough);
        assert_eq!(action_for(ctrl_p, false), Action::Passthrough);
    }

    // -- per-label registration bookkeeping --------------------------------

    fn phase_of(
        state: &HashMap<String, Registration>,
        label: &str,
    ) -> Option<Phase> {
        state.get(label).map(|entry| entry.phase)
    }

    #[test]
    fn a_label_installs_once() {
        let mut state = HashMap::new();
        let first = begin_install(&mut state, "pip");
        assert!(first.is_some());
        // A second call while the first is still in flight is a no-op: one
        // window must never end up with two handlers.
        assert_eq!(begin_install(&mut state, "pip"), None);
    }

    #[test]
    fn labels_are_independent() {
        let mut state = HashMap::new();
        let main = begin_install(&mut state, "main").expect("main claims its slot");
        let pip = begin_install(&mut state, "pip").expect("pip claims its own slot");
        assert_ne!(main, pip);
        assert!(finish_install(&mut state, "main", main, 7));
        assert!(finish_install(&mut state, "pip", pip, 9));
        assert_eq!(phase_of(&state, "main"), Some(Phase::Installed(7)));
        assert_eq!(phase_of(&state, "pip"), Some(Phase::Installed(9)));
    }

    #[test]
    fn a_recreated_window_can_install_again() {
        // Close PiP -> the destroy hook removes the slot -> open PiP again ->
        // the new webview must install from scratch, not hit a stale token.
        let mut state = HashMap::new();
        let first = begin_install(&mut state, "pip").expect("first install claims");
        assert!(finish_install(&mut state, "pip", first, 1));
        assert_eq!(take_registration(&mut state, "pip"), Some(1));
        assert!(state.is_empty());

        let second = begin_install(&mut state, "pip").expect("second install claims");
        assert!(finish_install(&mut state, "pip", second, 2));
        assert_eq!(phase_of(&state, "pip"), Some(Phase::Installed(2)));
    }

    #[test]
    fn a_late_registration_never_reoccupies_a_destroyed_slot() {
        // The COM call landed after the window was destroyed: the slot is gone,
        // so the callback reports "not mine" and the caller removes the handler
        // instead of parking a token on a dead controller.
        let mut state = HashMap::new();
        let generation = begin_install(&mut state, "pip").expect("claims");
        assert_eq!(take_registration(&mut state, "pip"), None);
        assert!(!finish_install(&mut state, "pip", generation, 42));
        assert!(state.is_empty());
    }

    #[test]
    fn a_failed_install_frees_the_slot_for_a_retry() {
        let mut state = HashMap::new();
        let generation = begin_install(&mut state, "pip").expect("claims");
        abort_install(&mut state, "pip", generation);
        assert!(state.is_empty());
        assert!(begin_install(&mut state, "pip").is_some());
    }

    #[test]
    fn a_stale_abort_does_not_clear_a_newer_attempt() {
        let mut state = HashMap::new();
        let stale = begin_install(&mut state, "pip").expect("claims");
        // The old attempt loses its slot (window destroyed)...
        assert_eq!(take_registration(&mut state, "pip"), None);
        // ...a new window takes the label over...
        let fresh = begin_install(&mut state, "pip").expect("new attempt claims");
        assert_ne!(stale, fresh);
        // ...and the old attempt's late failure must not evict it.
        abort_install(&mut state, "pip", stale);
        assert_eq!(phase_of(&state, "pip"), Some(Phase::Installing));
    }

    #[test]
    fn taking_an_in_flight_registration_yields_no_token() {
        let mut state = HashMap::new();
        let generation = begin_install(&mut state, "pip").expect("claims");
        assert_eq!(take_registration(&mut state, "pip"), None);
        assert!(!finish_install(&mut state, "pip", generation, 5));
    }
}
