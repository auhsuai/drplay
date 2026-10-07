use super::*;
use std::path::Path;

#[test]
fn flags_match_the_chosen_engine_config() {
    let pipe = r"\\.\pipe\drplay-mpv-test";
    let flags = mpv_flags(pipe, None, None);
    let expected_static = [
        "--hwdec=auto-safe",
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

/// Video is enabled PER TRACK over IPC (`set_property video`), never by a
/// startup flag: `--no-video`/`--video=no` would make the choice a
/// process-lifecycle decision and force a respawn on every audio<->video
/// switch (see mpvFlags docs). The frontend is the only place that decides a
/// track's kind, so the flag set must leave the door open — and must still
/// pick a video output explicitly instead of relying on mpv auto-detection.
#[test]
fn flags_do_not_pin_the_video_choice_and_do_pin_a_video_output() {
    let flags = mpv_flags(r"\\.\pipe\drplay-mpv-test", None, None);

    for disabling in ["--no-video", "--video=no", "--video=0"] {
        assert!(
            !flags.iter().any(|flag| flag == disabling),
            "{disabling} must not be a startup flag: the `video` property is set per track over IPC"
        );
    }

    let vo_flags: Vec<&String> = flags.iter().filter(|flag| flag.starts_with("--vo=")).collect();
    assert_eq!(
        vo_flags.len(),
        1,
        "exactly one --vo must be requested (so output never depends on mpv auto-detection), got {vo_flags:?}"
    );
    assert_eq!(
        vo_flags[0].as_str(),
        format!("--vo={MPV_VIDEO_OUTPUT}"),
        "video output must be the documented, compiled-in driver with its fallback"
    );
}

/// Hardware decoding is a soft POLICY, never a hard dependency: with
/// `--hwdec=auto-safe` mpv engages a whitelisted hardware decoder when the GPU
/// and codec support it, and falls back to software decoding by itself when
/// they don't (measured on the test machine: H.264 1080p 35% -> 6.8% of one
/// core with d3d11va engaged; unsupported HEVC 10-bit simply stays software,
/// playback and seeks unchanged, no respawn). Exactly ONE `--hwdec` flag may
/// exist — a second one would make the effective policy depend on argv order —
/// and its value must stay `auto-safe`: no hard-coded backend (e.g. d3d11va),
/// so mpv always picks and falls back on its own.
#[test]
fn flags_request_hwdec_auto_safe_as_a_soft_policy() {
    let pipe = r"\\.\pipe\drplay-mpv-test";
    for with_host in [None, Some(918_992)] {
        let flags = mpv_flags(pipe, None, with_host);
        assert_eq!(
            flags.iter().filter(|flag| flag.starts_with("--hwdec")).count(),
            1,
            "exactly one --hwdec flag must exist (host={with_host:?}), got: {flags:?}"
        );
        assert!(
            flags.contains(&format!("--hwdec={MPV_HWDEC}")),
            "hwdec must be the soft auto-safe policy (host={with_host:?}), got: {flags:?}"
        );
    }
}

#[test]
fn flags_add_the_sidecar_log_when_a_path_is_given() {
    let pipe = r"\\.\pipe\drplay-mpv-test";
    let log = Path::new(r"C:\logs\mpv.log");
    let flags = mpv_flags(pipe, Some(log), None);
    assert!(
        flags.contains(&r"--log-file=C:\logs\mpv.log".to_string()),
        "the sidecar must log to the given path, got: {flags:?}"
    );
}

/// The video host HWND is passed to mpv so it paints into OUR child window
/// instead of creating a top-level window of its own. A HWND of 0 is not a
/// window, so it must be treated exactly like "no host".
#[test]
fn flags_target_the_video_host_when_one_was_acquired() {
    let flags = mpv_flags(r"\\.\pipe\drplay-mpv-test", None, Some(918_992));
    assert!(
        flags.contains(&"--wid=918992".to_string()),
        "the engine must render into the acquired video host, got: {flags:?}"
    );
    assert_eq!(
        flags.iter().filter(|flag| flag.starts_with("--wid")).count(),
        1,
        "exactly one --wid may be requested, got: {flags:?}"
    );
}

/// Audio must keep working when there is no video host at all (never acquired,
/// or acquisition failed). mpv then falls back to its own window for video —
/// today's behavior — and audio is unaffected. The app must never fail to
/// start because a paint target could not be created.
#[test]
fn flags_omit_the_video_host_when_there_is_none() {
    for none in [None, Some(0)] {
        let flags = mpv_flags(r"\\.\pipe\drplay-mpv-test", None, none);
        assert!(
            !flags.iter().any(|flag| flag.starts_with("--wid")),
            "--wid must be absent when no host exists ({none:?}), got: {flags:?}"
        );
        assert!(
            !flags.iter().any(|flag| flag == "--no-video" || flag == "--video=no"),
            "an absent host must not disable video output either, got: {flags:?}"
        );
        assert!(
            flags.iter().any(|flag| flag.starts_with("--vo=")),
            "video output stays pinned even without a host, got: {flags:?}"
        );
    }
}

/// mpv's OWN UI must never appear: `--wid` makes mpv imply
/// `--player-operation-mode=pseudo-gui`, which turns on a right-click context
/// menu, an OSC and an OSD title line. DrPlay's React UI is the only player UI,
/// so every one of those is pinned off. Each string is asserted EXACTLY (not a
/// count): a renamed or defaulted flag would silently re-enable mpv's UI.
#[test]
fn flags_suppress_every_piece_of_mpvs_own_ui() {
    let expected = [
        // Re-asserted AFTER --wid, because --wid implies pseudo-gui. Always
        // present (it is mpv's default anyway when there is no host).
        "--player-operation-mode=cplayer",
        // The built-in On-Screen Controller (script + overlay).
        "--osc=no",
        // Every OSD message: the filename title, the seek bar, volume OSD.
        "--osd-level=0",
        // mpv must not own the mouse cursor over the video area.
        "--input-cursor=no",
        // mpv's default key bindings. DrPlay drives the engine over its own
        // named-pipe IPC (loadfile / seek / set_property only), so nothing in
        // the app depends on them.
        "--input-default-bindings=no",
        // The video output window must not take keyboard input from the host.
        "--input-vo-keyboard=no",
    ];
    for with_host in [None, Some(918_992)] {
        let flags = mpv_flags(r"\\.\pipe\drplay-mpv-test", None, with_host);
        for flag in expected {
            assert!(
                flags.iter().any(|candidate| candidate == flag),
                "mpv UI suppression flag {flag} missing (host={with_host:?}), got: {flags:?}"
            );
        }
        let mode = flags
            .iter()
            .position(|flag| flag == "--player-operation-mode=cplayer")
            .expect("the cplayer mode is asserted above");
        if with_host.is_some() {
            let wid = flags
                .iter()
                .position(|flag| flag.starts_with("--wid"))
                .expect("--wid is asserted above");
            assert!(
                mode > wid,
                "--player-operation-mode must come AFTER --wid: --wid implies pseudo-gui, \
                 so only a later cplayer overrides it (host={with_host:?}), got: {flags:?}"
            );
        }
    }
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
        std::sync::Arc::new(move |message, _epoch, _conn| received.lock().unwrap().push(message))
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
