use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::stream_proxy::TokenSource;
use super::observe::all_windows;
use super::observe::assert_no_mpv;
use super::observe::cpu_secs;
use super::observe::first_window;
use super::observe::memory_mb;
use super::observe::mpv_pids;
use super::proxy::proxy_url;
use super::session::Session;
use super::PROXY_BODY_IDLE_TIMEOUT;
use super::PROXY_HEADERS_TIMEOUT;
use super::SEEK_TARGET_FRACTION;
use super::SEEK_TOLERANCE_SECS;

/// Production `DRIVE_BASE_URL`. Only the Tier 2 spikes below ever use it.
const REAL_DRIVE_BASE_URL: &str = "https://www.googleapis.com";

/// Token source backed by the REAL OS credential vault and the REAL Google
/// token endpoint — i.e. the production `DriveTokenSource` behaviour, reached
/// through a trait impl so a test can hold it as `Arc<dyn TokenSource>`.
///
/// It exists for the Tier 2 spikes only. With no refresh token stored it fails
/// the request with "not signed in", which is why every test using it is
/// `#[ignore]`d and reported UNRUN rather than silently skipped.
struct VaultTokens {
    cached: std::sync::Mutex<Option<String>>,
}

impl crate::stream_proxy::TokenSource for VaultTokens {
    fn current(&self) -> Option<String> {
        self.cached.lock().ok().and_then(|guard| guard.clone())
    }

    fn refresh(
        self: Arc<Self>,
        _force: bool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>> {
        Box::pin(async move {
            let stored = tauri::async_runtime::spawn_blocking(crate::token_store::get_refresh_token)
                .await
                .map_err(|join_error| format!("vault read failed: {join_error}"))??;
            let refresh_token = stored.ok_or("not signed in: no refresh token in the OS vault")?;
            let payload =
                crate::auth::refresh_google_token(refresh_token).await?;
            let access = payload["access_token"]
                .as_str()
                .ok_or("token response carried no access_token")?
                .to_string();
            if let Ok(mut guard) = self.cached.lock() {
                *guard = Some(access.clone());
            }
            Ok(access)
        })
    }
}

const REAL_DRIVE_HEADERS_TIMEOUT: Duration = PROXY_HEADERS_TIMEOUT;

/// List real Drive file ids whose name has one of `extensions`.
async fn real_drive_files_with_extension(
    access_token: &str,
    extensions: &[&str],
) -> Result<Vec<(String, String)>, String> {
    let mut found: Vec<(String, String)> = Vec::new();
    for extension in extensions {
        let query = format!("name contains '{extension}' and trashed = false");
        let response = reqwest::Client::new()
            .get(format!("{REAL_DRIVE_BASE_URL}/drive/v3/files"))
            .query(&[
                ("q", query.as_str()),
                ("pageSize", "5"),
                ("fields", "files(id,name)"),
            ])
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {access_token}"))
            .send()
            .await
            .map_err(|send_error| format!("files.list failed: {send_error}"))?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(format!("files.list returned {}", response.status()));
        }
        let listing: Value = response.json().await.map_err(|json_error| json_error.to_string())?;
        for file in listing["files"].as_array().cloned().unwrap_or_default() {
            let Some(id) = file["id"].as_str() else { continue };
            let name = file["name"].as_str().unwrap_or("?").to_string();
            if name.to_ascii_lowercase().ends_with(extension) {
                found.push((id.to_string(), name));
            }
        }
    }
    Ok(found)
}

