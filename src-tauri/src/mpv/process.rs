//! mpv sidecar process: executable resolution, spawn with the chosen flag set,
//! and named-pipe connect with bounded retry.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

/// Pipe namespace for the per-session IPC endpoint (mpv `--input-ipc-server`).
/// Randomized per session on purpose: mpv's IPC accepts arbitrary commands
/// (including `run`), so the pipe must never be guessable or shared.
pub(crate) const MPV_PIPE_PREFIX: &str = r"\\.\pipe\drplay-mpv-";
/// Total budget for connecting to mpv's freshly created pipe server.
pub(crate) const PIPE_CONNECT_TIMEOUT_SECS: u64 = 5;
/// Delay between pipe connect attempts while mpv is still starting.
pub(crate) const PIPE_CONNECT_BACKOFF_MS: u64 = 100;
/// The sidecar's own log inside the app log directory (`--log-file`).
pub(crate) const MPV_LOG_FILE_NAME: &str = "mpv.log";
/// Extension of the kept previous-session log (`mpv.1`).
const MPV_LOG_PREVIOUS_EXTENSION: &str = "1";
/// Win32 error: the pipe does not exist (yet).
const WIN32_ERROR_FILE_NOT_FOUND: i32 = 2;
/// Win32 error: the pipe exists but no server instance is listening yet.
const WIN32_ERROR_PIPE_BUSY: i32 = 231;
/// Creation flag hiding the console window a child process would flash.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Fresh per-session pipe name: `\\.\pipe\drplay-mpv-{uuid-v4}`.
pub(crate) fn new_pipe_name() -> String {
    format!("{MPV_PIPE_PREFIX}{}", uuid::Uuid::new_v4())
}

/// Keep the previous session's sidecar log before mpv truncates it: mpv
/// truncates `--log-file` on every spawn (mpv docs), so the log of the session
/// that wedged would be lost exactly when the user restarts the app — the very
/// restart that cures the wedge. `mpv.log` becomes `mpv.1` (any older `mpv.1`
/// is dropped). Best effort: a failure only costs diagnostics, never playback.
pub(crate) fn rotate_mpv_log(log_file: &Path) -> Result<(), String> {
    if !log_file.is_file() {
        return Ok(()); // no previous session's log — nothing to keep
    }
    let previous = log_file.with_extension(MPV_LOG_PREVIOUS_EXTENSION);
    match std::fs::remove_file(&previous) {
        Ok(()) => {}
        Err(remove_error) if remove_error.kind() == std::io::ErrorKind::NotFound => {}
        Err(remove_error) => {
            return Err(format!(
                "mpv log rotate: cannot replace {}: {remove_error}",
                previous.display()
            ));
        }
    }
    std::fs::rename(log_file, &previous).map_err(|rename_error| {
        format!(
            "mpv log rotate: cannot keep {} as {}: {rename_error}",
            log_file.display(),
            previous.display()
        )
    })
}

