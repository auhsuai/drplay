//! Per-label registration bookkeeping for the native keyboard policy: which
//! window label owns a handler, which generation is current, and the COM event
//! token to unsubscribe when the handler landed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};

/// Where one window's registration stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
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
pub(super) struct Registration {
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

pub(super) fn handlers() -> MutexGuard<'static, HashMap<String, Registration>> {
    HANDLERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Claim the label for one install attempt. `None` means another attempt owns
/// it (in flight or already installed) — the caller must return.
pub(super) fn begin_install(
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
pub(super) fn finish_install(
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
pub(super) fn abort_install(
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
pub(super) fn take_registration(
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

#[cfg(test)]
mod tests {
    use super::*;

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