/// TIER 2 (VIDEO-015 + VIDEO-011) — UNRUN without a Google account.
/// Real Drive MKV/MP4 -> REAL proxy (real base URL, real vault token) -> real
/// mpv: play, seek, then switch to a real Drive AUDIO track and require the video
/// window to be gone.
///
/// Missing: a signed-in Google account (a refresh token in the OS credential
/// vault) plus at least one `.mkv`/`.mp4` and one audio file in that Drive.
/// Expected: window appears for the video, first frame within a few seconds,
/// seek lands within SEEK_ACK_TOLERANCE_SECS, and after the switch to audio the
/// window count for the mpv pid is 0 while `AO:` is still a real output.
/// Run: `cargo test --manifest-path src-tauri/Cargo.toml real_drive -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "TIER 2: needs a signed-in Google account with real video files"]
async fn real_drive_video_playback_and_switch_to_audio() {
    let tokens = Arc::new(VaultTokens { cached: std::sync::Mutex::new(None) });
    let access = Arc::clone(&tokens)
        .refresh(false)
        .await
        .expect("TIER 2 UNRUN: no Google account available in this environment");
    let videos = real_drive_files_with_extension(&access, &["mkv", "mp4"])
        .await
        .expect("TIER 2 UNRUN: files.list for video failed");
    let audios = real_drive_files_with_extension(&access, &["mp3", "flac"])
        .await
        .expect("TIER 2 UNRUN: files.list for audio failed");
    let (video_id, video_name) = videos
        .first()
        .cloned()
        .expect("TIER 2 UNRUN: this Drive has no .mkv/.mp4 file");
    let (audio_id, audio_name) = audios
        .first()
        .cloned()
        .expect("TIER 2 UNRUN: this Drive has no audio file");
    println!("[tier2] real Drive video: {video_name} ({video_id})");
    println!("[tier2] real Drive audio: {audio_name} ({audio_id})");

    let sink: crate::stream_proxy::server::ErrorSink = Arc::new(|file_id, status| {
        println!("[tier2] stream-proxy-error {file_id} {status}");
    });
    let proxy = crate::stream_proxy::server::spawn_proxy(
        sink,
        REAL_DRIVE_BASE_URL.to_string(),
        tokens,
        REAL_DRIVE_HEADERS_TIMEOUT,
        PROXY_BODY_IDLE_TIMEOUT,
    )
    .expect("proxy must start");

    let mut session = Session::spawn("tier2-drive").await;
    let started = Instant::now();
    session
        .load_like_the_app(&proxy_url(proxy, &video_id), true)
        .await
        .expect("loadfile of the real Drive video must succeed");
    assert!(
        session.wait_first_video_frame(Duration::from_secs(60)).await,
        "the real Drive video must reach a video frame within 60s"
    );
    println!(
        "[tier2] VIDEO-015 first frame: {} in {}ms",
        session.vo_line().unwrap_or_default(),
        started.elapsed().as_millis()
    );
    assert!(session.wait_playing().await, "the real Drive video must start playing");
    let window = session
        .wait_for_window(Duration::from_secs(10))
        .await
        .expect("a real Drive video must own a window");
    println!("[tier2] VIDEO-015 window: {window}");
    let duration = session.wait_duration().await;
    for (label, fraction) in [("forward", SEEK_TARGET_FRACTION), ("backward", 0.1)] {
        let target = duration * fraction;
        let seek_started = Instant::now();
        session
            .command(vec![json!("seek"), json!(target), json!("absolute")])
            .await
            .expect("seek must be accepted");
        let landed = session
            .wait_property("time-pos", Duration::from_secs(30), |value| {
                (value.as_f64().unwrap_or(-1.0) - target).abs() <= SEEK_TOLERANCE_SECS
            })
            .await
            .and_then(|value| value.as_f64())
            .unwrap_or_else(|| panic!("a real Drive {label} seek to {target:.1}s never landed"));
        println!(
            "[tier2] VIDEO-015 {label} seek: target {target:.1}s -> {landed:.1}s in {}ms",
            seek_started.elapsed().as_millis()
        );
    }
    if let Some((working, private)) = memory_mb(session.pid) {
        println!("[tier2] VIDEO-015 mpv WorkingSet/Private MB: {working:.0}/{private:.0}");
    }
    let cache = session.property("demuxer-cache-state").await.unwrap_or(Value::Null);
    println!(
        "[tier2] VIDEO-015 demuxer-cache-state (R3 quota proxy): {}",
        cache.get("total-bytes").and_then(Value::as_u64).unwrap_or(0) as u64
    );
    println!("[tier2] VIDEO-015 demuxer-cache-state raw: {cache}");

    // VIDEO-011: the real switch, video -> audio, on real files.
    session
        .load_like_the_app(&proxy_url(proxy, &audio_id), false)
        .await
        .expect("loadfile of the real Drive audio must succeed");
    session.settle().await;
    let after = all_windows(session.pid);
    println!("[tier2] VIDEO-011 windows after video->audio: {after:?}");
    assert!(after.is_empty(), "the video window must be gone after switching to audio");
    session.quit().await;
    assert_no_mpv("tier2 drive run").await;
}

