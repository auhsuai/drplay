use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::fixtures::fixture;
use super::observe::all_windows;
use super::observe::assert_no_mpv;
use super::observe::cpu_secs;
use super::observe::memory_mb;
use super::observe::mpv_pids;
use super::observe::report;
use super::origin::spawn_origin;
use super::proxy::proxy_url;
use super::proxy::spawn_real_proxy;
use super::session::Session;
use super::stall::peak_memory_mb;
use super::PROXY_BODY_IDLE_TIMEOUT;
use super::READY_TIMEOUT;
use super::SEEK_TARGET_FRACTION;
use super::SEEK_TOLERANCE_SECS;

// ---------------------------------------------------------------------------
// Container matrix (T01/T02/T03 + T04 + T14 + T17)
// ---------------------------------------------------------------------------

/// One test per container so a failure names the container instead of hiding
/// the two after it.
macro_rules! container_test {
    ($name:ident, $fixture:literal, $id:literal) => {
        #[tokio::test(flavor = "multi_thread")]
        #[ignore = "needs the real mpv sidecar + a real media fixture"]
        async fn $name() {
            let file = fixture($fixture);
            let origin = spawn_origin(&file, None, &["missing-file"]);
            let proxy = spawn_real_proxy(origin.port, PROXY_BODY_IDLE_TIMEOUT);
            let mut session = Session::spawn($id).await;
            let url = proxy_url(proxy, "video-file");

            let started = Instant::now();
            session
                .load_like_the_app(&url, true)
                .await
                .unwrap_or_else(|error| panic!("loadfile must succeed: {error}"));
            let duration = session.wait_duration().await;
            report(concat!($id, " duration"), format!("{duration:.3}s"));

            // A real VIDEO frame needs a decoded video track: mpv only configures
            // the VO (and therefore opens a window) once it has video to show.
            assert!(
                session.wait_first_video_frame(READY_TIMEOUT).await,
                "no video output within {READY_TIMEOUT:?}"
            );
            let width = session.property_f64("osd-width").await.unwrap_or(0.0);
            let height = session.property_f64("osd-height").await.unwrap_or(0.0);
            report(
                concat!($id, " first frame"),
                format!("{width}x{height} in {}ms", started.elapsed().as_millis()),
            );
            assert!(session.wait_playing().await, "time-pos must advance: playback did not start");
            let window = session
                .wait_for_window(Duration::from_secs(8))
                .await
                .unwrap_or_else(|| panic!("a video track must produce a top-level window"));
            report(concat!($id, " window"), window);

            // T04: startup latency from mpv's own clock, decoder open -> VO up.
            let decoder = session.log_timestamp_secs("Opening decoder").unwrap_or_else(|| {
                panic!("the sidecar log must record the decoder opening; sidecar log: {}", session.log_path.display())
            });
            let vo = session.log_timestamp_secs("VO: [").unwrap_or_else(|| {
                panic!("the sidecar log must record the video output; sidecar log: {}", session.log_path.display())
            });
            let vo_line = session.vo_line().unwrap_or_else(|| {
                panic!("the sidecar log must record the VO line; sidecar log: {}", session.log_path.display())
            });
            assert!(
                vo_line.starts_with("gpu-next"),
                "video output must be gpu-next (MPV_VIDEO_OUTPUT), got {vo_line}"
            );
            report(concat!($id, " VO"), vo_line);
            report(concat!($id, " decoder->VO"), format!("{:.0}ms", (vo - decoder) * 1000.0));

            // T14: the mpv-facing URL is localhost + file id. The Bearer is the
            // proxy's job, upstream, and never appears in a URL or the log.
            assert_eq!(url, format!("http://127.0.0.1:{proxy}/stream/video-file"));
            for forbidden in ["googleapis", "access_token", "Bearer", "token="] {
                assert!(!url.contains(forbidden), "the stream URL must not contain {forbidden}");
            }
            let log = session.log();
            assert!(
                !log.to_ascii_lowercase().contains("access_token"),
                "the sidecar log must not contain an access token"
            );
            let requests = origin.requests();
            assert!(
                requests.iter().all(|entry| entry.had_bearer),
                "the proxy must attach the Bearer upstream for every range request"
            );
            assert!(
                requests.iter().all(|entry| {
                    let haystack = format!("{} {}", entry.path, entry.range.clone().unwrap_or_default());
                    !haystack.contains("access_token") && !haystack.contains("token=")
                }),
                "no upstream URL may carry a token in the query"
            );
            report(
                concat!($id, " proxy range requests / max response"),
                format!(
                    "{} requests, max {} bytes of {}",
                    requests.len(),
                    origin.max_response_bytes(),
                    std::fs::metadata(&file).expect("fixture metadata").len()
                ),
            );

            // T17: a file id the origin does not know must end the track with a
            // clean error — no crash, no hang.
            session
                .load_like_the_app(&proxy_url(proxy, "missing-file"), true)
                .await
                .expect("loadfile of a missing id must still be accepted by mpv");
            let idle = session
                .wait_property("idle-active", Duration::from_secs(20), |value| value.as_bool() == Some(true))
                .await;
            let events = session.end_file_events();
            report(concat!($id, " missing-file"), format!("idle-active={idle:?} end-file={events:?}"));
            assert!(
                events.iter().any(|(reason, _)| reason.as_deref() == Some("error")),
                "a missing file id must surface as end-file reason=error, got {events:?}"
            );

            session.quit().await;
            assert_no_mpv($id).await;
        }
    };
}

