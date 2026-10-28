//! S3 native composition surface bookkeeping: the single owner of
//! `SURFACE_REQUESTS`, `SURFACE_OWNER` and `ACTIVE_SURFACE` (plan 20 §2.3).
//!
//! This module must NEVER depend on `super::lifecycle` / `ENGINE` /
//! `LIFECYCLE_GATE`: lifecycle holds the gate while it calls the helpers
//! below, and a re-entrant gate lock on a non-reentrant `tokio::sync::Mutex`
//! deadlocks (plan 20 §3.4, D2).

use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Duration;

use super::render;

// ---------------------------------------------------------------------------
// S3 video-surface requests (video_host_* commands in libmpv mode)
// ---------------------------------------------------------------------------

/// Tauri labels of the two windows that can own the composition surface.
const MAIN_WINDOW_LABEL: &str = "main";
const PIP_WINDOW_LABEL: &str = "pip";

/// Wire contract of the two retarget commands. [`RetargetOutcome::Retargeted`]
/// is the ONLY value that may let the frontend treat the hand-off as done.
///
/// The render thread has three native end states, not two: the new target was
/// built, the old target was rebuilt after a failed switch (`RolledBack`), or
/// no target exists at all (`Detached`). The last two both leave the native
/// owner on the PREVIOUS window, so they are not successes — but collapsing
/// them into one opaque error hides which failure the frontend is recovering
/// from (and `Detached` means there is no video output at all).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RetargetOutcome {
    Retargeted,
    RolledBack,
    Detached,
}

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

/// Lifecycle hook for "stop forwarding surface requests": drop the published
/// surface, then put the owner back on the main window. Two separate
/// statements on purpose — each guard is released before the next lock, so
/// this stays ACTIVE -> OWNER one-liners instead of holding a guard across
/// the next lock (plan 20 D3).
pub(super) fn clear_active_surface_and_reset_owner() {
    *lock_active_surface() = None;
    reset_surface_owner();
}

/// Lifecycle hook for a freshly created engine: it always targets the main
/// window, so only the owner is reset (the stored requests are kept and
/// replayed by `publish_surface_and_replay`).
pub(super) fn reset_owner_only() {
    reset_surface_owner();
}

/// Publish the new render surface and replay the latest frontend requests onto
/// it. The requests lock is held across the publish so a concurrent set_rect
/// cannot slip between "request stored" and "surface published" and get
/// addressed to the previous surface. Must stay ONE function (plan 20 D5).
pub(super) fn publish_surface_and_replay(surface: Option<Arc<render::RenderSurface>>) {
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
pub(crate) fn video_surface_retarget(
    hwnd: usize,
    destination: &str,
) -> Result<RetargetOutcome, String> {
    let destination = match destination {
        MAIN_WINDOW_LABEL => MAIN_WINDOW_LABEL,
        PIP_WINDOW_LABEL => PIP_WINDOW_LABEL,
        other => {
            log::warn!("[player] retarget rejected: unsupported destination '{other}'");
            return Err(format!("unsupported retarget destination: {other}"));
        }
    };
    // Temporary guard: dropped at the end of this statement, BEFORE the owner
    // lock below (order is OWNER -> REQUESTS -> ACTIVE).
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
        Ok(RetargetOutcome::Retargeted) => {
            let mut owner = lock_surface_owner();
            owner.label = destination.to_string();
            owner.transitioning = false;
            log::info!("[player] video surface owner is now '{destination}'");
            Ok(RetargetOutcome::Retargeted)
        }
        Ok(outcome) => {
            // Rolled back or detached: the native owner stays the PREVIOUS
            // window (a rebuilt target, or none at all), so the frontend keeps
            // ownership where it is and gets to see WHICH failure this was.
            restore_after_failed_retarget(&surface, previous_label, previous);
            Ok(outcome)
        }
        Err(error) => {
            // Timeout / disconnected: UNRESOLVED, never success. Same recovery
            // as a typed failure, but the frontend gets the error instead.
            restore_after_failed_retarget(&surface, previous_label, previous);
            Err(error.to_string())
        }
    }
}

/// Undo a retarget that did not land: put the owner back on the previous
/// window, restore the stored requests and replay them onto the pipeline the
/// render thread left behind. Shared by the two failure replies (typed outcome
/// and `Err`) so the recovery cannot drift between them.
///
/// Best-effort replay: the frontend also re-sends when it reverts the surface
/// owner, but this closes the gap (and covers a lost owner-changed event). On a
/// timeout the render surface has already queued a compensating retarget BEHIND
/// the stale switch, so these requests land after it in queue order. The owner
/// lock stays held so a newer accepted request cannot be overwritten by this
/// older stored one.
fn restore_after_failed_retarget(
    surface: &render::RenderSurface,
    previous_label: String,
    previous: SurfaceRequests,
) {
    let mut owner = lock_surface_owner();
    owner.label = previous_label;
    owner.transitioning = false;
    {
        let mut requests = lock_surface_requests();
        *requests = previous;
    }
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
