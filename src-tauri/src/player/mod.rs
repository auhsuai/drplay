//! Player engine dispatcher: routes the four `mpv_*` commands to the
//! legacy mpv.exe sidecar by default; `DRPLAY_PLAYER_ENGINE=libmpv`
//! selects the in-process libmpv engine (any other value, including an
//! absent env var, keeps mpv/mod.rs on the legacy sidecar).
//! The command/event wire contract
//! is frozen in VIDEO-LIBMPV-MIGRATION-PLAN.md ("FROZEN INTERFACE CONTRACT")
//! and is shared with the sidecar through the same `EventSink`/`IpcMessage`
//! types, so both engines emit byte-identical payloads.

mod engine;
mod events;
mod ffi;
mod options;
mod render;
#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::mpv::EventSink;

const ENGINE_MODE_ENV: &str = "DRPLAY_PLAYER_ENGINE";
const ENGINE_MODE_LIBMPV: &str = "libmpv";

/// Same rejection string the legacy dispatcher uses when no sidecar exists
/// (mpv/handle.rs:95): the frontend reacts to the failure, and identical text
/// keeps app logs comparable between engines.
const NOT_RUNNING_ERROR: &str = "mpv is not running (call mpv_spawn first)";

/// Engine selection is read per call (never cached), so dev runs and tests can
/// toggle it dynamically. Absent env var means legacy (the default engine);
/// only the exact value `libmpv` selects the in-process engine.
pub(crate) fn is_libmpv_mode() -> bool {
    std::env::var(ENGINE_MODE_ENV).map(|value| value == ENGINE_MODE_LIBMPV).unwrap_or(false)
}

/// Shared slot holding the running engine (`None` = not spawned).
pub(crate) type EngineSlot = Mutex<Option<Arc<engine::Engine>>>;

static ENGINE: OnceLock<EngineSlot> = OnceLock::new();

fn engine_slot() -> &'static EngineSlot {
    ENGINE.get_or_init(|| Mutex::new(None))
}

// ---------------------------------------------------------------------------
// S3 video-surface requests (video_host_* commands in libmpv mode)
// ---------------------------------------------------------------------------

/// Latest rect/visibility the frontend asked for, as the source of truth for
/// engines created AFTER the request (the frontend acquires and sizes the
/// surface before spawning). Recorded in PHYSICAL client-area px.
#[derive(Clone, Copy, Default)]
struct SurfaceRequests {
    rect: Option<(i32, i32, u32, u32)>,
    visible: bool,
}

static SURFACE_REQUESTS: StdMutex<SurfaceRequests> =
    StdMutex::new(SurfaceRequests { rect: None, visible: false });

/// The render surface of the running engine, so the synchronous
/// `video_host_set_rect/set_visible` commands can forward WITHOUT touching
/// the async engine slot. Published after `create` replayed the stored
/// requests; cleared before teardown. The requests lock is always taken
/// first (SURFACE_REQUESTS -> ACTIVE_SURFACE) to keep the publish atomic
/// against concurrent set_* calls.
static ACTIVE_SURFACE: StdMutex<Option<Arc<render::RenderSurface>>> = StdMutex::new(None);

fn lock_surface_requests() -> std::sync::MutexGuard<'static, SurfaceRequests> {
    SURFACE_REQUESTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn lock_active_surface() -> std::sync::MutexGuard<'static, Option<Arc<render::RenderSurface>>> {
    ACTIVE_SURFACE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `video_host_acquire` in libmpv mode: there is no native host HWND, the
/// video surface is a DirectComposition visual on the main window. The DComp
/// target itself is created with the engine (render thread owns it, spec
/// §48), so acquire validates that the main window is resolvable and answers
/// the established non-zero "surface available" handle — idempotent, never
/// creates a window.
pub(crate) fn video_surface_acquire(app: &tauri::AppHandle) -> i64 {
    match crate::video_host::main_window_hwnd(app) {
        Ok(_) => {
            log::info!(
                "[player] video surface acquired (composition target is created with the engine)"
            );
            1
        }
        Err(window_error) => {
            log::error!("[player] video surface acquire failed: {window_error}");
            0
        }
    }
}

/// `video_host_set_rect` in libmpv mode: record + forward to the live surface.
pub(crate) fn video_surface_set_rect(x: i64, y: i64, w: i64, h: i64) {
    let (x, y, w, h) = crate::video_host::clamp_rect(x, y, w, h);
    let surface = {
        let mut requests = lock_surface_requests();
        requests.rect = Some((x, y, w as u32, h as u32));
        lock_active_surface().clone()
    };
    if let Some(surface) = surface {
        if let Err(rect_error) = surface.set_rect(x, y, w as u32, h as u32) {
            log::warn!("[player] surface set_rect {x},{y} {w}x{h} failed: {rect_error}");
        }
    }
}

/// `video_host_set_visible` in libmpv mode: record + forward.
pub(crate) fn video_surface_set_visible(visible: bool) {
    let surface = {
        let mut requests = lock_surface_requests();
        requests.visible = visible;
        lock_active_surface().clone()
    };
    if let Some(surface) = surface {
        if let Err(visible_error) = surface.set_visible(visible) {
            log::warn!("[player] surface set_visible({visible}) failed: {visible_error}");
        }
    }
}

