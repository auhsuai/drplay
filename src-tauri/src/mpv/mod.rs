//! mpv sidecar engine: process lifecycle + JSON IPC exposed as Tauri commands.
//!
//! Events emitted to the frontend:
//! - `mpv-property` → `{ name: String, data: Value }` (mpv `property-change`)
//! - `mpv-event`    → `{ event: String, reason: Option<String> }` (`end-file`, `shutdown`, ...)

mod ipc;
mod process;

use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

use ipc::{EventSink, IpcMessage, MpvIpc};

/// Properties observed right after spawn as `(observe id, mpv property name)`.
/// The ids are stable handles chosen by us; the names map 1:1 to mpv properties.
const OBSERVED_PROPERTIES: &[(u64, &str)] = &[
    (1, "time-pos"),
    (2, "duration"),
    (3, "pause"),
    (4, "paused-for-cache"),
    (5, "demuxer-cache-state"),
];

/// Handle for one running mpv sidecar: IPC connection + child process.
struct MpvHandle {
    ipc: MpvIpc,
    child: tokio::process::Child,
    pipe_name: String,
}

/// Shared slot holding the running mpv instance (`None` = not spawned).
type SharedMpv = Arc<Mutex<Option<MpvHandle>>>;

/// Lazily create / fetch the mpv state slot for this app instance.
fn mpv_state(app: &tauri::AppHandle) -> SharedMpv {
    if let Some(existing) = app.try_state::<SharedMpv>() {
        return existing.inner().clone();
    }
    app.manage(Arc::new(Mutex::new(None::<MpvHandle>)));
    app.state::<SharedMpv>().inner().clone()
}

/// Commands without an `AppHandle` parameter (per contract) resolve the app
/// through the global handle captured at startup.
fn app_handle() -> Result<&'static tauri::AppHandle, String> {
    crate::APP_HANDLE.get().ok_or_else(|| "mpv: app handle not initialized yet".to_string())
}

/// Map IPC messages to the frontend event names fixed by the contract.
fn event_sink(app: tauri::AppHandle) -> EventSink {
    use tauri::Emitter;
    Arc::new(move |message: IpcMessage| match message {
        IpcMessage::PropertyChange { name, data } => {
            let _ = app.emit("mpv-property", json!({ "name": name, "data": data }));
        }
        IpcMessage::MpvEvent { event, reason } => {
            let _ = app.emit("mpv-event", json!({ "event": event, "reason": reason }));
        }
    })
}

/// Spawn the mpv sidecar, connect the JSON IPC pipe and start observing the
/// default property set. Idempotent: a healthy running sidecar makes this a
/// no-op; a crashed one is reaped and replaced.
#[tauri::command]
pub async fn mpv_spawn(app: tauri::AppHandle) -> Result<(), String> {
    let state = mpv_state(&app);
    let mut slot = state.lock().await;

    if let Some(handle) = slot.as_mut() {
        match handle.child.try_wait() {
            // Still alive → already spawned, nothing to do.
            Ok(None) => return Ok(()),
            Ok(Some(status)) => log::warn!("[mpv] previous sidecar exited ({status}); respawning"),
            Err(poll_error) => {
                log::warn!("[mpv] failed to poll previous sidecar: {poll_error}; respawning")
            }
        }
        slot.take();
    }

    let pipe_name = process::new_pipe_name();
    let mut child = process::spawn_mpv(&pipe_name)?;
    let client = match process::connect_pipe(&pipe_name).await {
        Ok(client) => client,
        Err(connect_error) => {
            if let Err(kill_error) = child.start_kill() {
                log::error!("[mpv] failed to kill sidecar after pipe connect failure: {kill_error}");
            }
            return Err(connect_error);
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
            return Err(format!("mpv spawn failed while observing {property}: {observe_error}"));
        }
    }

    log::info!("[mpv] sidecar ready (pipe: {pipe_name})");
    *slot = Some(MpvHandle { ipc, child, pipe_name });
    Ok(())
}

/// Run one mpv IPC command, e.g. `["loadfile", url, "replace"]` or
/// `["seek", "42", "absolute"]`. Returns mpv's `data` payload on success.
#[tauri::command]
pub async fn mpv_command(cmd: Vec<String>) -> Result<Value, String> {
    let args: Vec<Value> = cmd.into_iter().map(Value::String).collect();
    let slot = running_ipc().await?;
    let handle = slot.as_ref().ok_or_else(|| "mpv is not running (call mpv_spawn first)".to_string())?;
    handle.ipc.send_command(args).await
}

/// Read one mpv property, e.g. `time-pos`. Returns the property value.
#[tauri::command]
pub async fn mpv_get_property(prop: String) -> Result<Value, String> {
    let slot = running_ipc().await?;
    let handle = slot.as_ref().ok_or_else(|| "mpv is not running (call mpv_spawn first)".to_string())?;
    handle.ipc.send_command(vec![json!("get_property"), json!(prop)]).await
}

/// Stop the sidecar. Safe to call when nothing is running.
#[tauri::command]
pub async fn mpv_shutdown() -> Result<(), String> {
    let app = app_handle()?;
    let state = mpv_state(app);
    let mut slot = state.lock().await;
    let Some(mut handle) = slot.take() else {
        return Ok(());
    };
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

/// Lock the state slot (owned guard, so the slot outlives this helper) and
/// reject the call when no sidecar has been spawned yet.
async fn running_ipc() -> Result<tokio::sync::OwnedMutexGuard<Option<MpvHandle>>, String> {
    let app = app_handle()?;
    let state = mpv_state(app);
    let slot = Arc::clone(&state).lock_owned().await;
    if slot.as_ref().is_none() {
        return Err("mpv is not running (call mpv_spawn first)".to_string());
    }
    Ok(slot)
}