container_test!(h264_mkv_plays_over_the_real_proxy, "probe.mkv", "T01");
container_test!(h264_mp4_faststart_plays_over_the_real_proxy, "probe-faststart.mp4", "T02");
container_test!(fragmented_mp4_plays_over_the_real_proxy, "probe-frag.mp4", "T03");

/// T05/T06/T07/T08/T09 + the sidecar half of Phase 14: the transport controls a
/// video track needs, plus the "exactly one engine" check.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the real mpv sidecar + a real media fixture"]
async fn transport_controls_on_a_video_track() {
    let file = fixture("probe.mkv");
    let origin = spawn_origin(&file, None, &[]);
    let proxy = spawn_real_proxy(origin.port, PROXY_BODY_IDLE_TIMEOUT);
    let mut session = Session::spawn("transport").await;

    session
        .load_like_the_app(&proxy_url(proxy, "video-file"), true)
        .await
        .expect("loadfile must succeed");
    let duration = session.wait_duration().await;
    assert!(session.wait_playing().await, "playback must start");
    assert!(
        session.wait_for_window(Duration::from_secs(8)).await.is_some(),
        "a playing video track must own a window"
    );

    // T08 volume + mute.
    session
        .command(vec![json!("set_property"), json!("volume"), json!(55)])
        .await
        .expect("volume must be settable");
    let volume = session.property_f64("volume").await.expect("volume must be readable");
    assert!((volume - 55.0).abs() < 0.5, "volume must read back 55, got {volume}");
    for mute in ["yes", "no"] {
        session
            .command(vec![json!("set_property"), json!("mute"), json!(mute)])
            .await
            .expect("mute must be settable");
        let value = session.property("mute").await.expect("mute must be readable");
        assert_eq!(value.as_bool(), Some(mute == "yes"), "mute must read back {mute}");
    }
    report("T08 volume/mute", format!("{volume}, mute toggled both ways"));

    // T07 pause / resume.
    session
        .command(vec![json!("set_property"), json!("pause"), json!("yes")])
        .await
        .expect("pause must be settable");
    tokio::time::sleep(Duration::from_millis(700)).await;
    let at_pause = session.property_f64("time-pos").await.unwrap_or(-1.0);
    tokio::time::sleep(Duration::from_millis(900)).await;
    let held = session.property_f64("time-pos").await.unwrap_or(-1.0);
    assert!((held - at_pause).abs() < 0.25, "a paused track must not advance: {at_pause} -> {held}");
    session
        .command(vec![json!("set_property"), json!("pause"), json!("no")])
        .await
        .expect("resume must be settable");
    assert!(
        session
            .wait_property("time-pos", Duration::from_secs(10), |value| {
                value.as_f64().unwrap_or(0.0) > held + 0.3
            })
            .await
            .is_some(),
        "resume must advance time-pos again"
    );
    report("T07 pause/resume", format!("held at {held:.2}s, then advanced"));

    // T05 / T06 seek accuracy and latency, in both directions.
    for (id, fraction) in [("T05 forward", SEEK_TARGET_FRACTION), ("T06 backward", 0.1)] {
        let target = duration * fraction;
        let started = Instant::now();
        session
            .command(vec![json!("seek"), json!(target), json!("absolute")])
            .await
            .expect("seek must be accepted");
        let landed = session
            .wait_property("time-pos", Duration::from_secs(20), |value| {
                (value.as_f64().unwrap_or(-1.0) - target).abs() <= SEEK_TOLERANCE_SECS
            })
            .await
            .and_then(|value| value.as_f64())
            .unwrap_or_else(|| panic!("{id}: seek to {target:.1}s never landed within {SEEK_TOLERANCE_SECS}s"));
        report(
            id,
            format!("target {target:.1}s -> {landed:.1}s in {}ms", started.elapsed().as_millis()),
        );
    }

    // T09 video -> video: reuse the window, no duplicate, no stale state.
    let before = all_windows(session.pid);
    session
        .load_like_the_app(&proxy_url(proxy, "second-video"), true)
        .await
        .expect("second video loadfile must succeed");
    assert!(
        session
            .wait_property("time-pos", Duration::from_secs(20), |value| {
                value.as_f64().unwrap_or(99.0) < 5.0
            })
            .await
            .is_some(),
        "the second video track must start from its own beginning"
    );
    let after = all_windows(session.pid);
    report("T09 windows", format!("{before:?} -> {after:?}"));
    assert!(!after.is_empty(), "the second video track must still own a window");
    // The TITLE follows the media (mpv sets it per file), so the reuse proof is
    // the COUNT: a second window would mean a duplicated surface, not a reused one.
    assert!(
        after.len() <= before.len().max(1),
        "a video->video switch must REUSE the window, not duplicate it: {before:?} -> {after:?}"
    );
    let errors: Vec<_> = session
        .end_file_events()
        .into_iter()
        .filter(|(reason, _)| reason.as_deref() == Some("error"))
        .collect();
    assert!(errors.is_empty(), "a video->video switch must not report an error: {errors:?}");

    // Phase 14: sidecar cost during steady playback, and the one-engine proof.
    let cpu_before = cpu_secs(session.pid);
    let steady = Instant::now();
    tokio::time::sleep(Duration::from_secs(6)).await;
    if let (Some(before), Some(after)) = (cpu_before, cpu_secs(session.pid)) {
        report(
            "video mpv CPU%",
            format!("{:.1}", (after - before) / steady.elapsed().as_secs_f64() * 100.0),
        );
    }
    if let Some((working, private)) = memory_mb(session.pid) {
        report("video mpv WorkingSet/Private MB", format!("{working:.0}/{private:.0}"));
    }
    let engines = mpv_pids();
    report("mpv.exe process count", engines.len());
    assert_eq!(engines.len(), 1, "exactly ONE mpv.exe may exist, got {engines:?}");

    // Phase 14: the proxy must stream, not slurp. The largest RANGE mpv asked
    // for is mpv's own choice (with a 17MB file and a 64MiB readahead window it
    // legitimately asks for all of it), so the meaningful number is how many
    // bytes the origin actually handed over.
    let file_size = std::fs::metadata(&file).expect("fixture metadata").len() as usize;
    report(
        "proxy streaming",
        format!(
            "max range {} of {file_size} bytes; pulled {} bytes",
            origin.max_response_bytes(),
            origin.bytes_pulled()
        ),
    );

    session.quit().await;
    assert_no_mpv("T12 transport run").await;
    let leftover = all_windows(session.pid);
    report("windows after quit", format!("{leftover:?}"));
    assert!(leftover.is_empty(), "no video window may survive the session");
}