/// `video_host_first_frame_presented` in libmpv mode: has the render thread
/// handed its first frame of the CURRENT media load to DirectComposition?
///
/// The read-only pull complement of the one-shot `video-first-frame` event
/// (render/mod.rs): the event has no replay, so a frontend that missed it —
/// a page reload while the engine kept playing, or a listener re-registration
/// that lost the race with a warm-engine first present — can ask this instead
/// and recover. False while no surface exists (never spawned, torn down, or
/// the legacy engine, which has no such signal).
pub(crate) fn video_surface_first_frame_presented() -> bool {
    lock_active_surface()
        .as_ref()
        .is_some_and(|surface| surface.first_frame_emitted())
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
    schedule_video_diagnostics(&engine, &command_name);
    Ok(json!({ "data": reply.data, "load_epoch": reply.load_epoch }))
}

/// MIGRATION-ONLY (S7): one-shot video diagnostics, `DRPLAY_DIAG_VIDEO=1`.
///
/// Why a load-triggered snapshot and not a render-triggered one: the render
/// thread may call no mpv API besides `mpv_render_*`, so the properties can only
/// be read from another thread. Firing once per session after the first load
/// gives mpv time to demux, attach a VO and open the decoder — the whole
/// window during which "no video track / no VO" would be true. One shot only:
/// a video track that came up stays up, so repeating it per load would only add
/// noise.
fn schedule_video_diagnostics(engine: &Arc<engine::Engine>, command_name: &str) {
    /// Settle time after loadfile before the properties mean anything: mpv
    /// needs to demux, pick a VO and open the decoder first.
    const SETTLE: std::time::Duration = std::time::Duration::from_millis(1500);
    static ENABLED: OnceLock<bool> = OnceLock::new();
    static DONE: AtomicBool = AtomicBool::new(false);
    if !*ENABLED.get_or_init(|| std::env::var("DRPLAY_DIAG_VIDEO").is_ok_and(|v| v == "1")) {
        return;
    }
    if command_name != "loadfile" || DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    let engine = Arc::clone(engine);
    tokio::task::spawn_blocking(move || {
        std::thread::sleep(SETTLE);
        engine.log_video_diagnostics();
    });
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

/// `mpv_shutdown` in libmpv mode. Safe to call when nothing is running.
pub(crate) async fn shutdown() -> Result<(), String> {
    let Some(slot) = ENGINE.get() else {
        return Ok(());
    };
    let Some(engine) = slot.lock().await.take() else {
        return Ok(());
    };
    // Stop forwarding surface requests before the render thread goes down.
    *lock_active_surface() = None;
    tokio::task::spawn_blocking(move || engine.destroy(true))
        .await
        .map_err(|join_error| format!("mpv engine shutdown task failed: {join_error}"))?
        .map_err(|engine_error| engine_error.to_string())?;
    log::info!("[player] libmpv engine shut down");
    Ok(())
}

/// Synchronous best-effort teardown for app exit (`RunEvent::ExitRequested` /
/// `Exit` cannot await). A contended slot means a command is mid-flight; the
/// process is about to die anyway, so this skips rather than blocks — the same
/// posture as `mpv_kill_sync_best_effort` for the sidecar.
pub(crate) fn teardown_for_exit() {
    let Some(slot) = ENGINE.get() else {
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
    *lock_active_surface() = None;
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
pub(crate) async fn ensure_spawned(slot: &EngineSlot, sink: EventSink) -> Result<Value, String> {
    ensure_spawned_with_window(slot, sink, None).await
}

/// S3 variant: `hwnd` = main window of the composition target (`None` =
/// headless render). After creation the stored surface requests are replayed
/// onto the new render surface and it is published for the synchronous
/// `video_host_*` forwarders.
pub(crate) async fn ensure_spawned_with_window(
    slot: &EngineSlot,
    sink: EventSink,
    hwnd: Option<usize>,
) -> Result<Value, String> {
    let mut guard = slot.lock().await;
    if let Some(engine) = guard.as_ref() {
        if engine.is_alive() {
            return Ok(json!({ "conn": engine.conn() }));
        }
        log::info!("[player] replacing a destroyed libmpv engine (conn {})", engine.conn());
    }
    if let Some(dead) = guard.take() {
        *lock_active_surface() = None;
        let _ = tokio::task::spawn_blocking(move || dead.destroy(false)).await;
    }
    let engine =
        tokio::task::spawn_blocking(move || engine::Engine::create_with_window(sink, hwnd))
            .await
            .map_err(|join_error| format!("mpv engine spawn task failed: {join_error}"))?
            .map_err(|engine_error| engine_error.to_string())?;
    let conn = engine.conn();
    // Replay the latest frontend requests onto the new surface and publish it.
    // The requests lock is held across the publish so a concurrent set_rect
    // cannot slip between "request stored" and "surface published" and get
    // addressed to the previous surface.
    let surface = engine.render_surface().map(Arc::clone);
    {
        let requests = lock_surface_requests();
        if let Some(surface) = &surface {
            if let Some((x, y, w, h)) = requests.rect {
                if let Err(rect_error) = surface.set_rect(x, y, w, h) {
                    log::warn!("[player] replaying the stored rect failed: {rect_error}");
                }
            }
            if requests.visible {
                if let Err(visible_error) = surface.set_visible(true) {
                    log::warn!("[player] replaying the stored visibility failed: {visible_error}");
                }
            }
        }
        *lock_active_surface() = surface;
    }
    *guard = Some(engine);
    log::info!("[player] libmpv engine ready (conn {conn})");
    Ok(json!({ "conn": conn }))
}
