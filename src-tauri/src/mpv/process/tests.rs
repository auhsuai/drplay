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
