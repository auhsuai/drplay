//! Pure accelerator-chord classification and per-window policy. No COM, no
//! keyboard state: the WebView2 event is reduced to chords by the parent module.

use windows_sys::Win32::UI::Input::KeyboardAndMouse::{VK_F5, VK_F12};

/// `U` virtual-key code, used for Ctrl+U (view source).
const VK_U: u32 = b'U' as u32;
/// `I` virtual-key code, used for Ctrl+Shift+I (DevTools).
const VK_I: u32 = b'I' as u32;
/// `J` virtual-key code, used for Ctrl+Shift+J (DevTools).
const VK_J: u32 = b'J' as u32;

/// What DrPlay does with one accelerator chord.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Chord {
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
pub(super) fn classify_chord(vk: u32, ctrl: bool, alt: bool, shift: bool) -> Chord {
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
pub(super) enum Action {
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
pub(super) fn action_for(chord: Chord, owns_reload: bool) -> Action {
    match chord {
        Chord::Reload if owns_reload => Action::RunAppReload,
        Chord::Reload => Action::Passthrough,
        Chord::ViewSource => Action::SkipBrowserFeature,
        Chord::DevTools => Action::AllowBrowserFeature,
        Chord::Passthrough => Action::Passthrough,
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
}