/// The exact flag set chosen for the DrPlay audio-only engine (plan 1.3).
/// `mpv_log` adds `--log-file` (diagnostics only, never behavior): without it
/// the sidecar's stdout/stderr go to null and a wedged playback chain leaves
/// zero evidence behind (2026-09-17 freeze report D2). The log level for
/// `--log-file` is at least `-v -v` per the mpv manual, so no `--msg-level`
/// companion is needed — it could only raise it further.
pub(crate) fn mpv_flags(pipe_name: &str, mpv_log: Option<&Path>) -> Vec<String> {
    let mut flags = vec![
        "--no-video".to_string(),
        "--no-terminal".to_string(),
        // Never read the user's %APPDATA%\mpv\mpv.conf / watch-later state:
        // e.g. a stray `pause=yes` would freeze every track drplay loads.
        "--no-config".to_string(),
        // User scripts in %APPDATA%\mpv\scripts run arbitrary code inside the
        // engine process — the sidecar must stay a pure, isolated engine.
        "--load-scripts=no".to_string(),
        "--idle=yes".to_string(),
        format!("--input-ipc-server={pipe_name}"),
        "--gapless-audio=yes".to_string(),
        "--prefetch-playlist=no".to_string(),
        "--demuxer-readahead-secs=30".to_string(),
        // The demuxer window above is seconds-based, but the stream-cache
        // layer (--cache=yes, default cache-secs is ~1000h = effectively
        // unbounded) would read the whole file ahead independently. Cap it
        // at the same 30s window so RAM stays predictable for heavy files.
        "--cache-secs=30".to_string(),
        // Resume quickly after a seek/underrun: the upstream TTFB (~2s to
        // Drive on slow links) already dominates, so don't add another full
        // second of resume-wait on top. 0.2s is enough with a 30s cache.
        "--cache-pause-wait=0.2".to_string(),
        // Narrow demuxer windows keep RAM low for large files (FLAC ~50MB
        // would otherwise be fully resident, ~90MB private). Backward seeks
        // past the back-buffer are cheap here: every stream is served through
        // the localhost proxy, which returns proper 206 Range responses
        // (verified), so mpv simply re-requests the dropped range.
        "--demuxer-max-back-bytes=8MiB".to_string(),
        "--demuxer-max-bytes=64MiB".to_string(),
        "--cache=yes".to_string(),
        // Windows SMTC (media flyout): the app owns the session
        // (src/media_controls.rs) so the flyout shows the app queue's
        // metadata and drives its next/prev. mpv's own session would be a
        // second, queue-unaware entry; and mpv must not grab the media keys
        // (input-media-keys) or Windows would route them to mpv instead of
        // the app session. Audio playback itself is unchanged.
        "--media-controls=no".to_string(),
        "--input-media-keys=no".to_string(),
    ];
    if let Some(log_file) = mpv_log {
        flags.push(format!("--log-file={}", log_file.display()));
    }
    flags
}

/// Locate the sidecar exe where tauri-build stages it: next to the app
/// binary (dev: `target/debug/mpv.exe`, production: install dir), stepping up
/// from `deps` when running under `cargo test`.
pub(crate) fn resolve_mpv_exe() -> Result<PathBuf, String> {
    let current_exe = std::env::current_exe()
        .map_err(|exe_error| format!("mpv sidecar: cannot locate app executable: {exe_error}"))?;
    let mut dir = current_exe
        .parent()
        .ok_or_else(|| "mpv sidecar: app executable has no parent directory".to_string())?
        .to_path_buf();
    if dir.ends_with("deps") {
        if let Some(parent) = dir.parent() {
            dir = parent.to_path_buf();
        }
    }
    let candidate = dir.join("mpv.exe");
    if !candidate.is_file() {
        return Err(format!(
            "mpv sidecar not found at {} — run `node scripts/fetch-mpv.mjs` from the repo root, then rebuild",
            candidate.display()
        ));
    }
    Ok(candidate)
}

/// A freshly spawned sidecar plus the kill-on-close job pinning it to the
/// app's lifetime. Both must be stored together: dropping the job early would
/// terminate mpv mid-session, and leaving the child outside the job orphans
/// it on abrupt parent death.
pub(crate) struct SpawnedSidecar {
    pub(crate) child: tokio::process::Child,
    pub(crate) job: super::job::JobHandle,
}

