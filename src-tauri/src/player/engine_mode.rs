//! Engine selection. The single owner of `ACTIVE_ENGINE` (plan 20 §2.3).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

use super::ffi;

const ENGINE_MODE_ENV: &str = "DRPLAY_PLAYER_ENGINE";
const ENGINE_MODE_LEGACY: &str = "legacy";
const ENGINE_MODE_SIDECAR: &str = "sidecar";

/// Why no engine can run. Carried by [`ActiveEngine::Unavailable`] so the two
/// very different failures stay distinguishable in logs, tests and the
/// (future) Settings surface, while both produce the same actionable error.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum UnavailableReason {
    /// libmpv's DLL probe failed AND no fallback sidecar is installed.
    LibmpvFailedNoSidecar,
    /// The user explicitly asked for the sidecar (`DRPLAY_PLAYER_ENGINE`) and
    /// it is not installed. Never silently promoted to libmpv: an explicit
    /// choice must not be ignored.
    SidecarRequestedButMissing,
}

/// Active engine the dispatcher routes to. `Libmpv` is the default; `Legacy`
/// (the mpv.exe sidecar) is opt-in or the fallback; `Unavailable` means
/// NEITHER can run -- the spawn path must fail loudly with an actionable
/// error instead of pretending the sidecar is up.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ActiveEngine {
    Libmpv,
    Legacy,
    Unavailable(UnavailableReason),
}

/// Stored decision: 0 = not decided yet (the preference still governs),
/// 1 = libmpv, 2 = legacy, 3/4 = unavailable (libmpv failed / requested but
/// missing). Written by the startup probe and by the `mpv_spawn` fallback;
/// read by every video_host/mpv call site.
const ENGINE_UNDECIDED: u8 = 0;
const ENGINE_ACTIVE_LIBMPV: u8 = 1;
const ENGINE_ACTIVE_LEGACY: u8 = 2;
const ENGINE_UNAVAILABLE_LIBMPV: u8 = 3;
const ENGINE_UNAVAILABLE_REQUESTED: u8 = 4;

static ACTIVE_ENGINE: AtomicU8 = AtomicU8::new(ENGINE_UNDECIDED);

/// The sidecar exe the startup probe actually resolved (and validated), if
/// any. Cached so the read-only accessor never re-stats disk on the hot path;
/// set exactly once, before the frontend can call a command.
static SIDECAR_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Read-only snapshot for the fallback status command: the decision, whether a
/// usable sidecar was found at startup, and where it is. Does no IO, and cannot
/// change the decision.
#[derive(Clone, Debug)]
pub(crate) struct EngineState {
    pub(crate) engine: ActiveEngine,
    pub(crate) sidecar_path: Option<PathBuf>,
}

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

/// Pure startup decision over the two probes, so the whole truth table is
/// unit-testable without touching disk or the process environment:
///
/// | preference | libmpv ready | sidecar | decision            |
/// |------------|--------------|---------|---------------------|
/// | Libmpv     | yes          | any     | Libmpv              |
/// | Libmpv     | no           | yes     | Legacy              |
/// | Libmpv     | no           | no      | Unavailable(LibmpvFailedNoSidecar) |
/// | Legacy     | any          | yes     | Legacy              |
/// | Legacy     | any          | no      | Unavailable(SidecarRequestedButMissing) |
///
/// `libmpv_ready` is ignored when the sidecar was explicitly requested: the
/// user asked for the sidecar, so probing libmpv is not even attempted.
pub(super) fn startup_engine(
    preference: ActiveEngine,
    libmpv_ready: bool,
    sidecar_available: bool,
) -> ActiveEngine {
    let sidecar_preferred = matches!(preference, ActiveEngine::Legacy);
    match (sidecar_preferred, libmpv_ready, sidecar_available) {
        (false, true, _) => ActiveEngine::Libmpv,
        (false, false, true) => ActiveEngine::Legacy,
        (false, false, false) => {
            ActiveEngine::Unavailable(UnavailableReason::LibmpvFailedNoSidecar)
        }
        (true, _, true) => ActiveEngine::Legacy,
        (true, _, false) => {
            ActiveEngine::Unavailable(UnavailableReason::SidecarRequestedButMissing)
        }
    }
}

