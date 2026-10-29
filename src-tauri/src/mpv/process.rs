//! mpv sidecar process: executable resolution, spawn with the chosen flag set,
//! and named-pipe connect with bounded retry.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

use crate::playback_runtime::metadata::MPV_EXE_BYTE_FLOOR;

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
/// Video output driver requested at spawn. `gpu-next` is mpv's recommended
/// output and the default since 0.41; `gpu` stays in the list as mpv's own
/// documented fallback (an mpv priority list falls back on the drivers after
/// it), so video output never depends on auto-detection and never dies with
/// the build.
pub(crate) const MPV_VIDEO_OUTPUT: &str = "gpu-next,gpu";
/// Hardware-decoding policy requested at spawn. `auto-safe` = use a
/// hardware decoder when one is safe and available, fall back to software
/// decoding automatically when it is not (mpv manual: `auto-safe` is "exactly
/// the same as `auto`", and `auto` "tries to automatically enable hardware
/// decoding using the first available method" while it "may disable hardware
/// decoding in other situations when it's known to cause problems"). Never a
/// hard GPU dependency and no codec is special-cased: an unsupported GPU or
/// codec simply keeps software decoding, with transport, audio and IPC
/// untouched. Measured on the low-end Ivy Bridge test machine (Intel HD, 2015
/// driver): H.264 1080p 35% -> 6.8% of one core (d3d11va engaged), 4K 76.4%
/// -> 4.0%; unsupported HEVC 10-bit/4K stayed software after mpv's own probe
/// failed ("Failed to allocate hw frames"), playback and seek unchanged, no
/// respawn.
pub(crate) const MPV_HWDEC: &str = "auto-safe";

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

/// The exact flag set chosen for the DrPlay engine (plan 1.3).
/// `mpv_log` adds `--log-file` (diagnostics only, never behavior): without it
/// the sidecar's stdout/stderr go to null and a wedged playback chain leaves
/// zero evidence behind (2026-09-17 freeze report D2). The log level for
/// `--log-file` is at least `-v -v` per the mpv manual, so no `--msg-level`
/// companion is needed — it could only raise it further.
///
/// VIDEO is decided PER TRACK over IPC, not here. There is deliberately no
/// `--no-video` (and no `--video=no`): mpv's `video` property is a runtime
/// property, so the frontend sets it from the track's media kind right before
/// `loadfile` — `no` for audio (byte-identical to the old startup flag) and
/// `1` for video. One engine, no respawn when the kind changes. The frontend
/// is the only layer that knows a track's kind, so keeping the choice out of
/// the spawn-time flag set keeps one source of truth. (`1`, not `yes`:
/// verified against this sidecar that mpv v0.41.0 REJECTS
/// `set_property video "yes"` with "unsupported format for accessing
/// property", while `"1"` and `"no"` are both accepted.)
/// `--vo=` is still pinned so video output never depends on mpv
/// auto-detection (and never on a user mpv.conf — see `--no-config`).
/// `--hwdec=auto-safe` (see `MPV_HWDEC`) is the hardware-decoding policy:
/// hardware when the GPU and codec support it, automatic software fallback
/// when they don't — a measured 35% -> 6.8% of one core on H.264 1080p, and
/// merely a software decode on unsupported codecs, so it is never a hard
/// dependency and no codec is special-cased.
pub(crate) fn mpv_flags(
    pipe_name: &str,
    mpv_log: Option<&Path>,
    video_host_hwnd: Option<i64>,
) -> Vec<String> {
    let mut flags = vec![
        format!("--vo={MPV_VIDEO_OUTPUT}"),
        format!("--hwdec={MPV_HWDEC}"),
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
        // ---- mpv's OWN UI, suppressed -------------------------------------
        // `--wid` makes mpv imply `--player-operation-mode=pseudo-gui`, which
        // turns on mpv's own player UI: a right-click context menu
        // (Pause/Stop/Open/Playlist/Tracks/...), the on-screen controller and
        // an OSD title line with the filename. All of it was OBSERVED with the
        // shipped mpv 0.41.0 against a real child HWND. DrPlay's React UI is
        // the only player UI, so each piece is pinned off. Every flag below was
        // verified to exist in this exact build (mpv --list-options + a real
        // option-parse run), not guessed.
        "--osc=no".to_string(),
        // Level 0 removes every OSD message: the filename title line, the seek
        // bar and the volume OSD. The app reads mpv PROPERTIES over IPC, never
        // the OSD, so nothing in DrPlay depends on it.
        "--osd-level=0".to_string(),
        // mpv must not claim or change the mouse cursor over the video area:
        // DrPlay's own controls are the only pointer target there.
        "--input-cursor=no".to_string(),
        // mpv's DEFAULT key bindings are dead weight (and would make the
        // embedded window eat keystrokes). Safe to drop: the frontend drives
        // the engine exclusively over its own named-pipe IPC and only ever
        // sends loadfile / seek / set_property (src/lib/mpvProtocol.ts), never
        // an input command, and keyboard shortcuts are DOM handlers in the
        // WebView. Verified by grep: no bindkey/keypress path exists.
        "--input-default-bindings=no".to_string(),
        // Belt-and-suspenders on the keyboard: the video output must not take
        // keyboard input from the window it is embedded in.
        "--input-vo-keyboard=no".to_string(),
    ];
    // The video host HWND (video_host.rs): mpv paints into OUR child window
    // instead of creating a top-level window of its own. None means no host
    // exists (never acquired, or acquisition failed) — that is not an error:
    // audio is unaffected and mpv falls back to its own window, which is the
    // pre-video-host behavior. 0 is not a window either, so it is treated as
    // "no host".
    if let Some(hwnd) = video_host_hwnd.filter(|hwnd| *hwnd != 0) {
        flags.push(format!("--wid={hwnd}"));
    }
    // MUST come after `--wid`: `--wid` implies `--player-operation-mode=
    // pseudo-gui`, which switches mpv's own player UI back on (right-click
    // context menu, OSC, OSD title). Only a LATER cplayer overrides the
    // implication. Asserted unconditionally — without a host it is already
    // mpv's default, so it costs nothing and documents the invariant.
    flags.push("--player-operation-mode=cplayer".to_string());
    if let Some(log_file) = mpv_log {
        flags.push(format!("--log-file={}", log_file.display()));
    }
    flags
}

