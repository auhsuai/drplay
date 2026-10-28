//! Engine lifecycle: the single owner of `ENGINE` + `LIFECYCLE_GATE`
//! (gate -> slot) plus the `mpv_*` engine API surface (plan 20 §2.3).

use std::sync::{Arc, OnceLock};

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::engine;
use super::surface::{
    clear_active_surface_and_reset_owner, publish_surface_and_replay, reset_owner_only,
};
use crate::mpv::EventSink;

/// Same rejection string the legacy dispatcher uses when no sidecar exists
/// (mpv/handle.rs:95): the frontend reacts to the failure, and identical text
/// keeps app logs comparable between engines.
const NOT_RUNNING_ERROR: &str = "mpv is not running (call mpv_spawn first)";

/// Shared slot holding the running engine (`None` = not spawned).
pub(crate) type EngineSlot = Mutex<Option<Arc<engine::Engine>>>;

static ENGINE: OnceLock<EngineSlot> = OnceLock::new();

/// Single serialization point for every engine creation and teardown. Held
/// across `Engine::destroy`: a second `mpv_shutdown` waits for the running
/// teardown instead of answering `Ok` merely because the slot is already
/// empty, and `mpv_spawn` cannot create a replacement while the old engine is
/// still tearing down (the F5 "old track + new track over each other" race).
/// Ordering is always gate -> slot; no other path takes the slot and then the
/// gate, so this cannot deadlock.
pub(super) static LIFECYCLE_GATE: Mutex<()> = Mutex::const_new(());

fn engine_slot() -> &'static EngineSlot {
    ENGINE.get_or_init(|| Mutex::new(None))
}

/// `mpv_spawn` in libmpv mode (idempotent, `{conn}` reply shape). Resolves
/// the main window here so the composition target is bound at engine
/// creation; a window-less production spawn fails loud (no silent no-video).
pub(crate) async fn spawn(app: &tauri::AppHandle) -> Result<Value, String> {
    let hwnd = crate::video_host::main_window_hwnd(app).map_err(|window_error| {
        format!("libmpv mode needs the main window for the video surface: {window_error}")
    })?;
    let sink = crate::mpv::event_sink(app.clone());
    ensure_spawned_with_window(engine_slot(), sink, Some(hwnd as usize)).await
}

/// `mpv_command` in libmpv mode: `{data, load_epoch}`, exactly the sidecar
/// reply shape. The synchronous FFI call runs on the blocking pool so a slow
/// command can never stall the async runtime.
pub(crate) async fn command(cmd: Vec<String>) -> Result<Value, String> {
    let engine = running_engine().await?;
    let command_name = cmd.first().cloned().unwrap_or_default();
    let worker = Arc::clone(&engine);
    let reply = tokio::task::spawn_blocking(move || worker.send_command(&cmd))
        .await
        .map_err(|join_error| format!("mpv engine command task failed: {join_error}"))?
        .map_err(|engine_error| {
            log::warn!("[player] command {command_name} failed: {engine_error}");
            engine_error.wire_message()
        })?;
    Ok(json!({ "data": reply.data, "load_epoch": reply.load_epoch }))
}

/// `mpv_get_property` in libmpv mode: the property value, or the legacy
/// `mpv error: <reason>` rejection for unknown properties.
pub(crate) async fn get_property(property: String) -> Result<Value, String> {
    let engine = running_engine().await?;
    let property_for_log = property.clone();
    tokio::task::spawn_blocking(move || engine.get_property(&property))
        .await
        .map_err(|join_error| format!("mpv engine property task failed: {join_error}"))?
        .map_err(|engine_error| {
            log::debug!("[player] get_property {property_for_log} failed: {engine_error}");
            engine_error.wire_message()
        })
}

/// `mpv_shutdown` in libmpv mode. Safe to call when nothing is running, and
/// safe to call concurrently: the second caller joins the running teardown
/// through the lifecycle gate instead of returning early.
pub(crate) async fn shutdown() -> Result<(), String> {
    let Some(slot) = ENGINE.get() else {
        return Ok(());
    };
    shutdown_slot(slot, &LIFECYCLE_GATE).await
}

/// Teardown core shared by `mpv_shutdown` and the tests. The gate is held for
/// the WHOLE destroy, so "slot is empty" is never treated as proof that the
/// previous engine stopped.
pub(super) async fn shutdown_slot(slot: &EngineSlot, gate: &Mutex<()>) -> Result<(), String> {
    let _gate = gate.lock().await;
    let Some(engine) = slot.lock().await.take() else {
        return Ok(());
    };
    // Stop forwarding surface requests before the render thread goes down.
    clear_active_surface_and_reset_owner();
    let worker = Arc::clone(&engine);
    let destroyed = tokio::task::spawn_blocking(move || worker.destroy(true))
        .await
        .map_err(|join_error| format!("mpv engine shutdown task failed: {join_error}"))
        .and_then(|result| result.map_err(|engine_error| engine_error.to_string()));
    if let Err(shutdown_error) = destroyed {
        // A failed teardown is NOT an empty slot: the handle may still be
        // alive (a render thread the hook refused to stop). Put the failed
        // engine back so spawn/shutdown answer from its real state instead of
        // starting a second engine that would play over the old one.
        *slot.lock().await = Some(engine);
        log::error!(
            "[player] libmpv shutdown failed; keeping the failed engine: {shutdown_error}"
        );
        return Err(format!("mpv shutdown failed: {shutdown_error}"));
    }
    log::info!("[player] libmpv engine shut down");
    Ok(())
}

