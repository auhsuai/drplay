use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

use super::ipc::MpvIpc;
use super::job;
use super::SharedMpv;

/// Handle for one running mpv sidecar: IPC connection + child process + the
/// kill-on-close job pinning the child to the app's lifetime. The job MUST be
/// stored here (not dropped after spawn): closing its last handle terminates
/// the sidecar, so it has to stay alive exactly as long as the child.
pub(super) struct MpvHandle {
    pub(super) ipc: Arc<MpvIpc>,
    pub(super) child: tokio::process::Child,
    #[allow(dead_code)]
    pub(super) job: job::JobHandle,
    pub(super) pipe_name: String,
}

impl MpvHandle {
    /// Reply of `mpv_spawn` (R2.2): the frontend adopts `conn` and drops
    /// every engine event tagged with an older connection id.
    pub(super) fn spawn_reply(&self) -> Value {
        json!({ "conn": self.ipc.current_conn() })
    }
}

/// Lazily create / fetch the mpv state slot for this app instance.
pub(super) fn mpv_state(app: &tauri::AppHandle) -> SharedMpv {
    if let Some(existing) = app.try_state::<SharedMpv>() {
        return existing.inner().clone();
    }
    app.manage(Arc::new(Mutex::new(None::<MpvHandle>)));
    app.state::<SharedMpv>().inner().clone()
}

/// Lock-scope core of every teardown path: take the sidecar handle out of the
/// slot and name the path that is about to close its kill-on-close job. Shared
/// by `mpv_spawn` (reaping a dead predecessor) and `mpv_shutdown`, split out of
/// them for the same reason as `running_ipc_from_state` — so the
/// close-attribution contract is testable without a Tauri app handle.
pub(super) fn take_labelled(
    slot: &mut Option<MpvHandle>,
    reason: &'static str,
) -> Option<MpvHandle> {
    slot.take().map(|mut handle| {
        handle.job.mark_teardown(reason);
        handle
    })
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
        let pid = handle.child.id().unwrap_or_default();
        // Observe the exit HERE, not only in `mpv_spawn`: a sidecar that was
        // already gone by the time the app exits is exactly the case worth
        // logging, and `mpv_spawn` only reports it when someone re-spawns.
        match handle.child.try_wait() {
            // Alive: signal termination. The slot keeps the reaped handle until
            // process teardown, when the closed job finishes any remainder via
            // KILL_ON_JOB_CLOSE.
            Ok(None) => {
                if let Err(kill_error) = handle.child.start_kill() {
                    log::warn!("[mpv] sync exit kill failed: {kill_error}");
                }
            }
            Ok(Some(status)) => {
                log::info!("[mpv] sidecar exited (pid {pid}, {status}) before the app-exit kill");
            }
            Err(poll_error) => {
                log::warn!("[mpv] failed to poll the sidecar during the app-exit kill: {poll_error}");
            }
        }
    }
}

/// Lock-scope core of `running_ipc`, split out so the "lock released before
/// the round-trip" property is testable without a Tauri app handle.
pub(super) async fn running_ipc_from_state(state: &SharedMpv) -> Result<Arc<MpvIpc>, String> {
    let slot = state.lock().await;
    match slot.as_ref() {
        Some(handle) => Ok(Arc::clone(&handle.ipc)),
        None => Err("mpv is not running (call mpv_spawn first)".to_string()),
    }
}