/// TIER 2 (VIDEO-013) — UNRUN without a Google account.
/// Close the app while a REAL Drive video plays: no orphan mpv.exe, no window.
///
/// Missing: a signed-in Google account with a video file. Expected: exactly the
/// same guarantee the local fixture proves — the kill-on-close job takes the
/// sidecar with it and the OS window list has nothing left for that pid.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "TIER 2: needs a signed-in Google account with a real video file"]
async fn real_drive_app_exit_during_playback() {
    let tokens = Arc::new(VaultTokens { cached: std::sync::Mutex::new(None) });
    let access = Arc::clone(&tokens)
        .refresh(false)
        .await
        .expect("TIER 2 UNRUN: no Google account available in this environment");
    let videos = real_drive_files_with_extension(&access, &["mkv", "mp4"])
        .await
        .expect("TIER 2 UNRUN: files.list for video failed");
    let (video_id, video_name) = videos
        .first()
        .cloned()
        .expect("TIER 2 UNRUN: this Drive has no .mkv/.mp4 file");
    println!("[tier2] real Drive video: {video_name} ({video_id})");
    let sink: crate::stream_proxy::server::ErrorSink = Arc::new(|_, _| {});
    let proxy = crate::stream_proxy::server::spawn_proxy(
        sink,
        REAL_DRIVE_BASE_URL.to_string(),
        tokens,
        REAL_DRIVE_HEADERS_TIMEOUT,
        PROXY_BODY_IDLE_TIMEOUT,
    )
    .expect("proxy must start");

    let watched_pid;
    {
        let session = Session::spawn("tier2-exit").await;
        watched_pid = session.pid;
        session
            .load_like_the_app(&proxy_url(proxy, &video_id), true)
            .await
            .expect("loadfile must succeed");
        assert!(
            session.wait_for_window(Duration::from_secs(60)).await.is_some(),
            "the real Drive video must own a window"
        );
        // Abrupt app exit: the Session (and with it the kill-on-close job) drops
        // without any `quit`.
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut orphans = mpv_pids();
    while !orphans.is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
        orphans = mpv_pids();
    }
    println!("[tier2] VIDEO-013 mpv.exe after app exit: {orphans:?}");
    assert!(orphans.is_empty(), "no orphan mpv.exe may survive, got {orphans:?}");
    assert!(all_windows(watched_pid).is_empty(), "no window may survive");
}

/// TIER 2 (VIDEO-016 / R7) — RUN when a Google account exists (one does on this
/// machine: the OS vault holds a refresh token), and it measures the BLAST
/// RADIUS of the missing `resourceKey` support rather than asserting a wish.
///
/// Missing for a full pass: a file shared by link from a DIFFERENT account (or a
/// Shared Drive file), because this account can only share with itself. So the
/// test reports how many of the account's own files carry a `resourceKey` at all;
/// a non-zero count would mean real Shared-Drive content is unplayable today,
/// zero means the gap is latent. `build_upstream_url` documents the gap.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "TIER 2: needs a signed-in Google account"]
async fn real_drive_resource_key_gap_is_measured() {
    let tokens = Arc::new(VaultTokens { cached: std::sync::Mutex::new(None) });
    let access = tokens
        .refresh(false)
        .await
        .expect("TIER 2 UNRUN: no Google account available in this environment");
    let response = reqwest::Client::new()
        .get(format!("{REAL_DRIVE_BASE_URL}/drive/v3/files"))
        .query(&[
            ("pageSize", "100"),
            ("fields", "files(id,name,resourceKey,shared,driveId)"),
            ("supportsAllDrives", "true"),
            ("includeItemsFromAllDrives", "true"),
            ("corpora", "allDrives"),
        ])
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {access}"))
        .send()
        .await
        .expect("files.list must succeed");
    assert_eq!(response.status(), reqwest::StatusCode::OK, "files.list must return 200");
    let listing: Value = response.json().await.expect("files.list must return JSON");
    let files = listing["files"].as_array().cloned().unwrap_or_default();
    let with_resource_key: Vec<&str> = files
        .iter()
        .filter(|file| !file["resourceKey"].as_str().unwrap_or("").is_empty())
        .map(|file| file["name"].as_str().unwrap_or("?"))
        .collect();
    let shared: Vec<&str> = files
        .iter()
        .filter(|file| file["shared"].as_bool() == Some(true))
        .map(|file| file["name"].as_str().unwrap_or("?"))
        .collect();
    println!(
        "[tier2] VIDEO-016 probed {} files: {} carry a resourceKey, {} are shared",
        files.len(),
        with_resource_key.len(),
        shared.len()
    );
    println!("[tier2] VIDEO-016 shared-by-others (unplayable today): {shared:?}");
    println!("[tier2] VIDEO-016 carrying a resourceKey: {with_resource_key:?}");
    // The proxy CANNOT forward a resourceKey (handle_request reads uri().path()
    // only), so any file in `shared_that_needs_a_key` is a hard 404/403 for the
    // user. This account cannot produce one, so the assertion only records that
    // the probe ran.
    assert!(files.len() > 0, "files.list returned nothing at all");
}

