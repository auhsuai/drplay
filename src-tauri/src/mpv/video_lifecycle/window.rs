use std::time::{Duration, Instant};

use serde_json::json;

use super::fixtures::fixture;
use super::observe::all_windows;
use super::observe::assert_no_mpv;
use super::observe::drplay_pids;
use super::observe::first_window;
use super::observe::mpv_pids;
use super::observe::report;
use super::origin::spawn_origin;
use super::proxy::proxy_url;
use super::proxy::spawn_real_proxy;
use super::session::Session;
use super::PROXY_BODY_IDLE_TIMEOUT;

/// Phase E (E.1 a/b/c) + T10/T11: window lifecycle across media-kind switches.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the real mpv sidecar + a real media fixture"]
async fn window_lifecycle_across_media_kind_switches() {
    let video_file = fixture("probe.mkv");
    let origin = spawn_origin(&video_file, None, &[]);
    let proxy = spawn_real_proxy(origin.port, PROXY_BODY_IDLE_TIMEOUT);
    let mut session = Session::spawn("lifecycle").await;

    // (a) audio -> video. The same container stands in for the audio track: what
    // decides the window is the `video` property value, which is what this test
    // varies. A real Drive audio file needs an account (UNRUN, Tier 2).
    assert!(first_window(session.pid).is_none(), "a fresh idle engine owns no window");
    session
        .load_like_the_app(&proxy_url(proxy, "audio-file"), false)
        .await
        .expect("audio loadfile must succeed");
    assert!(session.wait_playing().await, "the audio track must play");
    session.settle().await;
    let audio_window = first_window(session.pid);
    report("E.1a window while audio", format!("{audio_window:?}"));
    assert!(audio_window.is_none(), "`video=no` must not create a window, got {audio_window:?}");

    session
        .load_like_the_app(&proxy_url(proxy, "video-file"), true)
        .await
        .expect("video loadfile must succeed");
    let video_window = session
        .wait_for_window(Duration::from_secs(10))
        .await
        .unwrap_or_else(|| panic!("audio->video must open a window"));
    report("E.1a window after audio->video", video_window);
    assert!(
        session.wait_first_video_frame(Duration::from_secs(10)).await,
        "the audio->video switch must configure a video output"
    );
    report(
        "E.1a video output",
        session.vo_line().unwrap_or_else(|| "<no VO line>".to_string()),
    );

    // (b) video -> audio: the window must be GONE, not a stale black frame.
    session
        .load_like_the_app(&proxy_url(proxy, "audio-file"), false)
        .await
        .expect("audio loadfile must succeed");
    session.settle().await;
    let after_switch = first_window(session.pid);
    report("E.1b window after video->audio", format!("{after_switch:?}"));
    assert!(
        after_switch.is_none(),
        "video->audio must CLOSE the window, not leave {after_switch:?} behind"
    );
    // `video` is an mpv FLAG property, so it reads back as a bool, not the
    // literal that was written. Both spellings are accepted here so the
    // assertion tests the ENGINE state, not the wire form.
    let property = session.property("video").await.expect("the video property must be readable");
    let video_is_off = property.as_bool() == Some(false) || property.as_str() == Some("no");
    report("E.1b `video` readback", format!("{property}"));
    assert!(video_is_off, "the `video` property must read back off, got {property}");
    let audio_routed = session
        .log()
        .lines()
        .any(|line| line.contains("AO: [") && !line.contains("AO: [null]"));
    report("E.1b audio still routed", audio_routed);
    assert!(audio_routed, "the audio track must still open a real audio output");

    // (c) video -> video: the window is reused, never duplicated.
    session
        .load_like_the_app(&proxy_url(proxy, "video-file"), true)
        .await
        .expect("second video loadfile must succeed");
    assert!(
        session.wait_for_window(Duration::from_secs(10)).await.is_some(),
        "the second video must own a window again"
    );
    session
        .load_like_the_app(&proxy_url(proxy, "video-file-2"), true)
        .await
        .expect("third video loadfile must succeed");
    session.settle().await;
    let windows = all_windows(session.pid);
    report("E.1c visible windows", format!("{windows:?}"));
    assert!(
        windows.len() <= 1,
        "a video->video replace must reuse the window, not duplicate it: {windows:?}"
    );

    session.quit().await;
    assert_no_mpv("Phase E lifecycle run").await;
}

/// T12 + T13 + E.1d: `stop` and app-exit must leave no process and no window.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the real mpv sidecar + a real media fixture"]
async fn stop_and_app_exit_leave_no_orphan() {
    let file = fixture("probe.mkv");
    let origin = spawn_origin(&file, None, &[]);
    let proxy = spawn_real_proxy(origin.port, PROXY_BODY_IDLE_TIMEOUT);

    let watched_pid;
    {
        let session = Session::spawn("orphan").await;
        watched_pid = session.pid;
        session
            .load_like_the_app(&proxy_url(proxy, "video-file"), true)
            .await
            .expect("loadfile must succeed");
        let window = session
            .wait_for_window(Duration::from_secs(10))
            .await
            .unwrap_or_else(|| panic!("a playing video must own a window"));
        report("E.1d window while playing", window);

        // T12: `stop` (what the frontend sends to halt a track) must take the
        // window down. The ENGINE deliberately stays alive — it is reused for
        // the next track — so the assertion is about the window, not the process.
        session.command(vec![json!("stop")]).await.expect("stop must be accepted");
        session.settle().await;
        let after_stop = first_window(session.pid);
        report("T12 window after stop", format!("{after_stop:?}"));
        assert!(after_stop.is_none(), "`stop` must close the video window, got {after_stop:?}");
        let engines = mpv_pids();
        report("mpv.exe after stop", format!("{engines:?}"));
        assert_eq!(engines.len(), 1, "`stop` must NOT kill the reusable engine, got {engines:?}");

        // T13 / E.1d: app exit == the kill-on-close job handle is dropped. No
        // `quit` is sent: this is the abrupt-exit path.
    }

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut orphans = mpv_pids();
    while !orphans.is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
        orphans = mpv_pids();
    }
    report("E.1d mpv.exe after app exit", format!("{orphans:?}"));
    assert!(orphans.is_empty(), "app exit must leave no orphan mpv.exe (watched {watched_pid}), got {orphans:?}");
    let windows = all_windows(watched_pid);
    report("E.1d windows after app exit", format!("{windows:?}"));
    assert!(windows.is_empty(), "app exit must leave no window, got {windows:?}");

    // Phase 14 needs drplay.exe too; a playback-session figure for the app is
    // Tier 2 (needs a signed-in account), so only the idle figure is readable
    // here, and it is labelled as such rather than passed off as playback.
    report("drplay.exe pids right now", format!("{:?}", drplay_pids()));
}
