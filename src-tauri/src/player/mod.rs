//! Player engine dispatcher: routes the four `mpv_*` commands to the
//! in-process libmpv engine by default; the legacy mpv.exe sidecar is used
//! when `DRPLAY_PLAYER_ENGINE=legacy|sidecar` asks for it, when the startup
//! probe cannot find `libmpv-2.dll`, or when libmpv fails to spawn (silent
//! fallback, logged only). The command/event wire contract
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

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::mpv::EventSink;

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

/// Same rejection string the legacy dispatcher uses when no sidecar exists
/// (mpv/handle.rs:95): the frontend reacts to the failure, and identical text
/// keeps app logs comparable between engines.
const NOT_RUNNING_ERROR: &str = "mpv is not running (call mpv_spawn first)";

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
fn startup_engine(preference: ActiveEngine, libmpv_ready: bool) -> ActiveEngine {
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
static LIFECYCLE_GATE: Mutex<()> = Mutex::const_new(());

fn engine_slot() -> &'static EngineSlot {
    ENGINE.get_or_init(|| Mutex::new(None))
}

// ---------------------------------------------------------------------------
// S3 video-surface requests (video_host_* commands in libmpv mode)
// ---------------------------------------------------------------------------

/// Tauri labels of the two windows that can own the composition surface.
const MAIN_WINDOW_LABEL: &str = "main";
const PIP_WINDOW_LABEL: &str = "pip";

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
/// requests; cleared before teardown. Lock order is SURFACE_OWNER ->
/// SURFACE_REQUESTS -> ACTIVE_SURFACE, keeping the publish atomic against
/// concurrent set_* calls.
static ACTIVE_SURFACE: StdMutex<Option<Arc<render::RenderSurface>>> = StdMutex::new(None);

/// Which webview window may mutate the active surface. The label is the Tauri
/// window label of the caller (never a frontend-supplied owner). During a
/// main <-> pip retarget BOTH sides are rejected until the switch settles.
struct SurfaceOwner {
    label: String,
    transitioning: bool,
}

static SURFACE_OWNER: LazyLock<StdMutex<SurfaceOwner>> = LazyLock::new(|| {
    StdMutex::new(SurfaceOwner {
        label: MAIN_WINDOW_LABEL.to_string(),
        transitioning: false,
    })
});

/// Bound for the acknowledged main <-> pip presentation switch. The render
/// thread drops the old D3D/DComp pipeline and builds a new one inside this
/// window; the retarget commands wait on the blocking pool, so this never
/// stalls the Tauri UI thread.
const RETARGET_TIMEOUT: Duration = Duration::from_secs(5);

fn lock_surface_requests() -> std::sync::MutexGuard<'static, SurfaceRequests> {
    SURFACE_REQUESTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn lock_active_surface() -> std::sync::MutexGuard<'static, Option<Arc<render::RenderSurface>>> {
    ACTIVE_SURFACE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn lock_surface_owner() -> std::sync::MutexGuard<'static, SurfaceOwner> {
    SURFACE_OWNER.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn reset_surface_owner() {
    let mut owner = lock_surface_owner();
    owner.label = MAIN_WINDOW_LABEL.to_string();
    owner.transitioning = false;
}

