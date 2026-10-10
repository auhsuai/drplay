//! mpv sidecar engine: process lifecycle + JSON IPC exposed as Tauri commands.
//!
//! Events emitted to the frontend:
//! - `mpv-property` → `{ name: String, data: Value, epoch: u64, conn: u64 }` (mpv `property-change`)
//! - `mpv-event`    → `{ event: String, reason: Option<String>, error: Option<String>, epoch: u64, conn: u64 }`
//!   (`end-file`, `shutdown`, ...) plus `ipc-closed` when the pipe ends
//!
//! `epoch` is additive: the load epoch current when the message was
//! dispatched. It increments once per dispatched `loadfile` reply (see
//! `ipc.rs`), letting the frontend drop events that predate the latest
//! requested load. `conn` is additive too: the identity of the connection
//! (one per spawned sidecar, monotonic process-wide), letting the frontend
//! drop every event of a replaced connection — the per-connection epoch base
//! resets on respawn, so it alone cannot tell the old connection's events
//! apart (B1/RC-1). Consumers that ignore the fields keep working.

mod handle;
mod ipc;
mod job;
mod process;

use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

use handle::{mpv_state, running_ipc_from_state, take_labelled, MpvHandle};
pub(crate) use handle::mpv_kill_sync_best_effort;
// Wire types shared with the in-process libmpv engine dispatcher
// (src/player): both engines must emit the same message shapes through the
// same sink type — single source of truth for the frozen contract.
pub(crate) use ipc::{EventSink, IpcMessage};
use ipc::MpvIpc;

/// Properties observed right after spawn as `(observe id, mpv property name)`.
/// The ids are stable handles chosen by us; the names map 1:1 to mpv properties.
/// Shared with the libmpv engine (src/player/engine.rs), which observes the
/// same set so both engines emit identical property-change events.
pub(crate) const OBSERVED_PROPERTIES: &[(u64, &str)] = &[
    (1, "time-pos"),
    (2, "duration"),
    (3, "pause"),
    (4, "paused-for-cache"),
    (5, "demuxer-cache-state"),
];

/// Shared slot holding the running mpv instance (`None` = not spawned).
type SharedMpv = Arc<Mutex<Option<MpvHandle>>>;

/// Commands without an `AppHandle` parameter (per contract) resolve the app
/// through the global handle captured at startup.
fn app_handle() -> Result<&'static tauri::AppHandle, String> {
    crate::APP_HANDLE.get().ok_or_else(|| "mpv: app handle not initialized yet".to_string())
}

/// Map IPC messages to the frontend event names fixed by the contract.
/// Shared with the libmpv engine dispatcher (src/player): one mapper keeps
/// both engines byte-identical on the wire.
pub(crate) fn event_sink(app: tauri::AppHandle) -> EventSink {
    use tauri::Emitter;
    Arc::new(move |message: IpcMessage, epoch: u64, conn: u64| match message {
        IpcMessage::PropertyChange { name, data } => {
            let _ =
                app.emit("mpv-property", json!({ "name": name, "data": data, "epoch": epoch, "conn": conn }));
        }
        IpcMessage::MpvEvent { event, reason, error } => {
            let _ = app.emit(
                "mpv-event",
                json!({ "event": event, "reason": reason, "error": error, "epoch": epoch, "conn": conn }),
            );
        }
        IpcMessage::ConnectionClosed { cause } => {
            let _ = app.emit(
                "mpv-event",
                json!({ "event": "ipc-closed", "reason": cause, "error": null, "epoch": epoch, "conn": conn }),
            );
        }
    })
}

