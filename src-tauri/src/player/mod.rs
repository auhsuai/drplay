//! Player engine dispatcher: routes the four `mpv_*` commands to the
//! in-process libmpv engine by default; the legacy mpv.exe sidecar is used
//! when `DRPLAY_PLAYER_ENGINE=legacy|sidecar` asks for it, when the startup
//! probe cannot find `libmpv-2.dll`, or when libmpv fails to spawn (silent
//! fallback, logged only). The command/event wire contract
//! is frozen in VIDEO-LIBMPV-MIGRATION-PLAN.md ("FROZEN INTERFACE CONTRACT")
//! and is shared with the sidecar through the same `EventSink`/`IpcMessage`
//! types, so both engines emit byte-identical payloads.

mod engine;
mod engine_mode;
mod events;
mod ffi;
mod lifecycle;
mod options;
mod render;
mod surface;
#[cfg(test)]
mod tests;

// Engine mode: the single owner of ACTIVE_ENGINE.
pub(crate) use engine_mode::{
    initialize_engine_state, is_libmpv_active, set_active_engine, ActiveEngine,
};
// Lifecycle: the single owner of ENGINE + LIFECYCLE_GATE (gate -> slot).
pub(crate) use lifecycle::{
    command, get_property, has_unresolved_engine_failure, shutdown, spawn, teardown_for_exit,
};
// Native composition surface: the single owner of SURFACE_* / ACTIVE_SURFACE.
pub(crate) use surface::{
    replay_surface_after_fallback, video_surface_acquire, video_surface_first_frame_presented,
    video_surface_retarget, video_surface_set_rect_from, video_surface_set_visible_from,
};

#[cfg(test)]
use engine_mode::{preferred_engine_from, startup_engine};
#[cfg(test)]
use lifecycle::{
    ensure_spawned, ensure_spawned_with_window, shutdown_slot, EngineSlot, LIFECYCLE_GATE,
};