/// After a libmpv spawn failure the legacy sidecar takes over, but the native
/// host window it paints into was never created — the frontend had acquired
/// the libmpv composition surface instead. Replay the recorded acquire/rect/
/// visible on the MAIN thread (child window creation needs the message pump)
/// before the sidecar spawns. A session with no recorded request (audio-only)
/// needs no window and is left alone.
pub(crate) async fn replay_surface_after_fallback(app: &tauri::AppHandle) {
    let request = *lock_surface_requests();
    if request.rect.is_none() && !request.visible {
        return;
    }
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let app_for_main = app.clone();
    let dispatched = app.run_on_main_thread(move || {
        let hwnd = crate::video_host::video_host_acquire(app_for_main.clone());
        if hwnd == 0 {
            log::error!("[player] fallback: legacy video host could not be acquired");
        } else {
            if let Some((x, y, w, h)) = request.rect {
                crate::video_host::video_host_set_rect_for(
                    MAIN_WINDOW_LABEL,
                    x as i64,
                    y as i64,
                    w as i64,
                    h as i64,
                );
            }
            if request.visible {
                crate::video_host::video_host_set_visible_for(
                    MAIN_WINDOW_LABEL,
                    &app_for_main,
                    true,
                );
            }
        }
        let _ = done_tx.send(());
    });
    match dispatched {
        Ok(()) => {
            if done_rx.await.is_err() {
                log::error!("[player] fallback: legacy surface replay did not complete");
            }
        }
        Err(dispatch_error) => {
            log::error!("[player] fallback: cannot dispatch the legacy surface replay: {dispatch_error}");
        }
    }
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

/// `video_host_set_rect` in libmpv mode: reject non-owner callers, then record
/// and forward to the live surface. The owner lock is held through the forward
/// so a retarget cannot clear/switch the surface underneath an accepted request.
pub(crate) fn video_surface_set_rect_from(owner: &str, x: i64, y: i64, w: i64, h: i64) {
    let (x, y, w, h) = crate::video_host::clamp_rect(x, y, w, h);
    let owner_guard = lock_surface_owner();
    if owner_guard.transitioning || owner_guard.label != owner {
        log::debug!(
            "[player] surface set_rect from '{owner}' rejected: current owner '{}', transitioning={}",
            owner_guard.label,
            owner_guard.transitioning
        );
        return;
    }
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

/// `video_host_set_visible` in libmpv mode: same owner gate, record + forward.
pub(crate) fn video_surface_set_visible_from(owner: &str, visible: bool) {
    let owner_guard = lock_surface_owner();
    if owner_guard.transitioning || owner_guard.label != owner {
        log::debug!(
            "[player] surface set_visible({visible}) from '{owner}' rejected: current owner '{}', transitioning={}",
            owner_guard.label,
            owner_guard.transitioning
        );
        return;
    }
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

/// Retarget the composition presentation to a different window's HWND (main <-> pip).
/// Resets stored geometry/visibility; caller must supply new geometry afterwards.
/// Blocks for the acknowledged switch: the command wrappers call this on the
/// blocking pool, never on the Tauri UI thread. `destination` is the Tauri
/// window label that will own the surface; only "main" and "pip" are valid.
pub(crate) fn video_surface_retarget(hwnd: usize, destination: &str) -> Result<(), String> {
    let destination = match destination {
        MAIN_WINDOW_LABEL => MAIN_WINDOW_LABEL,
        PIP_WINDOW_LABEL => PIP_WINDOW_LABEL,
        other => {
            log::warn!("[player] retarget rejected: unsupported destination '{other}'");
            return Err(format!("unsupported retarget destination: {other}"));
        }
    };
    let surface = lock_active_surface().clone().ok_or_else(|| {
        "no active render surface to retarget".to_string()
    })?;
    // Capture the last accepted requests BEFORE clearing them. Clear before the
    // request is sent so stale main-window geometry can never be applied to the
    // new (pip) target, but restore them if the switch fails: the render thread
    // rolls back to a freshly created, hidden surface, and a stored "none /
    // false" would otherwise leave it hidden until something else speaks.
    // The owner lock is held while transitioning is raised and requests are
    // cleared: an accepted set_* holds it through its forward, so nothing can
    // slip between the gate check and the switch.
    let (previous_label, previous) = {
        let mut owner = lock_surface_owner();
        if owner.transitioning {
            log::warn!(
                "[player] retarget to '{destination}' rejected: a surface retarget is already in progress"
            );
            return Err("a surface retarget is already in progress".to_string());
        }
        let previous_label = owner.label.clone();
        owner.transitioning = true;
        let mut requests = lock_surface_requests();
        let previous = *requests;
        requests.rect = None;
        requests.visible = false;
        (previous_label, previous)
    };
    match surface.retarget(hwnd, RETARGET_TIMEOUT) {
        Ok(()) => {
            let mut owner = lock_surface_owner();
            owner.label = destination.to_string();
            owner.transitioning = false;
            log::info!("[player] video surface owner is now '{destination}'");
            Ok(())
        }
        Err(error) => {
            let mut owner = lock_surface_owner();
            owner.label = previous_label;
            owner.transitioning = false;
            {
                let mut requests = lock_surface_requests();
                *requests = previous;
            }
            // Best-effort replay onto the rolled-back pipeline. The frontend
            // also re-sends when it reverts the surface owner, but this closes
            // the gap (and covers a lost owner-changed event). On a timeout the
            // render surface has already queued a compensating retarget BEHIND
            // the stale switch, so these requests land after it in queue order.
            // The owner lock stays held so a newer accepted request cannot be
            // overwritten by this older stored one.
            if let Some((x, y, w, h)) = previous.rect {
                if let Err(rect_error) = surface.set_rect(x, y, w, h) {
                    log::warn!("[player] restoring the pre-retarget rect failed: {rect_error}");
                }
            }
            if previous.visible {
                if let Err(visible_error) = surface.set_visible(true) {
                    log::warn!(
                        "[player] restoring the pre-retarget visibility failed: {visible_error}"
                    );
                }
            }
            Err(error.to_string())
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
async fn shutdown_slot(slot: &EngineSlot, gate: &Mutex<()>) -> Result<(), String> {
    let _gate = gate.lock().await;
    let Some(engine) = slot.lock().await.take() else {
        return Ok(());
    };
    // Stop forwarding surface requests before the render thread goes down.
    *lock_active_surface() = None;
    reset_surface_owner();
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
    *lock_active_surface() = None;
    reset_surface_owner();
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
        *lock_active_surface() = None;
        reset_surface_owner();
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
    reset_surface_owner();
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
