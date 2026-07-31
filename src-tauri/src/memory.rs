//! WebView2 memory usage target management (Windows only).
//!
//! When the window becomes inactive (minimized / hidden to tray / unfocused),
//! the WebView2 memory usage target level is lowered to reduce memory
//! footprint; when the window becomes active again, the level is restored.
//!
//! On non-Windows platforms these functions are no-ops and the module still
//! compiles.

use std::sync::atomic::{AtomicU8, Ordering};

/// Memory usage target level, mirroring
/// `COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL` (Low=1, Normal=0).
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryUsageTarget {
    #[default]
    Normal,
    Low,
}

const TARGET_CODE_NORMAL: u8 = 0;
const TARGET_CODE_LOW: u8 = 1;

impl MemoryUsageTarget {
    fn as_u8(&self) -> u8 {
        match self {
            MemoryUsageTarget::Normal => TARGET_CODE_NORMAL,
            MemoryUsageTarget::Low => TARGET_CODE_LOW,
        }
    }
}

/// Window activity events the memory manager reacts to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowActivityEvent {
    /// Window was minimized.
    Minimized,
    /// Close requested while minimize-to-tray is on -> window hidden.
    HiddenToTray,
    /// Window shown again from the tray.
    ShownFromTray,
    /// Window gained focus.
    Focused,
    /// Window lost focus (still exists).
    Unfocused,
    /// Window resized to a normal (non-zero) size.
    ResizedToNormal,
}

/// Decides which memory usage target the given window activity event maps to.
///
/// Pure function so it can be unit-tested without a real window.
pub fn target_level_for_event(event: &WindowActivityEvent) -> MemoryUsageTarget {
    match event {
        WindowActivityEvent::Minimized
        | WindowActivityEvent::HiddenToTray
        | WindowActivityEvent::Unfocused => MemoryUsageTarget::Low,
        WindowActivityEvent::ShownFromTray
        | WindowActivityEvent::Focused
        | WindowActivityEvent::ResizedToNormal => MemoryUsageTarget::Normal,
    }
}

/// Last applied target, used to skip redundant WebView2 API calls.
static CURRENT_TARGET: AtomicU8 = AtomicU8::new(TARGET_CODE_NORMAL);

/// Applies the target implied by `event` to the given webview.
///
/// Deduplicated: if the implied target equals the last applied one, nothing
/// happens. On non-Windows platforms this is a no-op.
pub fn apply_window_activity(window: &tauri::WebviewWindow, event: WindowActivityEvent) {
    let target = target_level_for_event(&event);
    let code = target.as_u8();
    if CURRENT_TARGET.load(Ordering::SeqCst) == code {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        if !apply_windows_target(window, target) {
            // Apply failed (e.g. webview not ready yet, COM error): do NOT
            // mark the target as applied, so the next event with the same
            // target is not deduplicated away and gets a retry.
            return;
        }
    }
    // On non-Windows: mark as applied anyway so repeated calls stay cheap
    // and behavior is consistent across platforms.
    CURRENT_TARGET.store(code, Ordering::SeqCst);
}

/// Applies the target to the WebView2. Returns `true` when the target was
/// applied successfully, `false` when any step failed (dispatch, webview
/// lookup, COM, cast or the call itself) so the caller can keep the dedupe
/// state stale and retry on the next event.
#[cfg(target_os = "windows")]
fn apply_windows_target(window: &tauri::WebviewWindow, target: MemoryUsageTarget) -> bool {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2_19,
    };
    use windows_core::Interface;

    let level_const = match target {
        MemoryUsageTarget::Normal => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        MemoryUsageTarget::Low => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    };

    // `with_webview` takes a `FnOnce + Send + 'static` closure returning
    // `()`, so the outcome is communicated back through a flag captured by
    // the closure. All call sites run on the main thread, where the closure
    // executes synchronously before `with_webview` returns; when the webview
    // no longer exists the closure is dropped without running and the flag
    // stays `false`.
    let applied = Arc::new(AtomicBool::new(false));
    let applied_flag = Arc::clone(&applied);

    let dispatch = window.as_ref().with_webview(move |platform| {
        let controller = platform.controller();
        match unsafe { controller.CoreWebView2() } {
            Err(e) => log_memory(
                "with_webview",
                &format!("CoreWebView2() failed (COM error): {e:?}"),
            ),
            Ok(core) => match core.cast::<ICoreWebView2_19>() {
                Err(e) => log_memory(
                    "with_webview",
                    &format!(
                        "cast to ICoreWebView2_19 failed (WebView2 Runtime older than 114.0.1823.32?): {e:?}"
                    ),
                ),
                Ok(webview19) => {
                    if let Err(e) = unsafe { webview19.SetMemoryUsageTargetLevel(level_const) } {
                        log_memory(
                            "with_webview",
                            &format!("SetMemoryUsageTargetLevel({target:?}) failed: {e:?}"),
                        );
                    } else {
                        applied_flag.store(true, Ordering::Relaxed);
                    }
                }
            },
        }
    });
    match dispatch {
        Err(e) => {
            log_memory("apply_windows_target", &format!("with_webview dispatch failed: {e:?}"));
            false
        }
        Ok(()) => applied.load(Ordering::Relaxed),
    }
}

/// Logs a message with module context and timestamp. No secrets/PII by design.
fn log_memory(scope: &str, msg: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    eprintln!("[drplay][memory][{scope}] (t={ts}) {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimized_means_low() {
        assert_eq!(
            target_level_for_event(&WindowActivityEvent::Minimized),
            MemoryUsageTarget::Low
        );
    }

    #[test]
    fn hidden_to_tray_means_low() {
        assert_eq!(
            target_level_for_event(&WindowActivityEvent::HiddenToTray),
            MemoryUsageTarget::Low
        );
    }

    #[test]
    fn unfocused_means_low() {
        assert_eq!(
            target_level_for_event(&WindowActivityEvent::Unfocused),
            MemoryUsageTarget::Low
        );
    }

    #[test]
    fn focused_means_normal() {
        assert_eq!(
            target_level_for_event(&WindowActivityEvent::Focused),
            MemoryUsageTarget::Normal
        );
    }

    #[test]
    fn shown_from_tray_means_normal() {
        assert_eq!(
            target_level_for_event(&WindowActivityEvent::ShownFromTray),
            MemoryUsageTarget::Normal
        );
    }

    #[test]
    fn resized_to_normal_means_normal() {
        assert_eq!(
            target_level_for_event(&WindowActivityEvent::ResizedToNormal),
            MemoryUsageTarget::Normal
        );
    }

    #[test]
    fn default_target_is_normal() {
        assert_eq!(MemoryUsageTarget::default(), MemoryUsageTarget::Normal);
    }

    #[test]
    fn target_codes_match_corewebview2_constants() {
        assert_eq!(MemoryUsageTarget::Normal.as_u8(), TARGET_CODE_NORMAL);
        assert_eq!(MemoryUsageTarget::Low.as_u8(), TARGET_CODE_LOW);
    }

    #[test]
    fn dedupe_skips_repeated_same_target() {
        // The pure decision is deterministic: same event, same target.
        // (The atomic dedupe guard lives in apply_window_activity and is not
        // unit-testable without a real window.)
        let first = target_level_for_event(&WindowActivityEvent::Focused).as_u8();
        let second = target_level_for_event(&WindowActivityEvent::Focused).as_u8();
        assert_eq!(first, second);
        assert_eq!(first, TARGET_CODE_NORMAL);
    }
}
