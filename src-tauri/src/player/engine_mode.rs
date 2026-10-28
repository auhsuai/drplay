//! Engine selection. The single owner of `ACTIVE_ENGINE` (plan 20 §2.3).

use std::sync::atomic::{AtomicU8, Ordering};

use super::ffi;

const ENGINE_MODE_ENV: &str = "DRPLAY_PLAYER_ENGINE";
const ENGINE_MODE_LEGACY: &str = "legacy";
const ENGINE_MODE_SIDECAR: &str = "sidecar";

/// Active engine the dispatcher routes to. `Libmpv` is the default; `Legacy`
/// (the mpv.exe sidecar) is opt-in or the silent fallback.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ActiveEngine {
    Libmpv,
    Legacy,
}

/// Stored decision: 0 = not decided yet (the preference still governs),
/// 1 = libmpv, 2 = legacy. Written by the startup probe and by the
/// `mpv_spawn` fallback; read by every video_host/mpv call site.
const ENGINE_UNDECIDED: u8 = 0;
const ENGINE_ACTIVE_LIBMPV: u8 = 1;
const ENGINE_ACTIVE_LEGACY: u8 = 2;

static ACTIVE_ENGINE: AtomicU8 = AtomicU8::new(ENGINE_UNDECIDED);

/// Pure preference mapping (never reads the environment, so it is testable
/// without process-wide races): only the explicit aliases `legacy`/`sidecar`
/// select the sidecar; absent, `libmpv`, empty or anything else select the
/// in-process engine.
pub(crate) fn preferred_engine_from(raw: Option<&str>) -> ActiveEngine {
    match raw.map(str::trim) {
        Some(value)
            if value.eq_ignore_ascii_case(ENGINE_MODE_LEGACY)
                || value.eq_ignore_ascii_case(ENGINE_MODE_SIDECAR) =>
        {
            ActiveEngine::Legacy
        }
        _ => ActiveEngine::Libmpv,
    }
}

/// Environment wrapper around the pure mapping.
pub(crate) fn preferred_engine() -> ActiveEngine {
    let raw = std::env::var(ENGINE_MODE_ENV).ok();
    preferred_engine_from(raw.as_deref())
}

/// Pure startup decision: the preference wins unless libmpv was preferred but
/// its DLL probe failed, in which case the sidecar takes over.
pub(super) fn startup_engine(preference: ActiveEngine, libmpv_ready: bool) -> ActiveEngine {
    match (preference, libmpv_ready) {
        (ActiveEngine::Legacy, _) => ActiveEngine::Legacy,
        (ActiveEngine::Libmpv, true) => ActiveEngine::Libmpv,
        (ActiveEngine::Libmpv, false) => ActiveEngine::Legacy,
    }
}

/// Engine that is actually running (or will run): the decided value, else the
/// current preference. Before the probe, this preserves the old env-only
/// behavior for callers such as `video_host_acquire`.
pub(crate) fn active_engine() -> ActiveEngine {
    match ACTIVE_ENGINE.load(Ordering::Relaxed) {
        ENGINE_ACTIVE_LIBMPV => ActiveEngine::Libmpv,
        ENGINE_ACTIVE_LEGACY => ActiveEngine::Legacy,
        _ => preferred_engine(),
    }
}

pub(crate) fn set_active_engine(engine: ActiveEngine) {
    ACTIVE_ENGINE.store(
        match engine {
            ActiveEngine::Libmpv => ENGINE_ACTIVE_LIBMPV,
            ActiveEngine::Legacy => ENGINE_ACTIVE_LEGACY,
        },
        Ordering::Relaxed,
    );
}

/// Should the dispatcher route to the in-process libmpv engine?
pub(crate) fn is_libmpv_active() -> bool {
    active_engine() == ActiveEngine::Libmpv
}

/// Startup probe (called from `run`'s setup, before any frontend command):
/// resolve the DLL path only — loading and engine creation stay lazy in
/// `spawn`. Deciding here keeps `video_host_acquire` (which the frontend calls
/// BEFORE spawning) on the same branch as `mpv_spawn`; a missing DLL demotes
/// to the sidecar with a single warning, invisible to the user.
pub(crate) fn initialize_engine_state() {
    let preference = preferred_engine();
    let libmpv_ready = if preference == ActiveEngine::Libmpv {
        match ffi::resolve_libmpv_dll() {
            Ok(dll_path) => {
                log::info!("[player] engine: in-process libmpv ({})", dll_path.display());
                true
            }
            Err(probe_error) => {
                log::warn!("[player] engine: libmpv unavailable, using the legacy sidecar: {probe_error}");
                false
            }
        }
    } else {
        log::info!("[player] engine: legacy sidecar (selected by {ENGINE_MODE_ENV})");
        false
    };
    set_active_engine(startup_engine(preference, libmpv_ready));
}
