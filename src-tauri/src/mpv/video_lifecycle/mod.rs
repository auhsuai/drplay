//! Real-sidecar measurement harness for the video slice (Phase E + the test
//! matrix). Nothing here is a mock: it spawns the SHIPPED mpv sidecar with the
//! SHIPPED flag set (`mpv_flags`) and points it at the REAL localhost stream
//! proxy, which in turn talks to a real HTTP Range origin.
//!
//! Why a harness instead of "run the app": a DrPlay playback session needs a
//! real Google Drive file, and there is no account in this environment. What
//! the window lifecycle and the seek/latency numbers depend on is (1) the mpv
//! flag set, (2) the exact IPC command sequence `mpvAudio.loadTrack` sends,
//! and (3) the proxy in front of it — all three are reproduced verbatim here,
//! so the numbers are the app's; only Drive itself is replaced by a local
//! origin. Everything that genuinely needs Google is reported UNRUN instead of
//! guessed.
//!
//! Every test is `#[ignore]`d: they need the sidecar binary
//! (`node scripts/fetch-mpv.mjs`) plus real media fixtures, and they take
//! seconds each. Run them explicitly:
//!   cargo test --manifest-path src-tauri/Cargo.toml video_lifecycle -- --ignored --nocapture --test-threads=1
//! Fixtures come from `$DRPLAY_VIDEO_FIXTURES`. A missing fixture PANICS with
//! its path — never a silent skip.

mod drive;
mod fixtures;
mod observe;
mod origin;
mod proxy;
mod session;
mod stall;
mod transport;
mod window;

use std::time::Duration;

/// Deadline for "mpv must reach this state". Generous for a cold file on a
/// warm page cache, short enough that a wedged engine fails instead of hanging.
pub(super) const READY_TIMEOUT: Duration = Duration::from_secs(20);
/// Gap allowed around a seek target: the SAME contract the production seek-ack
/// uses (`SEEK_ACK_TOLERANCE_SECS = 1`, src/lib/mpvProtocol.ts).
pub(super) const SEEK_TOLERANCE_SECS: f64 = 1.0;
/// Fraction of the duration the forward-seek tests aim at.
pub(super) const SEEK_TARGET_FRACTION: f64 = 0.75;
/// The two production deadlines, spelled out. These mirror
/// `UPSTREAM_HEADERS_TIMEOUT` / `UPSTREAM_BODY_IDLE_TIMEOUT` in
/// stream_proxy/mod.rs: if a shipped value changes, this harness must change
/// with it — the tests exist to measure the SHIPPED numbers.
pub(super) const PROXY_HEADERS_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const PROXY_BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(20);