/// Spawn the sidecar detached from any console with the engine flag set.
/// `mpv_log` names the sidecar log file (see `rotate_mpv_log`); the child joins
/// a kill-on-close job BEFORE this returns: job creation or assignment failure
/// kills the partial child and surfaces Err (fail loud — never hand back a
/// running orphan).
pub(crate) fn spawn_mpv(pipe_name: &str, mpv_log: Option<&Path>) -> Result<SpawnedSidecar, String> {
    let exe = resolve_mpv_exe()?;
    if let Some(log_file) = mpv_log {
        // Keep the wedged session's log: mpv truncates the file on open, and
        // the restart that cures a wedge would otherwise erase its evidence.
        if let Err(rotate_error) = rotate_mpv_log(log_file) {
            log::warn!("[mpv] {rotate_error}");
        }
    }
    let flags = mpv_flags(pipe_name, mpv_log);
    log::info!(
        "[mpv] spawning sidecar {} ({} flags, pipe {pipe_name})",
        exe.display(),
        flags.len()
    );
    let mut command = tokio::process::Command::new(&exe);
    command
        .args(&flags)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // The handle lives in app state and is dropped at app teardown, which
        // kills mpv — the sidecar must not outlive the app.
        .kill_on_drop(true);
    command.creation_flags(CREATE_NO_WINDOW);
    let child = command.spawn().map_err(|spawn_error| match spawn_error.kind() {
        std::io::ErrorKind::NotFound => format!(
            "mpv sidecar spawn failed: executable missing or not launchable at {}",
            exe.display()
        ),
        std::io::ErrorKind::PermissionDenied => format!(
            "mpv sidecar spawn failed: permission denied for {}",
            exe.display()
        ),
        _ => format!("mpv sidecar spawn failed for {}: {spawn_error}", exe.display()),
    })?;
    // Pin the child to the kill-on-close job immediately: without this, any
    // abrupt parent death (taskkill /F, crash, MSI restart) orphans mpv.
    // kill_on_drop below cannot cover those paths (destructors never run).
    // Every failure below kills the partial child first (fail loud, no orphan).
    let job = match super::job::JobHandle::create_with_kill_on_close() {
        Ok(job) => job,
        Err(job_error) => {
            let mut child = child;
            if let Err(kill_error) = child.start_kill() {
                log::error!("[mpv] job creation failed AND partial-child kill failed: {kill_error} ({job_error})");
            }
            return Err(job_error);
        }
    };
    if let Err(assign_error) = job.assign(&child) {
        let mut child = child;
        if let Err(kill_error) = child.start_kill() {
            log::error!("[mpv] job assign failed AND partial-child kill failed: {kill_error} ({assign_error})");
        }
        return Err(assign_error);
    }
    Ok(SpawnedSidecar { child, job })
}

