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
    let child = launch_child(&exe, &flags)?;
    let (child, job) = pin_to_job(child)?;
    Ok(SpawnedSidecar { child, job })
}

fn launch_child(exe: &Path, flags: &[String]) -> Result<tokio::process::Child, String> {
    let mut command = tokio::process::Command::new(exe);
    command
        .args(flags)
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

/// Pin the child to the kill-on-close job immediately: without this, any
/// abrupt parent death (taskkill /F, crash, MSI restart) orphans mpv.
/// kill_on_drop below cannot cover those paths (destructors never run).
/// Every failure below kills the partial child first (fail loud, no orphan).
fn pin_to_job(
    mut child: tokio::process::Child,
) -> Result<(tokio::process::Child, super::job::JobHandle), String> {
    let job = match super::job::JobHandle::create_with_kill_on_close() {
        Ok(job) => job,
        Err(job_error) => {
            if let Err(kill_error) = child.start_kill() {
                log::error!("[mpv] job creation failed AND partial-child kill failed: {kill_error} ({job_error})");
            }
            return Err(job_error);
        }
    };
    if let Err(assign_error) = job.assign(&child) {
        if let Err(kill_error) = child.start_kill() {
            log::error!("[mpv] job assign failed AND partial-child kill failed: {kill_error} ({assign_error})");
        }
        return Err(assign_error);
    }
    Ok((child, job))
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
mod tests;