/// Environment override for the sidecar executable. Authoritative when set:
/// an explicit path is never silently replaced by a discovered one.
pub(crate) const MPV_EXE_ENV: &str = "DRPLAY_MPV_EXE";
/// Stable, machine-recognizable prefix of every "no fallback engine" error.
/// Slice 3/5 match this slug; the rest of the message is user-facing prose.
pub(crate) const FALLBACK_NOT_INSTALLED_SLUG: &str = "fallback-engine-not-installed";
/// Stable prefix of the "the override is set but unusable" error. Distinct on
/// purpose: the user asked for a specific binary and must be told it is wrong,
/// not silently handed a different one.
const FALLBACK_OVERRIDE_INVALID_SLUG: &str = "fallback-engine-invalid-override";
/// The sidecar's name once Tauri stages it via `externalBin` (it renames
/// `mpv-<target-triple>.exe` to `mpv.exe`).
const MPV_EXE_NAME: &str = "mpv.exe";
/// The un-renamed bundled name in `src-tauri/bin`. With `externalBin: []`
/// nothing rewrites it, so a dev checkout keeps this name verbatim.
const MPV_EXE_BUNDLED_NAME: &str = "mpv-x86_64-pc-windows-msvc.exe";

/// Why a candidate must not be launched, or `None` when it is usable.
///
/// "Exists" is not enough: a truncated or interrupted download is a file, and
/// launching it would fail with an opaque spawn error (or worse, run a stub).
/// The floor is the same one the installer enforces
/// ([`crate::playback_runtime::metadata::MPV_EXE_BYTE_FLOOR`]), so the resolver
/// and the install pipeline can never disagree about "usable".
fn candidate_reason(path: &Path) -> Option<String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(stat_error) if stat_error.kind() == std::io::ErrorKind::NotFound => {
            return Some("missing".to_string())
        }
        Err(stat_error) => return Some(format!("cannot be inspected: {stat_error}")),
    };
    if !metadata.is_file() {
        return Some("not a file".to_string());
    }
    let size = metadata.len();
    if size < MPV_EXE_BYTE_FLOOR {
        return Some(format!(
            "only {size} bytes, below the {MPV_EXE_BYTE_FLOOR}-byte minimum (truncated or not mpv)"
        ));
    }
    None
}

/// The actionable, user-facing "nothing to run" message. Names the Settings
/// location, states the fallback is an optional download, and mentions the
/// advanced override -- never a build-time instruction (end users get this).
fn fallback_missing_error(rejected: &[String]) -> String {
    let mut message = format!(
        "{FALLBACK_NOT_INSTALLED_SLUG}: the optional mpv.exe fallback engine is not installed. \
         Install it from Settings > Playback > Fallback engine, or (advanced) point \
         {MPV_EXE_ENV} at an mpv.exe you already have."
    );
    if !rejected.is_empty() {
        message.push_str(&format!(" Candidates rejected: {}.", rejected.join("; ")));
    }
    // Dev-only: this one IS a build-time hint, and only developers see it.
    if cfg!(debug_assertions) {
        message.push_str(
            " [dev] no sidecar found in src-tauri/bin either — run `node scripts/fetch-mpv.mjs` \
             from the repo root, then rebuild.",
        );
    }
    message
}