/// Connect to mpv's pipe server, retrying while mpv is still starting up
/// (bounded by `PIPE_CONNECT_TIMEOUT_SECS` / `PIPE_CONNECT_BACKOFF_MS`).
pub(crate) async fn connect_pipe(pipe_name: &str) -> Result<NamedPipeClient, String> {
    let deadline = Instant::now() + Duration::from_secs(PIPE_CONNECT_TIMEOUT_SECS);
    let mut last_error = String::new();
    loop {
        match ClientOptions::new().open(pipe_name) {
            Ok(client) => return Ok(client),
            Err(open_error)
                if open_error.raw_os_error() == Some(WIN32_ERROR_FILE_NOT_FOUND)
                    || open_error.raw_os_error() == Some(WIN32_ERROR_PIPE_BUSY) =>
            {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "mpv pipe connect timed out after {PIPE_CONNECT_TIMEOUT_SECS}s waiting for {pipe_name} (last error: {last_error}; mpv may have failed to start)"
                    ));
                }
                if last_error.is_empty() {
                    log::debug!(
                        "[mpv] pipe not ready yet ({open_error}); retrying every {PIPE_CONNECT_BACKOFF_MS}ms"
                    );
                }
                last_error = open_error.to_string();
                tokio::time::sleep(Duration::from_millis(PIPE_CONNECT_BACKOFF_MS)).await;
            }
            Err(open_error) => {
                return Err(format!("mpv pipe connect failed for {pipe_name}: {open_error}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn flags_match_the_chosen_engine_config() {
        let pipe = r"\\.\pipe\drplay-mpv-test";
        let flags = mpv_flags(pipe, None);
        let expected_static = [
            "--no-video",
            "--no-terminal",
            "--no-config",
            "--load-scripts=no",
            "--idle=yes",
            "--gapless-audio=yes",
            "--prefetch-playlist=no",
            "--demuxer-readahead-secs=30",
            "--cache-secs=30",
            "--cache-pause-wait=0.2",
            "--demuxer-max-back-bytes=8MiB",
            "--demuxer-max-bytes=64MiB",
            "--cache=yes",
            "--media-controls=no",
            "--input-media-keys=no",
        ];
        for flag in expected_static {
            assert!(flags.iter().any(|candidate| candidate == flag), "missing flag {flag}");
        }
        assert!(
            flags.contains(&format!("--input-ipc-server={pipe}")),
            "flags must target the per-session pipe"
        );
        assert!(
            !flags.iter().any(|flag| flag.starts_with("--log-file")),
            "no log file must be requested when no log path is given"
        );
    }

    #[test]
    fn flags_add_the_sidecar_log_when_a_path_is_given() {
        let pipe = r"\\.\pipe\drplay-mpv-test";
        let log = Path::new(r"C:\logs\mpv.log");
        let flags = mpv_flags(pipe, Some(log));
        assert!(
            flags.contains(&r"--log-file=C:\logs\mpv.log".to_string()),
            "the sidecar must log to the given path, got: {flags:?}"
        );
    }

    #[test]
    fn rotate_mpv_log_keeps_the_previous_session_and_drops_the_older_one() {
        let dir = std::env::temp_dir().join(format!(
            "drplay-mpv-log-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir must be creatable");
        let log = dir.join(MPV_LOG_FILE_NAME);
        let previous = log.with_extension(MPV_LOG_PREVIOUS_EXTENSION);

        // No previous log at all: rotation must not create anything.
        rotate_mpv_log(&log).expect("rotating a missing log must succeed");
        assert!(!log.exists() && !previous.exists(), "no file must appear out of nowhere");

        std::fs::write(&previous, "older session").expect("older log must be writable");
        std::fs::write(&log, "wedged session").expect("live log must be writable");
        rotate_mpv_log(&log).expect("rotation must succeed");

        assert!(!log.exists(), "the live log is renamed away, not copied");
        assert_eq!(
            std::fs::read_to_string(&previous).expect("kept log must be readable"),
            "wedged session",
            "the previous session must replace the older mpv.1"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pipe_names_are_unique_and_prefixed() {
        let first = new_pipe_name();
        let second = new_pipe_name();
        assert!(first.starts_with(MPV_PIPE_PREFIX));
        assert!(second.starts_with(MPV_PIPE_PREFIX));
        assert_ne!(first, second, "pipe name must be randomized per session");
    }

    /// Real end-to-end spike against the fetched sidecar: spawn mpv, connect
    /// the JSON IPC pipe, load a local wav, read `time-pos`, observe property
    /// changes, write the sidecar log and quit. Run explicitly:
    /// `cargo test mpv:: -- --ignored --nocapture`
    /// (requires src-tauri/bin/mpv-x86_64-pc-windows-msvc.exe, i.e. fetch-mpv.mjs).
    #[tokio::test]
    #[ignore = "spike against the real mpv sidecar binary"]
    async fn mpv_real_pipeline_spike() {
        use crate::mpv::ipc::{EventSink, IpcMessage, MpvIpc};
        use serde_json::json;
        use std::sync::Mutex;

        const SPIKE_PROPERTY_WAIT_SECS: u64 = 10;
        const SPIKE_SAMPLE_FILE_CANDIDATES: &[&str] = &[
            r"C:\Windows\Media\Alarm01.wav",
            r"C:\Windows\Media\Windows Ding.wav",
            r"C:\Windows\Media\chimes.wav",
        ];

        let sample_file = SPIKE_SAMPLE_FILE_CANDIDATES
            .iter()
            .find(|candidate| Path::new(candidate).is_file())
            .ok_or_else(|| "no local wav sample found for the spike".to_string())
            .expect("spike needs a local wav sample");

        let log_dir = std::env::temp_dir().join(format!(
            "drplay-mpv-spike-logs-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&log_dir).expect("spike log dir must be creatable");
        let log_file = log_dir.join(MPV_LOG_FILE_NAME);

        let pipe_name = new_pipe_name();
        let spawned = spawn_mpv(&pipe_name, Some(log_file.as_path())).expect("sidecar must spawn");
        let mut child = spawned.child;
        // Keep the job alive for the spike duration: dropping it would
        // terminate mpv via KILL_ON_JOB_CLOSE before the pipeline runs.
        let _job = spawned.job;
        println!(
            "[spike] spawned mpv (pipe: {pipe_name}, log: {})",
            log_file.display()
        );

        let client = connect_pipe(&pipe_name).await.expect("pipe must connect");
        println!("[spike] pipe connected");

        let received: std::sync::Arc<Mutex<Vec<IpcMessage>>> = Default::default();
        let sink: EventSink = {
            let received = received.clone();
            std::sync::Arc::new(move |message| received.lock().unwrap().push(message))
        };
        let ipc = MpvIpc::new(client, sink);

        for &(observe_id, property) in &[
            (1u64, "time-pos"),
            (2, "duration"),
            (3, "pause"),
            (4, "paused-for-cache"),
            (5, "demuxer-cache-state"),
        ] {
            ipc.send_command(vec![json!("observe_property"), json!(observe_id), json!(property)])
                .await
                .expect("observe_property must succeed");
        }
        println!("[spike] 5 properties observed");

        let load_result = ipc
            .send_command(vec![json!("loadfile"), json!(sample_file), json!("replace")])
            .await
            .map(|data| data.to_string())
            .map_err(|error| error.clone());
        println!("[spike] loadfile {sample_file} -> {load_result:?}");
        load_result.expect("loadfile must succeed");

        // time-pos must start ticking once playback begins.
        let deadline = Instant::now() + Duration::from_secs(SPIKE_PROPERTY_WAIT_SECS);
        let mut time_pos_seen: Option<f64> = None;
        while Instant::now() < deadline {
            match ipc.send_command(vec![json!("get_property"), json!("time-pos")]).await {
                Ok(value) => {
                    if let Some(secs) = value.as_f64() {
                        if secs > 0.0 {
                            time_pos_seen = Some(secs);
                            break;
                        }
                    }
                }
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let time_pos = time_pos_seen.expect("time-pos must tick above zero within the wait window");
        println!("[spike] get_property time-pos -> {time_pos}");
        assert!(
            time_pos > 0.0 && time_pos < 60.0,
            "time-pos must tick inside the sample length, got {time_pos}"
        );

        let change_count = received.lock().unwrap().len();
        let names: Vec<String> = received
            .lock()
            .unwrap()
            .iter()
            .filter_map(|message| match message {
                IpcMessage::PropertyChange { name, .. } => Some(name.clone()),
                _ => None,
            })
            .collect();
        println!("[spike] property-change events received: {change_count} ({names:?})");
        assert!(
            change_count > 0,
            "at least one property-change event must arrive over IPC"
        );
        assert!(
            names.iter().any(|name| name == "time-pos"),
            "observed time-pos must produce property-change events"
        );

        let quit_result = ipc.send_command(vec![json!("quit")]).await;
        println!("[spike] quit -> {quit_result:?}");
        quit_result.expect("quit must succeed");
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("mpv must exit after quit")
            .expect("child wait must not error");
        println!("[spike] mpv exited cleanly");

        // F2 verification: the sidecar wrote its own log at the requested path
        // (with --no-terminal in effect) — the diagnostics a wedged chain
        // needs (cplayer/demuxer/ao lines) are actually captured.
        let log_text = std::fs::read_to_string(&log_file).expect("sidecar log must exist");
        println!("[spike] sidecar log: {} bytes", log_text.len());
        assert!(
            log_text.len() > 1000,
            "sidecar log must carry the verbose session, got {} bytes",
            log_text.len()
        );
        assert!(
            log_text.contains("[cplayer]"),
            "sidecar log must include cplayer messages"
        );
        assert!(
            log_text.contains(sample_file),
            "sidecar log must record the loaded file"
        );

        std::fs::remove_dir_all(&log_dir).ok();
    }
}
