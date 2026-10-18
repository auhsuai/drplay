use std::time::{Duration, Instant};

use super::fixtures::fixture;
use super::observe::assert_no_mpv;
use super::observe::memory_mb;
use super::observe::report;
use super::origin::spawn_origin;
use super::origin::Stall;
use super::proxy::proxy_url;
use super::proxy::spawn_real_proxy;
use super::session::Session;
use super::PROXY_BODY_IDLE_TIMEOUT;
use super::READY_TIMEOUT;

pub(super) async fn peak_memory_mb(session: &Session, window: Duration) -> f64 {
    let mut peak = 0.0f64;
    let stop = Instant::now() + window;
    while Instant::now() < stop {
        if let Some((working, _)) = memory_mb(session.pid) {
            peak = peak.max(working);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    peak
}

/// F.1 (mpv side) + T18: a REAL upstream that goes silent past the proxy's idle
/// deadline. Question: does the proxy abort, and does mpv recover or does the
/// track die? Characterisation only — the tuning decision belongs to the
/// proxy-side measurement in stream_proxy.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the real mpv sidecar; takes ~1 minute"]
async fn silent_upstream_past_the_idle_deadline_is_characterised() {
    let file = fixture("probe.mkv");
    let origin = spawn_origin(
        &file,
        Some(Stall {
            first_bytes: 128 * 1024,
            stall: PROXY_BODY_IDLE_TIMEOUT + Duration::from_secs(5),
        }),
        &[],
    );
    let proxy = spawn_real_proxy(origin.port, PROXY_BODY_IDLE_TIMEOUT);
    let mut session = Session::spawn("stall").await;
    session
        .load_like_the_app(&proxy_url(proxy, "stalling-file"), true)
        .await
        .expect("loadfile must succeed");
    let started = Instant::now();
    assert!(
        session.wait_first_video_frame(READY_TIMEOUT).await,
        "the first frame must arrive before the stall is felt"
    );
    report("F.1 mpv first frame (pre-stall)", format!("{}ms", started.elapsed().as_millis()));

    // The stall outlives the 20s body-idle deadline, so the proxy MUST abort.
    // Whether mpv then recovers is exactly what this measures.
    let died = session
        .wait_property(
            "idle-active",
            PROXY_BODY_IDLE_TIMEOUT + Duration::from_secs(60),
            |value| value.as_bool() == Some(true),
        )
        .await
        .is_some();
    let log = session.log();
    report(
        "F.1 mpv outcome after the abort",
        format!(
            "engine-idle={died} at {}ms, time-pos={:.1}, end-file={:?}, reconnect-marker={}",
            started.elapsed().as_millis(),
            session.property_f64("time-pos").await.unwrap_or(-1.0),
            session.end_file_events(),
            log.contains("Reconnecting") || log.contains("reconnect")
        ),
    );
    // More than one range request after a mid-body abort is the observable proof
    // that mpv re-opened the stream instead of dying on it.
    let ranges = origin.requests();
    report(
        "F.1 origin range requests after the abort",
        format!(
            "{} total, paths={:?}",
            ranges.len(),
            ranges.iter().map(|entry| entry.range.clone()).collect::<Vec<_>>()
        ),
    );
    assert!(!log.contains("panic"), "a stalled upstream must never panic the sidecar");
    session.quit().await;
    assert_no_mpv("F.1 stall run").await;
}