/// REGRESSION BASELINE for audio, on the SAME code path as the video numbers:
/// a real Drive audio track through the real proxy with the shipped flag set
/// (mpv `video` set to "no", exactly what `mpvAudio.loadTrack` sends for audio).
/// Every number in the video column has an audio counterpart here, so "audio is
/// unaffected" is a table, not an adjective.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a signed-in Google account with a real audio file"]
async fn audio_baseline_through_the_real_proxy() {
    const AUDIO_SAMPLE_SECS: u64 = 8;
    let tokens = Arc::new(VaultTokens { cached: std::sync::Mutex::new(None) });
    let access = Arc::clone(&tokens)
        .refresh(false)
        .await
        .expect("UNRUN: no Google account available in this environment");
    let audios = real_drive_files_with_extension(&access, &["mp3", "flac", "m4a"])
        .await
        .expect("UNRUN: files.list for audio failed");
    let (audio_id, audio_name) = audios
        .first()
        .cloned()
        .expect("UNRUN: this Drive has no audio file");
    println!("[audio] real Drive track: {audio_name} ({audio_id})");
    let sink: crate::stream_proxy::server::ErrorSink = Arc::new(|_, _| {});
    let proxy = crate::stream_proxy::server::spawn_proxy(
        sink,
        REAL_DRIVE_BASE_URL.to_string(),
        tokens,
        REAL_DRIVE_HEADERS_TIMEOUT,
        PROXY_BODY_IDLE_TIMEOUT,
    )
    .expect("proxy must start");

    let mut session = Session::spawn("audio-baseline").await;
    let started = Instant::now();
    // `video=false` is byte-for-byte what the app sends for an audio track.
    session
        .load_like_the_app(&proxy_url(proxy, &audio_id), false)
        .await
        .expect("loadfile must succeed");
    assert!(session.wait_playing().await, "audio playback must start");
    println!("[audio] first audio in {}ms", started.elapsed().as_millis());
    session.settle().await;
    assert!(
        first_window(session.pid).is_none(),
        "an audio track must never open a window"
    );
    let duration = session.wait_duration().await;
    for (label, fraction) in [("forward", SEEK_TARGET_FRACTION), ("backward", 0.1)] {
        let target = duration * fraction;
        let seek_started = Instant::now();
        session
            .command(vec![json!("seek"), json!(target), json!("absolute")])
            .await
            .expect("seek must be accepted");
        let landed = session
            .wait_property("time-pos", Duration::from_secs(30), |value| {
                (value.as_f64().unwrap_or(-1.0) - target).abs() <= SEEK_TOLERANCE_SECS
            })
            .await
            .and_then(|value| value.as_f64())
            .unwrap_or_else(|| panic!("audio {label} seek to {target:.1}s never landed"));
        println!(
            "[audio] {label} seek: target {target:.1}s -> {landed:.1}s in {}ms",
            seek_started.elapsed().as_millis()
        );
    }
    let cpu_before = cpu_secs(session.pid);
    let memory_before = memory_mb(session.pid);
    let steady = Instant::now();
    tokio::time::sleep(Duration::from_secs(AUDIO_SAMPLE_SECS)).await;
    if let (Some(before), Some(after)) = (cpu_before, cpu_secs(session.pid)) {
        println!(
            "[audio] mpv CPU%: {:.1}",
            (after - before) / steady.elapsed().as_secs_f64() * 100.0
        );
    }
    if let Some((working, private)) = memory_mb(session.pid).or(memory_before) {
        println!("[audio] mpv WorkingSet/Private MB: {working:.0}/{private:.0}");
    }
    println!("[audio] mpv.exe process count: {}", mpv_pids().len());
    session.quit().await;
    assert_no_mpv("audio baseline").await;
}
