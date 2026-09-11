//! mpv sidecar process: executable resolution, spawn with the chosen flag set,
//! and named-pipe connect with bounded retry.

use std::path::PathBuf;
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

/// The exact flag set chosen for the DrPlay audio-only engine (plan 1.3).
pub(crate) fn mpv_flags(pipe_name: &str) -> Vec<String> {
    vec![
        "--no-video".to_string(),
        "--no-terminal".to_string(),
        "--idle=yes".to_string(),
        format!("--input-ipc-server={pipe_name}"),
        "--gapless-audio=yes".to_string(),
        "--prefetch-playlist=no".to_string(),
        "--demuxer-readahead-secs=30".to_string(),
        "--demuxer-max-back-bytes=64MiB".to_string(),
        "--demuxer-max-bytes=256MiB".to_string(),
        "--cache=yes".to_string(),
        "--force-media-title=no".to_string(),
    ]
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

/// Spawn the sidecar detached from any console with the engine flag set.
pub(crate) fn spawn_mpv(pipe_name: &str) -> Result<tokio::process::Child, String> {
    let exe = resolve_mpv_exe()?;
    let flags = mpv_flags(pipe_name);
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
    command.spawn().map_err(|spawn_error| match spawn_error.kind() {
        std::io::ErrorKind::NotFound => format!(
            "mpv sidecar spawn failed: executable missing or not launchable at {}",
            exe.display()
        ),
        std::io::ErrorKind::PermissionDenied => format!(
            "mpv sidecar spawn failed: permission denied for {}",
            exe.display()
        ),
        _ => format!("mpv sidecar spawn failed for {}: {spawn_error}", exe.display()),
    })
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
        let flags = mpv_flags(pipe);
        let expected_static = [
            "--no-video",
            "--no-terminal",
            "--idle=yes",
            "--gapless-audio=yes",
            "--prefetch-playlist=no",
            "--demuxer-readahead-secs=30",
            "--demuxer-max-back-bytes=64MiB",
            "--demuxer-max-bytes=256MiB",
            "--cache=yes",
            "--force-media-title=no",
        ];
        for flag in expected_static {
            assert!(flags.iter().any(|candidate| candidate == flag), "missing flag {flag}");
        }
        assert!(
            flags.contains(&format!("--input-ipc-server={pipe}")),
            "flags must target the per-session pipe"
        );
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
    /// changes and quit. Run explicitly: `cargo test mpv:: -- --ignored --nocapture`
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

        let pipe_name = new_pipe_name();
        let mut child = spawn_mpv(&pipe_name).expect("sidecar must spawn");
        println!("[spike] spawned mpv (pipe: {pipe_name})");

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
    }
}