/// Pure candidate scan: the first candidate that is a real file AND clears the
/// size floor wins. Every rejection is logged with its reason -- the diagnostic
/// the old single-candidate resolver lacked. No globals, no env reads.
pub(crate) fn resolve_mpv_exe_in(
    candidates: impl IntoIterator<Item = PathBuf>,
) -> Result<PathBuf, String> {
    let mut rejected: Vec<String> = Vec::new();
    for candidate in candidates {
        match candidate_reason(&candidate) {
            None => {
                log::info!("[mpv] sidecar resolved: {}", candidate.display());
                return Ok(candidate);
            }
            Some(reason) => {
                log::debug!(
                    "[mpv] sidecar candidate skipped ({reason}): {}",
                    candidate.display()
                );
                rejected.push(format!("{} ({reason})", candidate.display()));
            }
        }
    }
    Err(fallback_missing_error(&rejected))
}

/// Pure resolution core, env-free so the whole policy is unit-testable:
///
/// 1. `override_exe` (`DRPLAY_MPV_EXE`) is authoritative. If it is set but
///    unusable, that is a distinct error -- explicit configuration must never
///    be silently ignored in favour of some other binary on disk.
/// 2. The installed per-user fallback (already validated by the caller).
/// 3. The dev candidates, in order.
pub(crate) fn resolve_mpv_exe_with(
    override_exe: Option<PathBuf>,
    installed: Option<PathBuf>,
    dev: Vec<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(override_path) = override_exe {
        return match candidate_reason(&override_path) {
            None => {
                log::info!(
                    "[mpv] sidecar resolved by {MPV_EXE_ENV}: {}",
                    override_path.display()
                );
                Ok(override_path)
            }
            Some(reason) => Err(format!(
                "{FALLBACK_OVERRIDE_INVALID_SLUG}: {MPV_EXE_ENV} is set to {} but it is not \
                 usable ({reason}). An explicit override is never ignored, so no other mpv.exe \
                 is tried: fix or unset {MPV_EXE_ENV}.",
                override_path.display()
            )),
        };
    }
    resolve_mpv_exe_in(installed.into_iter().chain(dev))
}

/// Dev/repo candidates, in the same spirit as `resolve_libmpv_dll`:
/// `<ancestor>/bin/mpv.exe`, `<ancestor>/bin/mpv-x86_64-pc-windows-msvc.exe`
/// for every ancestor of the app binary's directory, then `<exe-dir>/mpv.exe`
/// (the historical layout, kept for a Tauri-staged dev build).
///
/// The `bin/` walk is gated on the ancestor looking like this repository (it
/// holds `Cargo.toml` or `src-tauri/`) so a production install under
/// `C:\Program Files\...` can never pick up an unrelated `bin\mpv.exe` from a
/// parent directory.
fn dev_candidates(app_exe_dir: &Path) -> Vec<PathBuf> {
    let mut dir = app_exe_dir.to_path_buf();
    // `cargo test` runs the test binary from `<profile>/deps`.
    if dir.ends_with("deps") {
        if let Some(parent) = dir.parent() {
            dir = parent.to_path_buf();
        }
    }
    let mut candidates = Vec::new();
    for ancestor in dir.ancestors() {
        let looks_like_repo =
            ancestor.join("Cargo.toml").is_file() || ancestor.join("src-tauri").is_dir();
        if !looks_like_repo {
            continue;
        }
        let bin = ancestor.join("bin");
        candidates.push(bin.join(MPV_EXE_NAME));
        // Not renamed back: `externalBin` is empty in this experiment, so the
        // checked-in binary keeps its target-triple suffix.
        candidates.push(bin.join(MPV_EXE_BUNDLED_NAME));
    }
    candidates.push(dir.join(MPV_EXE_NAME));
    candidates
}

/// The installed per-user fallback, ONLY if the install pipeline would call it
/// `Installed`: `status_for` re-checks the size window and reads the Windows
/// version resource, so a stub or a truncated file is never offered here.
/// `None` (with a debug line) means "this step contributes no candidate".
fn installed_sidecar_path(local_data_root: &Path) -> Option<PathBuf> {
    use crate::playback_runtime::status::{engine_exe_path, FallbackStatus};
    use crate::playback_runtime::{install, metadata};

    let path = engine_exe_path(local_data_root, metadata::MPV_VERSION);
    match install::status_for(local_data_root) {
        FallbackStatus::Installed { .. } => Some(path),
        other => {
            log::debug!(
                "[mpv] installed fallback not usable ({other:?}): {}",
                path.display()
            );
            None
        }
    }
}