/// T15 + T16 + the Phase 14 CRITICAL check: a large (>= 400 MB) file must play
/// and seek, and sidecar RAM must NOT scale with the file size.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the real mpv sidecar + the large fixtures"]
async fn large_containers_play_seek_and_do_not_grow_with_file_size() {
    // RAM measured on the small fixture first, so the comparison is same
    // process shape, different file size.
    let small = fixture("probe.mkv");
    let small_origin = spawn_origin(&small, None, &[]);
    let small_proxy = spawn_real_proxy(small_origin.port, PROXY_BODY_IDLE_TIMEOUT);
    let mut small_session = Session::spawn("small-baseline").await;
    small_session
        .load_like_the_app(&proxy_url(small_proxy, "small-file"), true)
        .await
        .expect("loadfile must succeed");
    assert!(small_session.wait_playing().await, "the small baseline must play");
    let small_peak = peak_memory_mb(&small_session, Duration::from_secs(4)).await;
    report("baseline (17MB MKV) mpv peak WorkingSet/Private MB", format!("{small_peak:.0}"));
    small_session.quit().await;
    assert_no_mpv("small baseline").await;

    for (id, name) in [("T15", "large.mkv"), ("T16", "large.mp4")] {
        let file = fixture(name);
        let file_size = std::fs::metadata(&file).expect("fixture metadata").len();
        assert!(
            file_size >= 400 * 1024 * 1024,
            "{id} needs a >= 400MB fixture, {name} is {file_size} bytes"
        );
        let origin = spawn_origin(&file, None, &[]);
        let proxy = spawn_real_proxy(origin.port, PROXY_BODY_IDLE_TIMEOUT);
        let mut session = Session::spawn(name).await;

        let started = Instant::now();
        session
            .load_like_the_app(&proxy_url(proxy, "large-file"), true)
            .await
            .expect("loadfile must succeed");
        assert!(
            session.wait_first_video_frame(Duration::from_secs(60)).await,
            "{id}: no video output for {name} within 60s"
        );
        report(
            format!("{id} first frame ({name}, {}MB)", file_size / 1048576),
            format!("{} in {}ms", session.vo_line().unwrap_or_default(), started.elapsed().as_millis()),
        );
        let duration = session.wait_duration().await;
        let target = duration * SEEK_TARGET_FRACTION;
        let seek_started = Instant::now();
        session
            .command(vec![json!("seek"), json!(target), json!("absolute")])
            .await
            .expect("seek must be accepted");
        let landed = session
            .wait_property("time-pos", Duration::from_secs(40), |value| {
                (value.as_f64().unwrap_or(-1.0) - target).abs() <= SEEK_TOLERANCE_SECS
            })
            .await
            .and_then(|value| value.as_f64())
            .unwrap_or_else(|| panic!("{id}: seek to {target:.1}s never landed for {name}"));
        report(
            format!("{id} seek ({name})"),
            format!("target {target:.1}s -> {landed:.1}s in {}ms", seek_started.elapsed().as_millis()),
        );

        let peak = peak_memory_mb(&session, Duration::from_secs(8)).await;
        report(format!("{id} mpv peak WorkingSet/Private MB"), format!("{peak:.0}"));
        let cache = session.property("demuxer-cache-state").await.unwrap_or(Value::Null);
        // mpv's JSON IPC spells these keys with dashes (`fw-bytes`), not the
        // underscore form used elsewhere in the IPC.
        let cache_number = |dashed: &str, underscored: &str| {
            cache
                .get(dashed)
                .or_else(|| cache.get(underscored))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        };
        report(
            format!("{id} demuxer forward cache"),
            format!(
                "{:.0} bytes / {:.1}s (cache-secs=30, demuxer-max-bytes=64MiB) raw={cache}",
                cache_number("fw-bytes", "fw_bytes"),
                cache_number("fw-secs", "fw_secs"),
            ),
        );
        let max_response = origin.max_response_bytes() as u64;
        let pulled = origin.bytes_pulled() as u64;
        report(
            format!("{id} proxy streaming"),
            format!("max range {max_response} bytes; pulled {pulled} of {file_size}"),
        );
        assert!(
            peak < 1024.0,
            "{id}: sidecar WorkingSet peaked at {peak:.0}MB while streaming a {}MB file — RAM is tracking file size",
            file_size / 1048576
        );
        assert!(
            peak < small_peak * 4.0,
            "{id}: sidecar WorkingSet grew from {small_peak:.0}MB (17MB file) to {peak:.0}MB for a {}MB file — RAM is tracking file size",
            file_size / 1048576
        );
        session.quit().await;
        assert_no_mpv(id).await;
    }
}

