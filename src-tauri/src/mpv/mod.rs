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

mod ipc;
mod job;
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

/// Handle for one running mpv sidecar: IPC connection + child process + the
/// kill-on-close job pinning the child to the app's lifetime. The job MUST be
/// stored here (not dropped after spawn): closing its last handle terminates
/// the sidecar, so it has to stay alive exactly as long as the child.
struct MpvHandle {
    ipc: Arc<MpvIpc>,
    child: tokio::process::Child,
    #[allow(dead_code)]
    job: job::JobHandle,
    pipe_name: String,
}

impl MpvHandle {
    /// Reply of `mpv_spawn` (R2.2): the frontend adopts `conn` and drops
    /// every engine event tagged with an older connection id.
    fn spawn_reply(&self) -> Value {
        json!({ "conn": self.ipc.current_conn() })
    }
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
    let state = mpv_state(&app);
    let mut slot = state.lock().await;

    if let Some(handle) = slot.as_mut() {
        match handle.child.try_wait() {
            // Still alive → already spawned, nothing to do.
            Ok(None) => return Ok(handle.spawn_reply()),
            Ok(Some(status)) => log::warn!("[mpv] previous sidecar exited ({status}); respawning"),
            Err(poll_error) => {
                log::warn!("[mpv] failed to poll previous sidecar: {poll_error}; respawning")
            }
        }
        slot.take();
    }

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
    let job = spawned.job;
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
    let args: Vec<Value> = cmd.into_iter().map(Value::String).collect();
    let ipc = running_ipc().await?;
    let data = ipc.send_command(args).await?;
    Ok(json!({ "data": data, "load_epoch": ipc.current_epoch() }))
}