/// Engine that is actually running (or will run): the decided value, else the
/// current preference. Before the probe, this preserves the old env-only
/// behavior for callers such as `video_host_acquire`.
pub(crate) fn active_engine() -> ActiveEngine {
    match ACTIVE_ENGINE.load(Ordering::Relaxed) {
        ENGINE_ACTIVE_LIBMPV => ActiveEngine::Libmpv,
        ENGINE_ACTIVE_LEGACY => ActiveEngine::Legacy,
        ENGINE_UNAVAILABLE_LIBMPV => {
            ActiveEngine::Unavailable(UnavailableReason::LibmpvFailedNoSidecar)
        }
        ENGINE_UNAVAILABLE_REQUESTED => {
            ActiveEngine::Unavailable(UnavailableReason::SidecarRequestedButMissing)
        }
        _ => preferred_engine(),
    }
}

pub(crate) fn set_active_engine(engine: ActiveEngine) {
    ACTIVE_ENGINE.store(
        match engine {
            ActiveEngine::Libmpv => ENGINE_ACTIVE_LIBMPV,
            ActiveEngine::Legacy => ENGINE_ACTIVE_LEGACY,
            ActiveEngine::Unavailable(UnavailableReason::LibmpvFailedNoSidecar) => {
                ENGINE_UNAVAILABLE_LIBMPV
            }
            ActiveEngine::Unavailable(UnavailableReason::SidecarRequestedButMissing) => {
                ENGINE_UNAVAILABLE_REQUESTED
            }
        },
        Ordering::Relaxed,
    );
}

/// Should the dispatcher route to the in-process libmpv engine?
pub(crate) fn is_libmpv_active() -> bool {
    active_engine() == ActiveEngine::Libmpv
}

/// Read-only snapshot for the fallback status command: the decision, whether a
/// usable sidecar was found at startup, and where it is. Does no IO.
pub(crate) fn engine_state() -> EngineState {
    EngineState {
        engine: active_engine(),
        sidecar_path: SIDECAR_PATH.get().cloned().flatten(),
    }
}

/// Resolve + validate the sidecar exactly the way the spawn path will, so the
/// startup decision and the actual launch can never disagree.
fn probe_sidecar(app: &tauri::AppHandle) -> Option<PathBuf> {
    match crate::mpv::resolve_sidecar_exe(app) {
        Ok(path) => {
            log::info!(
                "[player] engine: fallback sidecar available ({})",
                path.display()
            );
            Some(path)
        }
        Err(resolve_error) => {
            log::warn!("[player] engine: no usable fallback sidecar: {resolve_error}");
            None
        }
    }
}

/// Startup probe (called from `run`'s setup, before any frontend command):
/// resolve the DLL path only -- loading and engine creation stay lazy in
/// `spawn`. Deciding here keeps `video_host_acquire` (which the frontend calls
/// BEFORE spawning) on the same branch as `mpv_spawn`.
///
/// A libmpv failure now ALSO requires a usable sidecar before it may claim
/// `Legacy`: with the sidecar removed from the installer, "pretend the legacy
/// engine is active" left `mpv_spawn` launching a non-existent exe and the UI
/// reporting a working engine that could not play.
pub(crate) fn initialize_engine_state(app: &tauri::AppHandle) {
    let preference = preferred_engine();
    let libmpv_ready = if preference == ActiveEngine::Libmpv {
        match ffi::resolve_libmpv_dll() {
            Ok(dll_path) => {
                log::info!(
                    "[player] engine: in-process libmpv ({})",
                    dll_path.display()
                );
                true
            }
            Err(probe_error) => {
                log::warn!("[player] engine: libmpv unavailable: {probe_error}");
                false
            }
        }
    } else {
        log::info!("[player] engine: legacy sidecar (selected by {ENGINE_MODE_ENV})");
        false
    };
    // Probe unconditionally, not only when the sidecar would be chosen: the
    // read-only snapshot (`engine_state`) must be able to tell Settings whether
    // the fallback is installed even while libmpv runs. It is two stats plus a
    // version read, once per process.
    let sidecar = probe_sidecar(app);
    let decision = startup_engine(preference, libmpv_ready, sidecar.is_some());
    match decision {
        ActiveEngine::Libmpv => {}
        ActiveEngine::Legacy => log::info!(
            "[player] engine: legacy sidecar ({})",
            sidecar
                .as_deref()
                .map(|path| path.display().to_string())
                .unwrap_or_default()
        ),
        ActiveEngine::Unavailable(UnavailableReason::LibmpvFailedNoSidecar) => log::error!(
            "[player] engine: no engine available -- libmpv is unavailable and the optional \
             fallback sidecar is not installed"
        ),
        ActiveEngine::Unavailable(UnavailableReason::SidecarRequestedButMissing) => log::error!(
            "[player] engine: {ENGINE_MODE_ENV} requests the legacy sidecar, but it is not \
             installed"
        ),
    }
    SIDECAR_PATH.set(sidecar).ok();
    set_active_engine(decision);
}