/// One row of the hwdec measurement: (label, cpu percent, memory in MB —
/// working set and private bytes).
type HwdecSample = (String, f64, Option<(f64, f64)>);

/// R5 / Phase 14: the shipped flag set sets NO `hwdec`, so mpv decodes H.264 in
/// software. This measures what that costs on a real 1080p video and whether
/// `hwdec=auto-safe` (a RUNTIME property — no flag change, no second engine)
/// would be worth shipping. Measurement only: nothing here changes production.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the real mpv sidecar + large.mkv; takes ~1 minute"]
async fn software_decode_cost_is_measured() {
    /// Seconds of steady playback sampled per configuration.
    const SAMPLE_SECS: u64 = 8;
    let file = fixture("large.mkv");
    let mut results: Vec<HwdecSample> = Vec::new();

    for hwdec in ["no", "auto-safe"] {
        let origin = spawn_origin(&file, None, &[]);
        let proxy = spawn_real_proxy(origin.port, PROXY_BODY_IDLE_TIMEOUT);
        let mut session = Session::spawn(&format!("hwdec-{hwdec}")).await;
        session
            .command(vec![json!("set_property"), json!("hwdec"), json!(hwdec)])
            .await
            .unwrap_or_else(|error| panic!("hwdec={hwdec} must be settable: {error}"));
        session
            .load_like_the_app(&proxy_url(proxy, "large-file"), true)
            .await
            .expect("loadfile must succeed");
        assert!(
            session.wait_first_video_frame(Duration::from_secs(60)).await,
            "hwdec={hwdec}: no video output within 60s"
        );
        assert!(session.wait_playing().await, "hwdec={hwdec}: playback must start");

        let cpu_before = cpu_secs(session.pid);
        let memory_before = memory_mb(session.pid);
        let started = Instant::now();
        tokio::time::sleep(Duration::from_secs(SAMPLE_SECS)).await;
        let elapsed = started.elapsed().as_secs_f64();
        let cpu = match (cpu_before, cpu_secs(session.pid)) {
            (Some(before), Some(after)) => (after - before) / elapsed * 100.0,
            _ => f64::NAN,
        };
        let memory = memory_mb(session.pid).or(memory_before);
        let log = session.log();
        let decoding = if log.contains("Using hardware decoding") {
            "hardware"
        } else if log.contains("Using software decoding") {
            "software"
        } else {
            "<unknown>"
        };
        results.push((hwdec.to_string(), cpu, memory));
        report(
            format!("R5 hwdec={hwdec}"),
            format!("decoding={decoding} cpu={cpu:.1}% workingSet={memory:?}MB"),
        );
        session.quit().await;
        assert_no_mpv("R5 hwdec run").await;
    }

    let software = results.iter().find(|(name, ..)| name == "no").map(|(_, cpu, _)| *cpu);
    let accelerated = results.iter().find(|(name, ..)| name == "auto-safe").map(|(_, cpu, _)| *cpu);
    report("R5 cpu software vs auto-safe", format!("{software:?} vs {accelerated:?}"));
}