/// Spawn the mpv sidecar, connect the JSON IPC pipe and start observing the
/// default property set. Idempotent: a healthy running sidecar makes this a
/// no-op; a crashed one is reaped and replaced. The reply carries the
/// connection identity (`{ "conn": u64 }`) the frontend filters engine events
/// by — including the no-op path, which answers with the running handle's id.
#[tauri::command]
pub async fn mpv_spawn(app: tauri::AppHandle) -> Result<Value, String> {
    // Engine selection is a runtime switch (S1 migration): libmpv mode routes
    // to the in-process engine, anything else keeps the legacy sidecar.
    if crate::player::is_libmpv_mode() {
        return crate::player::spawn(&app).await;
    }
    let state = mpv_state(&app);
    let mut slot = state.lock().await;

    if let Some(handle) = slot.as_mut() {
        let pid = handle.child.id().unwrap_or_default();
        match handle.child.try_wait() {
            // Still alive → already spawned, nothing to do.
            Ok(None) => return Ok(handle.spawn_reply()),
            // Log the observed death where it is observed (pid + status), not
            // only "previous sidecar exited" — the pid is what ties the death
            // to the job that pinned it.
            Ok(Some(status)) => log::info!("[mpv] sidecar exited (pid {pid}, {status}); respawning"),
            Err(poll_error) => {
                log::warn!("[mpv] failed to poll previous sidecar: {poll_error}; respawning")
            }
        }
    }
    // Release the previous handle, if any: dropping it closes its job, and that
    // close IS the kill, so it is labelled with the path that closed it.
    drop(take_labelled(&mut slot, "mpv_spawn_respawn"));

    let pipe_name = process::new_pipe_name();
    // Sidecar log (F2, 2026-09-17 freeze report): with stdout/stderr null a
    // wedged playback chain leaves zero evidence. The log lives next to the
    // app log; spawn_mpv rotates the previous session to `mpv.1` first.
    let mpv_log = app
        .path()
        .app_log_dir()
        .ok()
        .map(|dir| dir.join(process::MPV_LOG_FILE_NAME));
    if mpv_log.is_none() {
        log::warn!("[mpv] app log dir unavailable — the sidecar will run without its own log");
    }
    let spawned = process::spawn_mpv(&pipe_name, mpv_log.as_deref())?;
    let mut child = spawned.child;
    let mut job = spawned.job;
    let client = match process::connect_pipe(&pipe_name).await {
        Ok(client) => client,
        Err(connect_error) => {
            // A dead child is the difference between "slow start" and "failed
            // to start" — surface its exit status instead of a blind timeout.
            let early_exit = child.try_wait().ok().flatten();
            if let Some(status) = &early_exit {
                log::error!("[mpv] sidecar exited early: {status}");
            }
            if let Err(kill_error) = child.start_kill() {
                log::error!("[mpv] failed to kill sidecar after pipe connect failure: {kill_error}");
            }
            // `job` drops on the way out and closes the (still-killed) job.
            job.mark_teardown("mpv_spawn_pipe_connect_failed");
            return Err(match &early_exit {
                Some(status) => format!("{connect_error} (mpv exited early: {status})"),
                None => connect_error,
            });
        }
    };

    let ipc = MpvIpc::new(client, event_sink(app.clone()));
    for &(observe_id, property) in OBSERVED_PROPERTIES {
        if let Err(observe_error) = ipc
            .send_command(vec![
                json!("observe_property"),
                json!(observe_id),
                json!(property),
            ])
            .await
        {
            // A fresh pipe failing immediately means mpv died at startup.
            let _ = child.start_kill();
            job.mark_teardown("mpv_spawn_observe_failed");
            return Err(format!("mpv spawn failed while observing {property}: {observe_error}"));
        }
    }

    log::info!("[mpv] sidecar ready (pipe: {pipe_name})");
    let handle = MpvHandle { ipc: Arc::new(ipc), child, job, pipe_name };
    let reply = handle.spawn_reply();
    *slot = Some(handle);
    Ok(reply)
}

/// Run one mpv IPC command, e.g. `["loadfile", url, "replace"]` or
/// `["seek", "42", "absolute"]`. Returns `{ "data": <mpv data>, "load_epoch":
/// <u64> }`: `data` keeps mpv's payload (unchanged), `load_epoch` is the
/// additive identity tag the frontend reads to stamp engine events
/// (`ipc.rs`). For a `loadfile` the epoch already includes that load's bump
/// by the time this resolves.
#[tauri::command]
pub async fn mpv_command(cmd: Vec<String>) -> Result<Value, String> {
    if crate::player::is_libmpv_mode() {
        return crate::player::command(cmd).await;
    }
    let args: Vec<Value> = cmd.into_iter().map(Value::String).collect();
    let ipc = running_ipc().await?;
    let data = ipc.send_command(args).await?;
    Ok(json!({ "data": data, "load_epoch": ipc.current_epoch() }))
}

/// Read one mpv property, e.g. `time-pos`. Returns the property value.
#[tauri::command]
pub async fn mpv_get_property(prop: String) -> Result<Value, String> {
    if crate::player::is_libmpv_mode() {
        return crate::player::get_property(prop).await;
    }
    let ipc = running_ipc().await?;
    ipc.send_command(vec![json!("get_property"), json!(prop)]).await
}

/// Stop the sidecar. Safe to call when nothing is running.
#[tauri::command]
pub async fn mpv_shutdown() -> Result<(), String> {
    if crate::player::is_libmpv_mode() {
        return crate::player::shutdown().await;
    }
    let app = app_handle()?;
    let state = mpv_state(app);
    let mut slot = state.lock().await;
    let Some(mut handle) = take_labelled(&mut slot, "mpv_shutdown") else {
        return Ok(());
    };
    // The pipe close that follows is commanded, not an engine failure: tell
    // the reader so the frontend does not see `ipc-closed` (the load-deadline
    // sidecar restart keeps its listeners and state across this swap).
    handle.ipc.mark_shutdown_requested();
    // mpv keeps no persistent state here (cache is in-memory), so a hard kill
    // is the reliable shutdown path; watch-later is not configured.
    if let Err(kill_error) = handle.child.start_kill() {
        match handle.child.try_wait() {
            Ok(Some(_)) => log::info!("[mpv] sidecar already exited before kill"),
            _ => return Err(format!("mpv shutdown: failed to kill sidecar: {kill_error}")),
        }
    }
    let _ = handle.child.wait().await; // reap the child either way
    log::info!("[mpv] sidecar shut down (pipe: {})", handle.pipe_name);
    Ok(())
}

/// Clone the running sidecar's IPC handle (releasing the state lock before
/// any round-trip) and reject the call when no sidecar has been spawned yet.
/// Holding the lock across a command round-trip used to stall the control
/// paths (`mpv_spawn` / `mpv_shutdown`) that take the same lock for up to
/// `IPC_COMMAND_TIMEOUT_SECS`; the Arc keeps this connection alive for the
/// round-trip even if the slot is swapped underneath.
async fn running_ipc() -> Result<Arc<MpvIpc>, String> {
    let app = app_handle()?;
    let state = mpv_state(app);
    running_ipc_from_state(&state).await
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod video_lifecycle;