/// `app_local_data_dir()` for the resolver. Failure is logged and skipped, not
/// fatal: the dev candidates below can still satisfy a developer machine.
fn app_local_data_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;

    match app.path().app_local_data_dir() {
        Ok(root) => Some(root),
        Err(path_error) => {
            log::warn!(
                "[mpv] app_local_data_dir unavailable, skipping the installed fallback candidate: \
                 {path_error}"
            );
            None
        }
    }
}

/// Production entry point: gets the per-user root from the `AppHandle` so the
/// installed fallback can be found. The no-arg [`resolve_mpv_exe`] stays as the
/// dev/test wrapper (no installed-fallback step, no Tauri dependency).
pub(crate) fn resolve_mpv_exe_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resolve_mpv_exe_in_root(app_local_data_root(app).as_deref())
}

/// Locate the sidecar exe, in order: `DRPLAY_MPV_EXE`, the installed per-user
/// fallback (needs `local_data_root`, i.e. `app_local_data_dir()`), then the
/// dev/repo layout. `local_data_root` is `None` for tests and for a run where
/// Tauri could not resolve it -- the last two steps still apply.
fn resolve_mpv_exe_in_root(local_data_root: Option<&Path>) -> Result<PathBuf, String> {
    let override_exe = std::env::var_os(MPV_EXE_ENV)
        .filter(|raw| !raw.is_empty())
        .map(PathBuf::from);
    let installed = local_data_root.and_then(installed_sidecar_path);
    let dev = match std::env::current_exe() {
        Ok(current_exe) => current_exe.parent().map(dev_candidates).unwrap_or_default(),
        Err(exe_error) => {
            log::debug!("[mpv] cannot locate the app executable for dev candidates: {exe_error}");
            Vec::new()
        }
    };
    resolve_mpv_exe_with(override_exe, installed, dev)
}

/// Dev/test wrapper: the same policy without the per-user installed step (no
/// `AppHandle` available). Production always resolves through
/// [`resolve_mpv_exe_for`].
#[cfg(test)]
pub(crate) fn resolve_mpv_exe() -> Result<PathBuf, String> {
    resolve_mpv_exe_in_root(None)
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
/// `exe` is resolved (and validated) by the caller so the launch can never
/// diverge from the pre-flight check -- this function launches exactly what it
/// was handed, it never re-resolves.
/// `mpv_log` names the sidecar log file (see `rotate_mpv_log`); the child joins
/// a kill-on-close job BEFORE this returns: job creation or assignment failure
/// kills the partial child and surfaces Err (fail loud — never hand back a
/// running orphan).
pub(crate) fn spawn_mpv(
    exe: &Path,
    pipe_name: &str,
    mpv_log: Option<&Path>,
) -> Result<SpawnedSidecar, String> {
    if let Some(log_file) = mpv_log {
        // Keep the wedged session's log: mpv truncates the file on open, and
        // the restart that cures a wedge would otherwise erase its evidence.
        if let Err(rotate_error) = rotate_mpv_log(log_file) {
            log::warn!("[mpv] {rotate_error}");
        }
    }
    // The host is only READ here, never created: `spawn_mpv` runs on a tokio
    // worker (mpv_spawn is an async command) and a window created there would
    // have no message pump. Slice 2 calls `video_host_acquire` before the first
    // `mpv_spawn`; when there is none, mpv falls back to its own window and
    // audio is unaffected.
    let video_host_hwnd = crate::video_host::current_hwnd();
    if video_host_hwnd.is_none() {
        log::info!("[mpv] no video host acquired — video (if any) uses mpv's own window");
    }
    let flags = mpv_flags(pipe_name, mpv_log, video_host_hwnd);
    log::info!(
        "[mpv] spawning sidecar {} ({} flags, pipe {pipe_name})",
        exe.display(),
        flags.len()
    );
    let child = launch_child(exe, &flags)?;
    let (child, job) = pin_to_job(child)?;
    Ok(SpawnedSidecar { child, job })
}

/// Test helper: resolve through the dev/test wrapper (no `AppHandle`, so no
/// installed-fallback step) and spawn the result. Production must resolve via
/// [`resolve_mpv_exe_for`] and call [`spawn_mpv`] with that exact path.
#[cfg(test)]
pub(crate) fn spawn_mpv_resolving(
    pipe_name: &str,
    mpv_log: Option<&Path>,
) -> Result<SpawnedSidecar, String> {
    let exe = resolve_mpv_exe()?;
    spawn_mpv(&exe, pipe_name, mpv_log)
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
