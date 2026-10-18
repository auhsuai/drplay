use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::super::ipc::{EventSink, IpcMessage, MpvIpc};
use super::super::process::{connect_pipe, new_pipe_name, spawn_mpv, MPV_LOG_FILE_NAME};
use super::observe::first_window;
use super::READY_TIMEOUT;

/// Budget for one IPC round-trip.
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Real mpv sidecar
// ---------------------------------------------------------------------------

/// A live sidecar, driven exactly the way the frontend drives it. Dropping it
/// kills mpv (the child is `kill_on_drop` and pinned to a kill-on-close job), so
/// a panicking test cannot orphan a process.
pub(super) struct Session {
    ipc: MpvIpc,
    child: tokio::process::Child,
    _job: super::super::job::JobHandle,
    pub(super) pid: u32,
    events: Arc<Mutex<Vec<IpcMessage>>>,
    pub(super) log_path: PathBuf,
}

impl Session {
    pub(super) async fn spawn(tag: &str) -> Session {
        let dir = std::env::temp_dir()
            .join(format!("drplay-video-probe-{}-{}", std::process::id(), tag));
        std::fs::create_dir_all(&dir).expect("probe log dir must be creatable");
        let log_path = dir.join(MPV_LOG_FILE_NAME);
        let pipe_name = new_pipe_name();
        let spawned = spawn_mpv(&pipe_name, Some(log_path.as_path())).expect("sidecar must spawn");
        let pid = spawned.child.id().expect("a spawned child has a pid");

        let client = connect_pipe(&pipe_name)
            .await
            .expect("the sidecar pipe must connect (bounded retry)");
        let events: Arc<Mutex<Vec<IpcMessage>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let events = Arc::clone(&events);
            Arc::new(move |message, _epoch, _conn| events.lock().expect("events lock").push(message))
        };
        Session {
            ipc: MpvIpc::new(client, sink),
            child: spawned.child,
            _job: spawned.job,
            pid,
            events,
            log_path,
        }
    }

    /// One IPC round-trip, bounded: a wedged engine surfaces as an Err instead
    /// of parking the test.
    pub(super) async fn command(&self, args: Vec<Value>) -> Result<Value, String> {
        tokio::time::timeout(QUERY_TIMEOUT, self.ipc.send_command(args))
            .await
            .map_err(|_elapsed| format!("mpv IPC timed out after {QUERY_TIMEOUT:?}"))?
    }

    pub(super) async fn property(&self, name: &str) -> Result<Value, String> {
        self.command(vec![json!("get_property"), json!(name)]).await
    }

    pub(super) async fn property_f64(&self, name: &str) -> Option<f64> {
        self.property(name).await.ok().and_then(|value| value.as_f64())
    }

    /// `mpvAudio.loadTrack` (src/lib/mpvAudio.ts:782-794) verbatim: `set_property
    /// video` FIRST, then `loadfile <proxy url> replace`. `video` is "1" for a
    /// video track and "no" for an audio one.
    pub(super) async fn load_like_the_app(&self, url: &str, video: bool) -> Result<Value, String> {
        self.command(vec![
            json!("set_property"),
            json!("video"),
            json!(if video { "1" } else { "no" }),
        ])
        .await?;
        self.command(vec![json!("loadfile"), json!(url), json!("replace")]).await
    }

    /// Poll a property until `predicate` holds.
    pub(super) async fn wait_property<F>(&self, name: &str, deadline: Duration, mut predicate: F) -> Option<Value>
    where
        F: FnMut(&Value) -> bool,
    {
        let stop = Instant::now() + deadline;
        loop {
            if let Ok(value) = self.property(name).await {
                if predicate(&value) {
                    return Some(value);
                }
            }
            if Instant::now() >= stop {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }

    pub(super) async fn wait_duration(&self) -> f64 {
        self.wait_property("duration", READY_TIMEOUT, |value| value.as_f64().unwrap_or(0.0) > 0.0)
            .await
            .and_then(|value| value.as_f64())
            .unwrap_or_else(|| panic!("duration must be known within {READY_TIMEOUT:?}"))
    }

    /// "A video frame is on screen" = mpv's `vo-configured` went true. That is
    /// the property mpv itself sets once a video output is live, so it is the
    /// honest signal — `video-out-params/W` does not exist in 0.41 (measured: it
    /// never resolves), and the resolution is read from the VO log line instead.
    pub(super) async fn wait_first_video_frame(&self, deadline: Duration) -> bool {
        self.wait_property("vo-configured", deadline, |value| value.as_bool() == Some(true))
            .await
            .is_some()
    }

    /// `VO: [gpu-next] 640x360 yuv420p` -> `gpu-next 640x360 yuv420p`, straight
    /// out of the sidecar log.
    pub(super) fn vo_line(&self) -> Option<String> {
        let log = self.log();
        let line = log.lines().find(|line| line.contains("VO: ["))?;
        let (_, rest) = line.split_once("VO: [")?;
        let (driver, size) = rest.split_once(']')?;
        Some(format!("{}{}", driver, size.trim_start()))
    }

    pub(super) async fn wait_playing(&self) -> bool {
        self.wait_property("time-pos", READY_TIMEOUT, |value| value.as_f64().unwrap_or(-1.0) > 0.0)
            .await
            .is_some()
    }

    /// Wait until a top-level WINDOW owned by this mpv process exists.
    pub(super) async fn wait_for_window(&self, deadline: Duration) -> Option<String> {
        let stop = Instant::now() + deadline;
        loop {
            if let Some(title) = first_window(self.pid) {
                return Some(title);
            }
            if Instant::now() >= stop {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    /// Give mpv a bounded moment to destroy a window it should not keep.
    pub(super) async fn settle(&self) {
        tokio::time::sleep(Duration::from_millis(1200)).await;
    }

    pub(super) fn end_file_events(&self) -> Vec<(Option<String>, Option<String>)> {
        self.events
            .lock()
            .expect("events lock")
            .iter()
            .filter_map(|message| match message {
                IpcMessage::MpvEvent { event, reason, error } if event == "end-file" => {
                    Some((reason.clone(), error.clone()))
                }
                _ => None,
            })
            .collect()
    }

    pub(super) fn log(&self) -> String {
        std::fs::read_to_string(&self.log_path).unwrap_or_default()
    }

    /// mpv's own monotonic clock at a log line. Used for startup latency:
    /// `[   0.124][v][vd] Opening decoder h264` -> `0.124`.
    pub(super) fn log_timestamp_secs(&self, needle: &str) -> Option<f64> {
        let log = self.log();
        log.lines().find_map(|line| {
            let (stamp, rest) = line.strip_prefix('[')?.split_once(']')?;
            rest.contains(needle).then(|| stamp.trim().parse::<f64>().ok())?
        })
    }

    /// The app's own shutdown: `quit` + wait for the exit. The job handle is
    /// dropped with the Session, so nothing can survive this.
    pub(super) async fn quit(&mut self) {
        let _ = self.command(vec![json!("quit")]).await;
        let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
    }
}