/// True while a native engine is not provably stopped (running, tearing down
/// or poisoned by a failed teardown). `mpv_spawn` must not fall back to the
/// mpv.exe sidecar in that state: two engines would be able to play at once.
pub(crate) fn has_unresolved_engine_failure() -> bool {
    let Some(slot) = ENGINE.get() else {
        return false;
    };
    match slot.try_lock() {
        Ok(guard) => guard.as_ref().is_some_and(|engine| !engine.is_stopped()),
        // A creation/teardown is deciding right now: never start a second
        // engine behind its back.
        Err(_) => true,
    }
}

/// Synchronous best-effort teardown for app exit (`RunEvent::ExitRequested` /
/// `Exit` cannot await). A contended slot means a command is mid-flight; the
/// process is about to die anyway, so this skips rather than blocks — the same
/// posture as `mpv_kill_sync_best_effort` for the sidecar.
pub(crate) fn teardown_for_exit() {
    let Some(slot) = ENGINE.get() else {
        return;
    };
    // A shutdown already in flight owns the teardown; the process is exiting,
    // so skipping the duplicate is safer than blocking the UI thread.
    let Ok(_gate) = LIFECYCLE_GATE.try_lock() else {
        log::warn!("[player] exit teardown skipped: a lifecycle operation is in flight");
        return;
    };
    let Ok(mut guard) = slot.try_lock() else {
        log::warn!("[player] exit teardown skipped: engine slot is busy");
        return;
    };
    let Some(engine) = guard.take() else {
        return;
    };
    drop(guard);
    clear_active_surface_and_reset_owner();
    if let Err(teardown_error) = engine.destroy(true) {
        log::warn!("[player] exit teardown failed: {teardown_error}");
    }
}

/// Clone the running engine's handle (releasing the state lock before any
/// FFI call) and reject the call when no live engine exists. Mirrors
/// `running_ipc_from_state` (mpv/handle.rs:91-97).
async fn running_engine() -> Result<Arc<engine::Engine>, String> {
    let slot = engine_slot();
    let guard = slot.lock().await;
    match guard.as_ref() {
        Some(engine) if engine.is_alive() => Ok(Arc::clone(engine)),
        _ => Err(NOT_RUNNING_ERROR.to_string()),
    }
}

/// Spawn-or-reuse core of `mpv_spawn`: idempotent while the engine is alive
/// (replies with the same `conn`), replaces a destroyed one. Split out of
/// `spawn` so the dispatcher contract is testable without a Tauri app handle.
/// Headless variant (tests / no composition window).
#[allow(dead_code)] // test entry point (engine_021); production uses the with-window variant
pub(super) async fn ensure_spawned(slot: &EngineSlot, sink: EventSink) -> Result<Value, String> {
    ensure_spawned_with_window(slot, sink, None).await
}

/// S3 variant: `hwnd` = main window of the composition target (`None` =
/// headless render). After creation the stored surface requests are replayed
/// onto the new render surface and it is published for the synchronous
/// `video_host_*` forwarders.
pub(super) async fn ensure_spawned_with_window(
    slot: &EngineSlot,
    sink: EventSink,
    hwnd: Option<usize>,
) -> Result<Value, String> {
    // Same gate as `shutdown_slot`: a spawn can never observe "slot empty
    // while the old engine is still tearing down" and start a second engine.
    let _gate = LIFECYCLE_GATE.lock().await;
    let mut guard = slot.lock().await;
    if let Some(engine) = guard.as_ref() {
        if engine.is_alive() {
            return Ok(json!({ "conn": engine.conn() }));
        }
        if engine.teardown_failed() {
            // The old handle was deliberately kept alive (spec §18): creating
            // a replacement here would allow two engines to play at once.
            log::error!(
                "[player] refusing to spawn: the previous engine teardown failed (conn {})",
                engine.conn()
            );
            return Err(
                "libmpv engine teardown failed earlier; refusing to start a second engine while the old handle may still be alive (restart the app)"
                    .to_string(),
            );
        }
        log::info!("[player] replacing a destroyed libmpv engine (conn {})", engine.conn());
    }
    if let Some(dead) = guard.take() {
        clear_active_surface_and_reset_owner();
        let worker = Arc::clone(&dead);
        let destroyed = tokio::task::spawn_blocking(move || worker.destroy(false))
            .await
            .map_err(|join_error| format!("mpv engine replace task failed: {join_error}"))
            .and_then(|result| result.map_err(|engine_error| engine_error.to_string()));
        if let Err(teardown_error) = destroyed {
            // The dead engine could not be released safely: keep it (poisoned)
            // instead of publishing a second engine over a possibly live one.
            *guard = Some(dead);
            log::error!(
                "[player] refusing to spawn: the dead engine could not be torn down: {teardown_error}"
            );
            return Err(format!("mpv engine teardown failed: {teardown_error}"));
        }
    }
    let engine =
        tokio::task::spawn_blocking(move || engine::Engine::create_with_window(sink, hwnd))
            .await
            .map_err(|join_error| format!("mpv engine spawn task failed: {join_error}"))?
            .map_err(|engine_error| engine_error.to_string())?;
    let conn = engine.conn();
    // A newly created engine always targets the main window.
    reset_owner_only();
    // Replay the latest frontend requests onto the new surface and publish it.
    // The requests lock is held across the publish so a concurrent set_rect
    // cannot slip between "request stored" and "surface published" and get
    // addressed to the previous surface.
    let surface = engine.render_surface().map(Arc::clone);
    publish_surface_and_replay(surface);
    *guard = Some(engine);
    log::info!("[player] libmpv engine ready (conn {conn})");
    Ok(json!({ "conn": conn }))
}