/// Read one mpv property, e.g. `time-pos`. Returns the property value.
#[tauri::command]
pub async fn mpv_get_property(prop: String) -> Result<Value, String> {
    let ipc = running_ipc().await?;
    ipc.send_command(vec![json!("get_property"), json!(prop)]).await
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

/// Best-effort synchronous kill for process-exit paths (`RunEvent::Exit`,
/// tray Quit) that cannot `.await` the async `mpv_shutdown`. Non-blocking by
/// design: `try_lock` never waits (a contended lock means the async owner is
/// shutting down already) and `start_kill` only signals termination. The Job
/// Object is the real orphan guarantee here — this just speeds the graceful
/// quit so `mpv.exe` is gone within ~ms instead of at handle teardown.
pub(crate) fn mpv_kill_sync_best_effort(app: &tauri::AppHandle) {
    let state = mpv_state(app);
    let Ok(mut slot) = state.try_lock() else {
        return;
    };
    if let Some(handle) = slot.as_mut() {
        // Already exited (or unpollable): nothing to kill; the slot keeps the
        // reaped handle until process teardown, when the closed job finishes
        // any remainder via KILL_ON_JOB_CLOSE.
        if let Ok(None) = handle.child.try_wait() {
            if let Err(kill_error) = handle.child.start_kill() {
                log::warn!("[mpv] sync exit kill failed: {kill_error}");
            }
        }
    }
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

/// Lock-scope core of `running_ipc`, split out so the "lock released before
/// the round-trip" property is testable without a Tauri app handle.
async fn running_ipc_from_state(state: &SharedMpv) -> Result<Arc<MpvIpc>, String> {
    let slot = state.lock().await;
    match slot.as_ref() {
        Some(handle) => Ok(Arc::clone(&handle.ipc)),
        None => Err("mpv is not running (call mpv_spawn first)".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    type TestServer = tokio::net::windows::named_pipe::NamedPipeServer;

    /// A live `MpvHandle` around a test pipe, plus the server half so the test
    /// plays mpv's side. The child is a placeholder pinned to a kill-on-close
    /// job; nothing here talks to it — the IPC pipe is the test's own.
    async fn test_handle(pipe_name: &str) -> (MpvHandle, TestServer) {
        let server = tokio::net::windows::named_pipe::ServerOptions::new()
            .create(pipe_name)
            .expect("test pipe server must be created");
        let client = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(pipe_name)
            .expect("test pipe client must connect");
        let sink: EventSink = Arc::new(|_, _, _| {});
        let ipc = MpvIpc::new(client, sink);
        let child = tokio::process::Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("dummy child must spawn");
        let job = job::JobHandle::create_with_kill_on_close().expect("job must be created");
        job.assign(&child).expect("dummy child must join the job");
        (MpvHandle { ipc: Arc::new(ipc), child, job, pipe_name: pipe_name.to_string() }, server)
    }

    /// Play mpv's side of one command round-trip: read the frame, report it
    /// (`frame_seen`), wait for the go-ahead, then reply success with `data: 7`.
    async fn answer_one_command(
        server: TestServer,
        frame_seen: tokio::sync::oneshot::Sender<()>,
        reply_go: tokio::sync::oneshot::Receiver<()>,
    ) {
        server.connect().await.expect("server must accept the client");
        let (read_half, mut write_half) = tokio::io::split(server);
        let mut reader = tokio::io::BufReader::new(read_half);
        let mut frame = String::new();
        reader.read_line(&mut frame).await.expect("the command frame must arrive");
        let request_id = serde_json::from_str::<Value>(frame.trim_end())
            .expect("the frame must be JSON")["request_id"]
            .as_u64()
            .expect("the frame must carry a request_id");
        frame_seen.send(()).expect("the test must still be waiting");
        reply_go.await.expect("the test must release the reply");
        let reply = format!(r#"{{"error":"success","data":7,"request_id":{request_id}}}"#);
        write_half.write_all(reply.as_bytes()).await.expect("the reply must be writable");
        write_half.write_all(b"\n").await.expect("the reply newline must be writable");
        write_half.flush().await.expect("the reply must flush");
    }

    /// Regression (R9): while a command round-trip is in flight the state lock
    /// must be free — `mpv_spawn` / `mpv_shutdown` take it and used to queue
    /// behind every command for up to the IPC timeout.
    #[tokio::test]
    async fn command_round_trip_does_not_hold_the_state_lock() {
        let pipe_name = format!(r"\\.\pipe\drplay-mpv-lock-scope-{}", std::process::id());
        let (handle, server) = test_handle(&pipe_name).await;
        let state: SharedMpv = Arc::new(Mutex::new(Some(handle)));

        // Exactly what a command call site does: resolve the IPC handle...
        let ipc = running_ipc_from_state(&state).await.expect("a running sidecar must resolve");

        // ...then run the round-trip. The server reads the frame and holds the
        // reply back, so the command is in flight during the assertion.
        let (frame_seen_tx, frame_seen_rx) = tokio::sync::oneshot::channel();
        let (reply_go_tx, reply_go_rx) = tokio::sync::oneshot::channel();
        let responder = tokio::spawn(answer_one_command(server, frame_seen_tx, reply_go_rx));

        let command = tokio::spawn(async move { ipc.send_command(vec![json!("pause")]).await });
        frame_seen_rx.await.expect("the command must reach the peer");

        assert!(
            state.try_lock().is_ok(),
            "the state lock must be released while a command round-trip is in flight"
        );

        reply_go_tx.send(()).expect("the responder must be waiting");
        let data =
            command.await.expect("the command task must not panic").expect("the command must succeed");
        assert_eq!(data, json!(7));
        responder.await.expect("the responder must finish");
    }

    /// A resolved handle must outlive a slot swap: the restart path takes the
    /// handle out of the slot while a command may still be in flight, and the
    /// clone's connection must stay usable on its own.
    #[tokio::test]
    async fn a_resolved_handle_survives_a_slot_swap() {
        let pipe_name = format!(r"\\.\pipe\drplay-mpv-swap-{}", std::process::id());
        let (handle, server) = test_handle(&pipe_name).await;
        let state: SharedMpv = Arc::new(Mutex::new(Some(handle)));

        let ipc = running_ipc_from_state(&state).await.expect("a running sidecar must resolve");
        // The control path (shutdown/spawn) empties the slot; that lock is
        // free because the command call site already released it.
        assert!(state.lock().await.take().is_some(), "the test must own one handle");

        let (frame_seen_tx, _frame_seen_rx) = tokio::sync::oneshot::channel();
        let (reply_go_tx, reply_go_rx) = tokio::sync::oneshot::channel();
        let responder = tokio::spawn(answer_one_command(server, frame_seen_tx, reply_go_rx));
        reply_go_tx.send(()).expect("the responder must accept the go signal");

        let data = ipc
            .send_command(vec![json!("get_property"), json!("pause")])
            .await
            .expect("the connection held by the clone must stay usable after the slot swap");
        assert_eq!(data, json!(7));
        responder.await.expect("the responder must finish");
    }

    // --- connection identity (R2.2 — RC-6) -----------------------------------

    /// The `mpv_spawn` reply must carry the new connection's identity so the
    /// frontend can filter engine events by it (B1/RC-1): events of a replaced
    /// connection never drive the fresh engine state.
    #[tokio::test]
    async fn spawn_reply_carries_the_connection_identity() {
        let pipe_name = format!(r"\\.\pipe\drplay-mpv-spawn-reply-{}", std::process::id());
        let (handle, _server) = test_handle(&pipe_name).await;

        let reply = handle.spawn_reply();

        let conn = reply["conn"].as_u64().expect("the reply must carry a numeric conn");
        assert_eq!(conn, handle.ipc.current_conn(), "conn must be the handle's own connection");
        assert!(conn >= 1, "connection ids start at 1, got {conn}");
    }

    /// The rejection path must not keep the lock either.
    #[tokio::test]
    async fn running_ipc_rejects_when_no_sidecar_is_spawned() {
        let state: SharedMpv = Arc::new(Mutex::new(None));
        let error = match running_ipc_from_state(&state).await {
            Ok(_) => panic!("an empty slot must reject the command"),
            Err(error) => error,
        };
        assert!(error.contains("mpv is not running"), "got: {error}");
        assert!(state.try_lock().is_ok(), "the rejection path must not keep the lock");
    }
}
