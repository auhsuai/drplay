//! S2 render-core integration tests: ENGINE-002..005, HWDEC evidence,
//! NO-WINDOW invariant, RESIZE and the audio-only idle check. Real DLL, real
//! media; missing fixtures skip loudly. These take the same serial lock as
//! the S1 engine tests (player::tests::serial) so window/thread counting
//! stays deterministic.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::gl::{channel_stats, encode_bmp24, write_bmp24};
use super::{needs_size_sync, FrameDump, PixelSample, RenderSurface, FRAME_DUMP_MAX, RENDER_THREAD_NAME};
use crate::player::engine::Engine;
use crate::player::tests::{
    collector, command, engine_available, serial, wait_for_named_threads,
    window_visibility_counts, write_test_wav,
};

/// HEVC Main10 1080p (bench fixture).
const FIXTURE_HEVC10: &str =
    r"C:\Users\admin\AppData\Local\Temp\opencode\drplay-bench\fixtures\hevc10-1080p.mkv";
/// HEVC 8-bit 1080p (bench fixture).
const FIXTURE_HEVC8: &str =
    r"C:\Users\admin\AppData\Local\Temp\opencode\drplay-bench\fixtures\hevc8-1080p.mkv";
/// H264 4K WEB-DL (real media; the 2160p case of the hwdec matrix).
const REAL_H264_4K: &str = r"E:\Mushoku_Tensei_Vietsub\S02\[ToonsHub] Mushoku Tensei_ Jobless Reincarnation - S02E01 (JAP 2160p x264 AAC) [Multi-Subs].mkv";

/// A channel value above this counts as a non-black pixel (8-bit, so 10 is
/// comfortably above measurement/rounding noise but far below any real
/// picture content).
const NON_BLACK_CHANNEL_THRESHOLD: u8 = 10;

fn media_or_skip(path: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(path);
    if candidate.is_file() {
        Some(candidate)
    } else {
        eprintln!("SKIP: media fixture missing: {path}");
        None
    }
}

/// A fresh engine with the output muted (fixtures carry audio; a 440 Hz test
/// tone has no business being audible during a test run).
fn muted_engine() -> Arc<Engine> {
    let (sink, _collected) = collector();
    let engine = Engine::create(sink).expect("engine must create with a render context");
    engine
        .send_command(&command(&["set_property", "volume", "0"]))
        .expect("volume must be settable");
    engine
}

/// `loadfile replace`, returning the bumped load epoch (sanity-checked by the
/// callers that care).
fn load(engine: &Engine, media: &Path) -> u64 {
    let media_path = media.to_string_lossy().into_owned();
    engine
        .send_command(&command(&["loadfile", media_path.as_str(), "replace"]))
        .expect("loadfile must be accepted")
        .load_epoch
}

fn wait_for_frames(engine: &Engine, minimum: u64, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let frames = engine.render_frame_count();
        if frames >= minimum {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "only {frames} frame(s) rendered in {timeout:?}; expected >= {minimum}"
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn wait_for_property_string(engine: &Engine, property: &str, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(value) = engine.get_property(property) {
            if let Some(text) = value.as_str() {
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn peak_channel(sample: &PixelSample) -> u8 {
    sample.pixels.iter().copied().max().unwrap_or(0)
}

/// Process-wide CPU time (kernel + user). Informational only — the test
/// process runs other test threads concurrently, so this is an upper bound.
fn process_cpu_time() -> Option<Duration> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let mut creation = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut exit = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut kernel = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut user = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    // SAFETY: the four out-parameters are live locals; GetCurrentProcess is a
    // pseudo-handle that needs no release.
    let ok = unsafe {
        GetProcessTimes(GetCurrentProcess(), &mut creation, &mut exit, &mut kernel, &mut user)
    };
    if ok == 0 {
        return None;
    }
    let to_u64 =
        |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    Some(Duration::from_nanos((to_u64(kernel) + to_u64(user)).saturating_mul(100)))
}

// --- ENGINE-002 -------------------------------------------------------------

/// Engine creation must produce a live render context (no silent fallback):
/// `render_ready` is true by the time `create` returns and exactly one
/// `libmpv-render` thread owns it.
#[test]
fn engine_002_create_creates_the_render_context() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let (sink, _collected) = collector();
    let engine = Engine::create(sink)
        .expect("ENGINE-002: engine creation must succeed WITH a render context (no silent fallback)");
    assert!(engine.render_ready(), "ENGINE-002: render_ready must be true once create returns");
    assert_eq!(engine.render_frame_count(), 0, "ENGINE-002: no frame before any playback");
    assert!(engine.render_surface().is_some(), "ENGINE-002: the render surface must exist");
    assert_eq!(
        wait_for_named_threads(RENDER_THREAD_NAME, 1, Duration::from_secs(2)),
        1,
        "ENGINE-002: exactly one render thread must be alive"
    );
    engine.destroy(true).expect("cleanup destroy");
    assert_eq!(
        wait_for_named_threads(RENDER_THREAD_NAME, 0, Duration::from_secs(3)),
        0,
        "ENGINE-002: destroy must join the render thread"
    );
}

// --- ENGINE-003 -------------------------------------------------------------

/// Loading real video must make the mpv update callback fire (counted on the
/// shared state; the callback itself only locks + notifies).
#[test]
fn engine_003_update_callback_fires_for_a_loaded_video() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let Some(media) = media_or_skip(FIXTURE_HEVC10) else {
        return;
    };
    let engine = muted_engine();
    let surface = engine.render_surface().expect("created during setup").clone();
    let baseline = surface.update_notifications();
    assert_eq!(load(&engine, &media), 1, "ENGINE-003: the loadfile reply bumps the epoch");

    assert!(
        wait_until(Duration::from_secs(10), || surface.update_notifications() > baseline),
        "ENGINE-003: the update callback must fire after loading {} (baseline {baseline}, now {})",
        media.display(),
        surface.update_notifications()
    );
    eprintln!(
        "ENGINE-003: {} update callback(s) after loading {}",
        surface.update_notifications() - baseline,
        media.display()
    );
    engine.destroy(true).expect("cleanup destroy");
}

// --- ENGINE-004 -------------------------------------------------------------

/// Frames must be rendered for real: the counter grows and at least one of
/// five sampled frames has a channel above the non-black threshold.
#[test]
fn engine_004_render_thread_renders_frames_into_the_fbo() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let Some(media) = media_or_skip(FIXTURE_HEVC10) else {
        return;
    };
    let engine = muted_engine();
    let surface = engine.render_surface().expect("created during setup").clone();
    load(&engine, &media);
    if let Err(short) = wait_for_frames(&engine, 5, Duration::from_secs(10)) {
        panic!("ENGINE-004: {short} after loading {}", media.display());
    }

    let mut passing: Vec<usize> = Vec::new();
    for index in 0..5 {
        std::thread::sleep(Duration::from_millis(200));
        let sample = surface
            .sample_pixels(Duration::from_secs(5))
            .expect("ENGINE-004: the FBO readback must succeed");
        let peak = peak_channel(&sample);
        eprintln!(
            "ENGINE-004 sample {index}: frames={} size={}x{} peak-channel={peak}",
            engine.render_frame_count(),
            sample.width,
            sample.height
        );
        if peak > NON_BLACK_CHANNEL_THRESHOLD {
            passing.push(index);
        }
    }
    assert!(
        !passing.is_empty(),
        "ENGINE-004: at least one of the 5 sampled frames must have a channel > {NON_BLACK_CHANNEL_THRESHOLD} (none did; peaks logged above)"
    );
    eprintln!("ENGINE-004: non-black samples: {passing:?} of 0..5");
    engine.destroy(true).expect("cleanup destroy");
}

// --- ENGINE-005 -------------------------------------------------------------

/// Destroy while video is rendering: no hang, the render thread is joined by
/// the time destroy returns.
#[test]
fn engine_005_destroy_during_render_stops_the_render_thread() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let Some(media) = media_or_skip(FIXTURE_HEVC10) else {
        return;
    };
    let engine = muted_engine();
    assert_eq!(
        wait_for_named_threads(RENDER_THREAD_NAME, 1, Duration::from_secs(2)),
        1,
        "ENGINE-005: the render thread must be alive before destroy"
    );
    load(&engine, &media);
    if let Err(short) = wait_for_frames(&engine, 2, Duration::from_secs(10)) {
        panic!("ENGINE-005: {short} after loading {}", media.display());
    }

    let started = Instant::now();
    engine.destroy(true).expect("ENGINE-005: destroy during rendering must succeed");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(5),
        "ENGINE-005: destroy took {elapsed:?} (>= 5s): the render thread join hung"
    );
    assert_eq!(
        wait_for_named_threads(RENDER_THREAD_NAME, 0, Duration::from_secs(3)),
        0,
        "ENGINE-005: the render thread must be gone after destroy"
    );
    eprintln!("ENGINE-005: destroy while rendering completed in {elapsed:?}");
}

// --- HWDEC ------------------------------------------------------------------

/// Hardware decode evidence (spec §20): `hwdec=auto-safe` must resolve to
/// nvdec (CUDA-GL interop) on this machine for HEVC Main10, HEVC 8-bit and
/// H264 4K. A software-decode fallback on any file is a FAIL.
#[test]
fn hwdec_uses_nvdec_for_hevc10_hevc8_and_h264_4k() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let cases = [
        ("hevc10-1080p", FIXTURE_HEVC10),
        ("hevc8-1080p", FIXTURE_HEVC8),
        ("h264-2160p", REAL_H264_4K),
    ];
    let engine = muted_engine();
    let surface = engine.render_surface().expect("created during setup").clone();

    let mut rows: Vec<(&str, String, String)> = Vec::new();
    for (name, path) in cases {
        let Some(media) = media_or_skip(path) else {
            continue;
        };
        let milestone = surface.frame_count();
        load(&engine, &media);
        if let Err(short) = wait_for_frames(&engine, milestone + 2, Duration::from_secs(15)) {
            panic!("HWDEC {name}: {short} after loading {}", media.display());
        }
        let hwdec = wait_for_property_string(&engine, "hwdec-current", Duration::from_secs(10))
            .unwrap_or_else(|| panic!("HWDEC {name}: hwdec-current never became available"));
        let pixelformat =
            wait_for_property_string(&engine, "video-params/pixelformat", Duration::from_secs(10))
                .unwrap_or_else(|| {
                    panic!("HWDEC {name}: video-params/pixelformat never became available")
                });
        eprintln!(
            "HWDEC {name} ({}): hwdec-current={hwdec:?} pixelformat={pixelformat:?}",
            media.display()
        );
        rows.push((name, hwdec, pixelformat));
    }
    engine.destroy(true).expect("cleanup destroy");

    assert!(!rows.is_empty(), "HWDEC: no fixture was available; nothing was verified");
    for (name, hwdec, pixelformat) in &rows {
        assert!(hwdec.starts_with("nvdec"), "HWDEC {name}: expected nvdec decoding, got {hwdec:?}");
        assert!(
            pixelformat.contains("cuda"),
            "HWDEC {name}: expected a cuda interop pixelformat, got {pixelformat:?}"
        );
    }
}

// --- NO-WINDOW invariant ----------------------------------------------------

/// The render anchor window must never be visible: the VISIBLE top-level
/// window count stays at its baseline through create, playback and destroy.
/// The hidden count is logged for transparency (the anchor adds exactly one
/// hidden window while the engine is alive; other tests running in parallel
/// may add transient windows, so only the visible count is asserted).
#[test]
fn no_window_is_ever_visible_across_the_render_lifecycle() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let Some(media) = media_or_skip(FIXTURE_HEVC10) else {
        return;
    };
    let (visible_before, hidden_before) = window_visibility_counts();

    let engine = muted_engine();
    let (visible_create, hidden_create) = window_visibility_counts();
    assert_eq!(
        visible_create, visible_before,
        "NO-WINDOW: create must not show a window (visible {visible_before} -> {visible_create})"
    );

    load(&engine, &media);
    if let Err(short) = wait_for_frames(&engine, 3, Duration::from_secs(10)) {
        panic!("NO-WINDOW: {short}");
    }
    let (visible_playing, hidden_playing) = window_visibility_counts();
    assert_eq!(
        visible_playing, visible_before,
        "NO-WINDOW: playback must not show a window (visible {visible_before} -> {visible_playing})"
    );

    engine.destroy(true).expect("cleanup destroy");
    let (visible_after, hidden_after) = window_visibility_counts();
    assert_eq!(
        visible_after, visible_before,
        "NO-WINDOW: destroy must not leave a visible window (visible {visible_before} -> {visible_after})"
    );
    eprintln!(
        "NO-WINDOW: visible stable at {visible_before}; hidden {hidden_before} -> {hidden_create} (create) -> {hidden_playing} (playing) -> {hidden_after} (destroyed)"
    );
}

// --- RESIZE (ENGINE-019 partial) --------------------------------------------

/// Resizing while playing: up to 1920x1080 and back to 1280x720, without a
/// crash, with rendering continuing and non-black frames after each resize.
#[test]
fn resize_during_playback_keeps_rendering_and_reallocates_the_fbo() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let Some(media) = media_or_skip(FIXTURE_HEVC10) else {
        return;
    };
    let engine = muted_engine();
    let surface = engine.render_surface().expect("created during setup").clone();
    load(&engine, &media);
    if let Err(short) = wait_for_frames(&engine, 3, Duration::from_secs(10)) {
        panic!("RESIZE: {short} before the first resize");
    }

    let before_up = engine.render_frame_count();
    surface.resize(1920, 1080).expect("RESIZE: resize up must be accepted");
    if let Err(short) = wait_for_frames(&engine, before_up + 3, Duration::from_secs(10)) {
        panic!("RESIZE: rendering must continue after 1920x1080: {short}");
    }
    let sample_up =
        surface.sample_pixels(Duration::from_secs(5)).expect("RESIZE: readback after resize up");
    assert_eq!(
        (sample_up.width, sample_up.height),
        (1920, 1080),
        "RESIZE: the FBO must be reallocated to 1920x1080"
    );
    let peak_up = peak_channel(&sample_up);
    assert!(
        peak_up > NON_BLACK_CHANNEL_THRESHOLD,
        "RESIZE: the frame after resize up must be non-black, peak={peak_up}"
    );

    let before_down = engine.render_frame_count();
    surface.resize(1280, 720).expect("RESIZE: resize down must be accepted");
    if let Err(short) = wait_for_frames(&engine, before_down + 3, Duration::from_secs(10)) {
        panic!("RESIZE: rendering must continue after 1280x720: {short}");
    }
    let sample_down =
        surface.sample_pixels(Duration::from_secs(5)).expect("RESIZE: readback after resize down");
    assert_eq!(
        (sample_down.width, sample_down.height),
        (1280, 720),
        "RESIZE: the FBO must be back to 1280x720"
    );
    let peak_down = peak_channel(&sample_down);
    assert!(
        peak_down > NON_BLACK_CHANNEL_THRESHOLD,
        "RESIZE: the frame after resize down must be non-black, peak={peak_down}"
    );
    eprintln!("RESIZE: peaks {peak_up} (1920x1080) / {peak_down} (1280x720)");
    engine.destroy(true).expect("cleanup destroy");
}

// --- Audio-only idle --------------------------------------------------------

/// Audio-only playback must keep the render thread idle: it may not spin and
/// must render zero frames. A generated WAV is used (no video track).
#[test]
fn audio_only_playback_keeps_the_render_thread_idle() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let engine = muted_engine();
    let surface = engine.render_surface().expect("created during setup").clone();
    let wav = std::env::temp_dir().join(format!("drplay-s2-audio-only-{}.wav", std::process::id()));
    write_test_wav(&wav);
    load(&engine, &wav);

    assert!(
        wait_until(Duration::from_secs(10), || {
            engine
                .get_property("time-pos")
                .ok()
                .and_then(|value| value.as_f64())
                .map(|position| position > 0.0)
                .unwrap_or(false)
        }),
        "AUDIO-ONLY: playback must actually run (time-pos never advanced)"
    );

    let cpu_before = process_cpu_time();
    std::thread::sleep(Duration::from_secs(2));
    let cpu_after = process_cpu_time();
    let frames = engine.render_frame_count();
    assert_eq!(frames, 0, "AUDIO-ONLY: the render thread must render no frames (got {frames})");
    eprintln!(
        "AUDIO-ONLY: frames=0, notifications={}, process-wide CPU delta over 2s idle = {:?} (includes every other test thread; informational only)",
        surface.update_notifications(),
        cpu_after.zip(cpu_before).map(|(after, before)| after.saturating_sub(before))
    );

    engine.destroy(true).expect("cleanup destroy");
    let _ = std::fs::remove_file(&wav);
}

// --- S4b: the rect/size sync contract and the solid-fill diagnostic ---------

/// `needs_size_sync` decides whether a rect request rebuilds the GL FBO, the
/// interop registration and the DComp surface together. The whole S4b
/// ENGINE-B hypothesis (CopyResource pairing mismatched textures) reduces to
/// this predicate, so it is pinned directly instead of only through the
/// GPU-backed S3-05 test — a mistake here must fail without a window, a GPU or
/// a media fixture.
#[test]
fn size_sync_rebuilds_exactly_when_the_target_size_changes() {
    // A real change rebuilds — this is the 1000x639 -> 1024x703 case.
    assert!(needs_size_sync((1000, 639), (1024, 703)));
    // Same size must NOT rebuild: rebuilding reallocates the registered GL
    // texture and the DComp surface on every frontend rect push (dragging,
    // resize storms) for nothing.
    assert!(!needs_size_sync((1024, 703), (1024, 703)));
    // A collapsed rect must never rebuild — there is no target to build, and
    // Composition::set_rect leaves the surface alone for exactly this case.
    assert!(!needs_size_sync((1024, 703), (0, 0)));
    assert!(!needs_size_sync((1024, 703), (1024, 0)));
    assert!(!needs_size_sync((1024, 703), (0, 703)));
    // The initial 1280x720 headless target: an identical first rect must not
    // rebuild, a different one must.
    assert!(!needs_size_sync((1280, 720), (1280, 720)));
    assert!(needs_size_sync((1280, 720), (1000, 639)));
}

/// The one-shot first-frame signal (visual polish). The frontend can only keep
/// an empty video rect opaque if it knows "a frame of THIS item is on screen",
/// and the only honest source is the presented-frame counter on the render
/// thread. This pins the two halves of that contract that are testable without
/// a GPU: a fresh surface is ARMED, and `rearm_first_frame` disarms it again so
/// the next media item cannot be satisfied by the previous one's frame.
#[test]
fn the_first_frame_signal_is_armed_per_media_load() {
    let engine = muted_engine();
    let surface = engine
        .render_surface()
        .expect("engine must own a render surface");
    assert!(
        !surface.first_frame_emitted(),
        "a fresh surface must be armed: nothing has been presented for this load yet"
    );

    // What the render thread does on its first successful present.
    surface.mark_first_frame_emitted();
    assert!(
        surface.first_frame_emitted(),
        "the first present must disarm the signal"
    );

    // `loadfile` for the next item (engine.rs) re-arms it, so the next present
    // signals again instead of being swallowed by the previous item's signal.
    engine
        .send_command(&command(&["loadfile", "does-not-need-to-exist.mkv", "replace"]))
        .expect("loadfile must be accepted");
    assert!(
        !surface.first_frame_emitted(),
        "a new load must re-arm the one-shot, or the next item never gets a signal"
    );

    engine.destroy(false).ok();
}

/// The solid-fill diagnostic is the S4b decision procedure: magenta on screen
/// proves the webview is alpha=0 over the rect. The exact color is pinned
/// because the pass/fail test is literally "is the rect #FF00FF".
#[test]
fn the_solid_fill_diagnostic_clears_pure_magenta() {
    let [r, g, b, a] = super::DIAG_SOLID_COLOR;
    assert_eq!((r, g, b, a), (1.0, 0.0, 1.0, 1.0), "must be opaque #FF00FF, nothing else");
}

// --- S3 composition bridge (NV_DX_interop2 -> D3D11 -> DirectComposition) ---

/// A hidden top-level window standing in for the app's main window: the DComp
/// target policy is per-window, and the S3 tests must never show one. Never
/// carries WS_VISIBLE and never sees `ShowWindow`; the NO-WINDOW invariant
/// counts it in the hidden bucket only.
mod hidden_window {
    use windows_sys::Win32::Foundation::{GetLastError, HWND};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, WNDCLASSW, WS_POPUP,
    };

    const CLASS_NAME: &str = "DrPlayS3TestWindow";
    /// Win32 error `ERROR_CLASS_ALREADY_EXISTS` (1410).
    const ERROR_CLASS_ALREADY_EXISTS: u32 = 1410;

    pub(super) struct HiddenTestWindow {
        hwnd: HWND,
    }

    impl HiddenTestWindow {
        pub(super) fn create() -> Self {
            let class: Vec<u16> =
                CLASS_NAME.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: same contract as the production anchor window (gl.rs):
            // a NUL-terminated class name, a documentedly hidden popup style,
            // and every returned handle checked before use.
            unsafe {
                let instance = GetModuleHandleW(std::ptr::null());
                assert!(!instance.is_null(), "GetModuleHandleW(NULL) must succeed");
                let window_class = WNDCLASSW {
                    style: 0,
                    lpfnWndProc: Some(DefWindowProcW),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: instance,
                    hIcon: std::ptr::null_mut(),
                    hCursor: std::ptr::null_mut(),
                    hbrBackground: std::ptr::null_mut(),
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: class.as_ptr(),
                };
                if RegisterClassW(&window_class) == 0 {
                    let error = GetLastError();
                    assert_eq!(
                        error, ERROR_CLASS_ALREADY_EXISTS,
                        "hidden test window class registration failed (win32 error {error})"
                    );
                }
                let hwnd = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    std::ptr::null(),
                    WS_POPUP, // never WS_VISIBLE: the window stays hidden by construction
                    0,
                    0,
                    8,
                    8,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                assert!(!hwnd.is_null(), "the hidden test window must be creatable");
                Self { hwnd }
            }
        }

        pub(super) fn hwnd(&self) -> usize {
            self.hwnd as usize
        }
    }

    impl Drop for HiddenTestWindow {
        fn drop(&mut self) {
            // SAFETY: the window was created by this test on this thread.
            unsafe { DestroyWindow(self.hwnd) };
        }
    }
}

use hidden_window::HiddenTestWindow;

/// Engine with the composition pipeline attached to `hwnd` (composition is
/// created on the render thread during `create_with_window`).
fn engine_with_window(hwnd: usize) -> Arc<Engine> {
    let (sink, _collected) = collector();
    let engine = Engine::create_with_window(sink, Some(hwnd))
        .expect("engine must create with the composition pipeline");
    engine
        .send_command(&command(&["set_property", "volume", "0"]))
        .expect("volume must be settable");
    engine
}

fn wait_for_presented(
    surface: &RenderSurface,
    minimum: u64,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let presented = surface.presented_frame_count();
        if presented >= minimum {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "only {presented} frame(s) presented in {timeout:?}; expected >= {minimum}"
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn time_pos(engine: &Engine) -> f64 {
    engine
        .get_property("time-pos")
        .ok()
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0)
}

// --- S3-02 ------------------------------------------------------------------

/// The NV_DX_interop2 capability on THIS machine: opening the interop device
/// during engine creation must succeed on the target NVIDIA GPU. A missing
/// extension skips loudly (non-NVIDIA is a documented non-goal of S3); any
/// other creation failure is a real failure.
#[test]
fn s3_02_interop_capability_is_available_on_this_machine() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let window = HiddenTestWindow::create();
    let (sink, _collected) = collector();
    match Engine::create_with_window(sink, Some(window.hwnd())) {
        Ok(engine) => {
            assert!(engine.render_ready(), "S3-02: the render context must be ready");
            engine.destroy(true).expect("cleanup destroy");
            eprintln!("S3-02: NV_DX_interop2 device opened, composition pipeline ready");
        }
        Err(create_error) => {
            let text = create_error.to_string();
            if text.contains("NV_DX_interop2 unavailable") {
                eprintln!("SKIP: S3-02: this machine has no NV_DX_interop2: {text}");
                return;
            }
            panic!("S3-02: composition engine creation failed: {text}");
        }
    }
}

// --- S3-03 ------------------------------------------------------------------

/// Frame flow through the whole bridge on a hidden window: DComp target
/// (topmost=FALSE) + surface 640x360, visible content, real HEVC10 media;
/// at least 5 GPU-presented frames land while the render thread keeps
/// producing frames (presented <= rendered).
#[test]
fn s3_03_presents_frames_through_dcomp_while_visible() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let Some(media) = media_or_skip(FIXTURE_HEVC10) else {
        return;
    };
    let window = HiddenTestWindow::create();
    let engine = engine_with_window(window.hwnd());
    let surface = engine.render_surface().expect("created during setup").clone();

    surface.set_rect(0, 0, 640, 360).expect("S3-03: set_rect must be accepted");
    surface.set_visible(true).expect("S3-03: set_visible must be accepted");
    load(&engine, &media);

    if let Err(short) = wait_for_presented(&surface, 5, Duration::from_secs(15)) {
        panic!("S3-03: {short} after loading {}", media.display());
    }
    let rendered = engine.render_frame_count();
    let presented = surface.presented_frame_count();
    assert!(
        rendered >= presented,
        "S3-03: rendered ({rendered}) must be >= presented ({presented})"
    );
    eprintln!("S3-03: presented={presented} rendered={rendered}");
    engine.destroy(true).expect("cleanup destroy");
}

// --- S3-04 ------------------------------------------------------------------

/// Hiding must stop presentation WITHOUT stalling playback: presented frames
/// freeze, the render thread keeps producing timed frames (SKIP_RENDERING),
/// time-pos keeps advancing; showing again resumes presentation.
#[test]
fn s3_04_hidden_freezes_presentation_but_not_playback() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let Some(media) = media_or_skip(FIXTURE_HEVC10) else {
        return;
    };
    let window = HiddenTestWindow::create();
    let engine = engine_with_window(window.hwnd());
    let surface = engine.render_surface().expect("created during setup").clone();
    surface.set_rect(0, 0, 640, 360).expect("S3-04: set_rect");
    surface.set_visible(true).expect("S3-04: set_visible(true)");
    load(&engine, &media);
    if let Err(short) = wait_for_presented(&surface, 3, Duration::from_secs(15)) {
        panic!("S3-04: {short} before hiding");
    }

    surface.set_visible(false).expect("S3-04: set_visible(false)");
    std::thread::sleep(Duration::from_millis(400)); // let in-flight presents land
    let presented_hidden = surface.presented_frame_count();
    let rendered_hidden = engine.render_frame_count();
    let position_hidden = time_pos(&engine);
    std::thread::sleep(Duration::from_millis(1200));

    let presented_after = surface.presented_frame_count();
    let rendered_after = engine.render_frame_count();
    let position_after = time_pos(&engine);
    assert_eq!(
        presented_after, presented_hidden,
        "S3-04: hidden content must stop presenting ({presented_hidden} -> {presented_after})"
    );
    assert!(
        rendered_after > rendered_hidden,
        "S3-04: the render thread must keep producing timed frames while hidden ({rendered_hidden} -> {rendered_after})"
    );
    assert!(
        position_after > position_hidden,
        "S3-04: playback must keep advancing while hidden ({position_hidden} -> {position_after})"
    );

    surface.set_visible(true).expect("S3-04: set_visible(true) again");
    if let Err(short) = wait_for_presented(&surface, presented_after + 2, Duration::from_secs(10)) {
        panic!("S3-04: presentation must resume after showing again: {short}");
    }
    eprintln!(
        "S3-04: presented {presented_hidden} (hidden) -> resumed; rendered {rendered_hidden} -> {rendered_after}; time-pos {position_hidden:.2} -> {position_after:.2}"
    );
    engine.destroy(true).expect("cleanup destroy");
}

// --- S3-05 ------------------------------------------------------------------

/// Resizing the rect while presenting: the GL FBO, the interop registration
/// and the DComp surface are all recreated; presentation continues and the
/// FBO still holds a non-black frame afterwards.
#[test]
fn s3_05_resize_recreates_surface_and_keeps_presenting() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let Some(media) = media_or_skip(FIXTURE_HEVC10) else {
        return;
    };
    let window = HiddenTestWindow::create();
    let engine = engine_with_window(window.hwnd());
    let surface = engine.render_surface().expect("created during setup").clone();
    surface.set_rect(0, 0, 640, 360).expect("S3-05: set_rect");
    surface.set_visible(true).expect("S3-05: set_visible(true)");
    load(&engine, &media);
    if let Err(short) = wait_for_presented(&surface, 3, Duration::from_secs(15)) {
        panic!("S3-05: {short} before the resize");
    }

    let before = surface.presented_frame_count();
    surface.set_rect(0, 0, 1280, 720).expect("S3-05: resize must be accepted");
    if let Err(short) = wait_for_presented(&surface, before + 3, Duration::from_secs(10)) {
        panic!("S3-05: presentation must continue after the resize: {short}");
    }
    assert!(
        wait_until(Duration::from_secs(5), || {
            surface.present_surface_size() == Some((1280, 720))
        }),
        "S3-05: the DComp surface must be recreated at 1280x720, got {:?}",
        surface.present_surface_size()
    );
    let sample = surface
        .sample_pixels(Duration::from_secs(5))
        .expect("S3-05: the FBO readback must succeed after the resize");
    assert_eq!((sample.width, sample.height), (1280, 720));
    let peak = peak_channel(&sample);
    assert!(
        peak > NON_BLACK_CHANNEL_THRESHOLD,
        "S3-05: the frame after the resize must be non-black, peak={peak}"
    );
    eprintln!("S3-05: presented {before} -> {}; peak={peak}", surface.presented_frame_count());
    engine.destroy(true).expect("cleanup destroy");
}

// --- S3-06 ------------------------------------------------------------------

/// The visual rect must be the physical rect converted to DIP with the
/// window's scale (`GetDpiForWindow/96`), no rounding. This machine runs at
/// 100% (scale 1.0), so the assertion is written scale-aware to also pin the
/// formula; the scale != 1 path carries a documented debt (no scaled monitor
/// available).
#[test]
fn s3_06_visual_rect_is_dip_correct_for_this_monitor_scale() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let window = HiddenTestWindow::create();
    let engine = engine_with_window(window.hwnd());
    let surface = engine.render_surface().expect("created during setup").clone();

    surface.set_rect(100, 50, 640, 360).expect("S3-06: set_rect");
    surface.set_visible(true).expect("S3-06: set_visible(true)");
    assert!(
        wait_until(Duration::from_secs(5), || surface.last_visual_rect_dip().is_some()),
        "S3-06: the render thread must report the converted rect"
    );
    let (x, y, w, h) = surface.last_visual_rect_dip().expect("checked above");
    let scale = surface.present_scale().expect("S3-06: the scale must be reported");
    assert!(scale > 0.0, "S3-06: DPI scale must be positive, got {scale}");
    let close = |actual: f32, expected: f32| (actual - expected).abs() < 0.01;
    assert!(close(x, 100.0 / scale), "S3-06: x DIP {x} != {}", 100.0 / scale);
    assert!(close(y, 50.0 / scale), "S3-06: y DIP {y} != {}", 50.0 / scale);
    assert!(close(w, 640.0 / scale), "S3-06: w DIP {w} != {}", 640.0 / scale);
    assert!(close(h, 360.0 / scale), "S3-06: h DIP {h} != {}", 360.0 / scale);
    eprintln!(
        "S3-06: scale={scale} (this machine is expected at 100%; scale != 1 is a documented debt) -> rect_dip=({x}, {y}, {w}, {h})"
    );
    engine.destroy(true).expect("cleanup destroy");
}

// --- S3-07 ------------------------------------------------------------------

/// Teardown while presenting joins the render thread promptly (interop
/// unregister + DComp release included), and a second engine on the same
/// window creates and presents again (no COM/GL residue).
#[test]
fn s3_07_teardown_joins_quickly_and_recreate_presents_again() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let Some(media) = media_or_skip(FIXTURE_HEVC10) else {
        return;
    };
    let window = HiddenTestWindow::create();

    for cycle in 0..2 {
        let engine = engine_with_window(window.hwnd());
        let surface = engine.render_surface().expect("created during setup").clone();
        surface.set_rect(0, 0, 640, 360).expect("S3-07: set_rect");
        surface.set_visible(true).expect("S3-07: set_visible(true)");
        load(&engine, &media);
        if let Err(short) = wait_for_presented(&surface, 2, Duration::from_secs(15)) {
            panic!("S3-07 cycle {cycle}: {short}");
        }
        let started = Instant::now();
        engine.destroy(true).expect("S3-07: destroy while presenting must succeed");
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(5),
            "S3-07 cycle {cycle}: destroy took {elapsed:?} (>= 5s)"
        );
        assert_eq!(
            wait_for_named_threads(RENDER_THREAD_NAME, 0, Duration::from_secs(3)),
            0,
            "S3-07 cycle {cycle}: the render thread must be gone after destroy"
        );
        eprintln!("S3-07 cycle {cycle}: destroy while presenting took {elapsed:?}");
    }
}

// --- S3-08 ------------------------------------------------------------------

/// The composition lifecycle must not add a single VISIBLE window: the
/// visible top-level count stays at its baseline through create, presentation,
/// resize and destroy (the hidden test window and anchor only move the hidden
/// count, which is logged).
#[test]
fn s3_08_no_visible_window_across_the_composition_lifecycle() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let Some(media) = media_or_skip(FIXTURE_HEVC10) else {
        return;
    };
    let (visible_before, hidden_before) = window_visibility_counts();
    let window = HiddenTestWindow::create();
    let (visible_window, hidden_window) = window_visibility_counts();
    assert_eq!(
        visible_window, visible_before,
        "S3-08: the hidden test window must never be visible"
    );

    let engine = engine_with_window(window.hwnd());
    let surface = engine.render_surface().expect("created during setup").clone();
    surface.set_rect(0, 0, 640, 360).expect("S3-08: set_rect");
    surface.set_visible(true).expect("S3-08: set_visible(true)");
    load(&engine, &media);
    if let Err(short) = wait_for_presented(&surface, 3, Duration::from_secs(15)) {
        panic!("S3-08: {short}");
    }
    surface.set_rect(0, 0, 1280, 720).expect("S3-08: resize");
    if let Err(short) = wait_for_presented(&surface, 5, Duration::from_secs(10)) {
        panic!("S3-08: presentation after resize: {short}");
    }
    let (visible_presenting, hidden_presenting) = window_visibility_counts();
    assert_eq!(
        visible_presenting, visible_before,
        "S3-08: presenting must not show a window (visible {visible_before} -> {visible_presenting})"
    );

    engine.destroy(true).expect("cleanup destroy");
    let (visible_after, hidden_after) = window_visibility_counts();
    assert_eq!(
        visible_after, visible_before,
        "S3-08: destroy must not leave a visible window (visible {visible_before} -> {visible_after})"
    );
    eprintln!(
        "S3-08: visible stable at {visible_before}; hidden {hidden_before} -> {hidden_window} (test window) -> {hidden_presenting} (presenting) -> {hidden_after} (destroyed)"
    );
}

// --- S3-09 / S3-10: repaint after a size rebuild while no frames flow --------

/// Two equal presented-frame readings 400 ms apart mean no frame is in flight
/// (playback is really paused); returns the stable count. Panics on timeout so
/// a pause that never sticks fails loudly instead of faking the assertions.
fn wait_for_presentation_stall(surface: &RenderSurface, timeout: Duration) -> u64 {
    let deadline = Instant::now() + timeout;
    loop {
        let first = surface.presented_frame_count();
        std::thread::sleep(Duration::from_millis(400));
        let second = surface.presented_frame_count();
        if first == second {
            return second;
        }
        assert!(
            Instant::now() < deadline,
            "presented frames never stalled ({first} -> {second} within 400ms); is playback paused?"
        );
    }
}

/// Pause playback and wait until the presented counter provably stalls.
fn pause_and_stall(engine: &Engine, surface: &RenderSurface) -> u64 {
    engine
        .send_command(&command(&["set_property", "pause", "yes"]))
        .expect("pause must be accepted");
    assert!(
        wait_until(Duration::from_secs(5), || {
            engine.get_property("pause").ok() == Some(serde_json::Value::Bool(true))
        }),
        "the pause property must read back true"
    );
    wait_for_presentation_stall(surface, Duration::from_secs(10))
}

/// The paused-resize bug: with playback paused, a size change rebuilds the GL
/// FBO, the interop registration and the DComp surface (content empty) while
/// no MPV_RENDER_UPDATE_FRAME flag will ever arrive, so nothing repaints the
/// new surface and the video area stays black until playback resumes. After
/// the resize the pipeline must run one repaint present even without a new
/// frame (render.h: the renderer reconfigures on a target-size change and
/// redraws the previous frame when no new frame is available).
#[test]
fn s3_09_resize_while_paused_repaints_instead_of_going_black() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let Some(media) = media_or_skip(FIXTURE_HEVC10) else {
        return;
    };
    let window = HiddenTestWindow::create();
    let engine = engine_with_window(window.hwnd());
    let surface = engine.render_surface().expect("created during setup").clone();

    surface.set_rect(0, 0, 640, 360).expect("S3-09: set_rect");
    surface.set_visible(true).expect("S3-09: set_visible(true)");
    load(&engine, &media);
    if let Err(short) = wait_for_presented(&surface, 3, Duration::from_secs(15)) {
        panic!("S3-09: {short} before pausing");
    }
    let paused_at = pause_and_stall(&engine, &surface);

    surface.set_rect(0, 0, 1280, 720).expect("S3-09: the resize must be accepted");
    if let Err(short) = wait_for_presented(&surface, paused_at + 1, Duration::from_secs(3)) {
        panic!("S3-09: the rebuild must trigger a repaint even while paused: {short}");
    }
    let sample = surface
        .sample_pixels(Duration::from_secs(5))
        .expect("S3-09: the FBO readback must succeed after the resize");
    assert_eq!(
        (sample.width, sample.height),
        (1280, 720),
        "S3-09: the FBO must be reallocated to the new size"
    );
    let peak = peak_channel(&sample);
    assert!(
        peak > NON_BLACK_CHANNEL_THRESHOLD,
        "S3-09: the repainted frozen frame must be non-black, peak={peak}"
    );
    eprintln!("S3-09: paused at {paused_at} presents; repainted after resize; peak={peak}");
    engine.destroy(true).expect("cleanup destroy");
}

/// Same root cause through the hidden path: hiding stops presentation but a
/// resize while hidden still rebuilds the empty surface, and showing again
/// must repaint it immediately even though playback is paused (no frame flag
/// will arrive to do it).
#[test]
fn s3_10_resize_while_hidden_repaints_when_shown_again() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let Some(media) = media_or_skip(FIXTURE_HEVC10) else {
        return;
    };
    let window = HiddenTestWindow::create();
    let engine = engine_with_window(window.hwnd());
    let surface = engine.render_surface().expect("created during setup").clone();

    surface.set_rect(0, 0, 640, 360).expect("S3-10: set_rect");
    surface.set_visible(true).expect("S3-10: set_visible(true)");
    load(&engine, &media);
    if let Err(short) = wait_for_presented(&surface, 3, Duration::from_secs(15)) {
        panic!("S3-10: {short} before pausing");
    }
    let paused_at = pause_and_stall(&engine, &surface);

    surface.set_visible(false).expect("S3-10: hide");
    surface.set_rect(0, 0, 1280, 720).expect("S3-10: resize while hidden");
    surface.set_visible(true).expect("S3-10: show again");
    if let Err(short) = wait_for_presented(&surface, paused_at + 1, Duration::from_secs(3)) {
        panic!("S3-10: showing again after a hidden resize must repaint: {short}");
    }
    let sample = surface
        .sample_pixels(Duration::from_secs(5))
        .expect("S3-10: the FBO readback must succeed after the resize");
    assert_eq!(
        (sample.width, sample.height),
        (1280, 720),
        "S3-10: the FBO must be reallocated to the new size"
    );
    let peak = peak_channel(&sample);
    assert!(
        peak > NON_BLACK_CHANNEL_THRESHOLD,
        "S3-10: the repainted frozen frame must be non-black, peak={peak}"
    );
    eprintln!("S3-10: paused at {paused_at} presents; repainted on show; peak={peak}");
    engine.destroy(true).expect("cleanup destroy");
}

// ---------------------------------------------------------------------------
// MIGRATION-ONLY (S7): the frame-dump BMP writer.
//
// Pure byte-level tests: no engine, no GL context, no window. The point is
// that Main Agent can open these files for real, so "the header parses and the
// pixels round-trip" has to hold without a viewer in the loop.
// ---------------------------------------------------------------------------

/// A 3x2 RGBA image with six distinct colours. Width 3 is deliberate: a
/// 24-bit row is 9 bytes, which is not a multiple of 4, so every row needs
/// padding and a test that ignores the stride would pass anyway.
fn sample_rgba() -> (u32, u32, Vec<u8>) {
    let rgba = vec![
        // GL row 0 — the BOTTOM row of the rendered frame.
        10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, //
        // GL row 1 — the top row.
        11, 21, 31, 255, 41, 51, 61, 255, 71, 81, 91, 255,
    ];
    (3, 2, rgba)
}

fn le_u16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn le_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn le_i32(bytes: &[u8], at: usize) -> i32 {
    i32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// The header fields a decoder actually consults, parsed back with `std`.
struct ParsedBmp<'a> {
    file_size: u32,
    pixel_offset: u32,
    header_size: u32,
    width: i32,
    height: i32,
    planes: u16,
    bit_count: u16,
    compression: u32,
    image_size: u32,
    stride: usize,
    pixels: &'a [u8],
}

fn parse_bmp(bytes: &[u8]) -> ParsedBmp<'_> {
    assert_eq!(&bytes[0..2], b"BM", "BMP files must start with the BM magic");
    let pixel_offset = le_u32(bytes, 10);
    assert_eq!(pixel_offset as usize, 54, "bfOffBits must point just past both headers");
    let width = le_i32(bytes, 18);
    let height = le_i32(bytes, 22);
    ParsedBmp {
        file_size: le_u32(bytes, 2),
        pixel_offset,
        header_size: le_u32(bytes, 14),
        width,
        height,
        planes: le_u16(bytes, 26),
        bit_count: le_u16(bytes, 28),
        compression: le_u32(bytes, 30),
        image_size: le_u32(bytes, 34),
        // Same rule the writer applies: pad each row up to 4 bytes.
        stride: (width as usize * 3).div_ceil(4) * 4,
        pixels: &bytes[pixel_offset as usize..],
    }
}

/// One temp file per test, removed afterwards. `TempPath`-style by hand so the
/// crate gains no dev-dependency for three short tests.
struct TempBmp(PathBuf);

impl TempBmp {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "drplay-frame-dump-{tag}-{}.bmp",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        Self(path)
    }
}

impl Drop for TempBmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// The end-to-end contract: write a real file, read it back with `std`, and
/// prove the header and every pixel byte survived the round trip. Anything
/// Main Agent opens in a viewer depends on exactly this.
#[test]
fn a_written_bmp_parses_back_with_a_valid_header_and_the_same_pixels() {
    let (width, height, rgba) = sample_rgba();
    let file = TempBmp::new("roundtrip");
    let (stats, written) =
        write_bmp24(&file.0, width, height, &rgba).expect("the BMP must be written");

    let bytes = std::fs::read(&file.0).expect("the BMP must be readable back");
    assert_eq!(bytes.len(), written, "the reported size must be the file size");

    let bmp = parse_bmp(&bytes);
    assert_eq!(bmp.header_size, 40, "a BITMAPINFOHEADER is 40 bytes");
    assert_eq!(bmp.width, 3);
    // Positive height is what selects bottom-up storage and is what makes the
    // GL rows land in the right order; a negative height here would flip the
    // picture in every viewer.
    assert_eq!(bmp.height, 2, "height must be positive (bottom-up, matching glReadPixels)");
    assert_eq!(bmp.planes, 1);
    assert_eq!(bmp.bit_count, 24, "the diagnostic writes uncompressed 24-bit");
    assert_eq!(bmp.compression, 0, "BI_RGB: no compression");
    assert_eq!(bmp.image_size, bmp.stride as u32 * 2);
    assert_eq!(bmp.file_size as usize, bytes.len(), "bfSize must match the real length");
    assert_eq!(bmp.pixel_offset as usize, 54);

    // Row padding is 3 bytes here (9 -> 12), and must be zero.
    assert_eq!(bmp.stride, 12, "a 3-pixel 24-bit row pads from 9 to 12 bytes");
    assert_eq!(
        bmp.pixels.len(),
        bmp.stride * 2,
        "the pixel array is exactly stride * height"
    );

    for row in 0..height as usize {
        let line = &bmp.pixels[row * bmp.stride..row * bmp.stride + bmp.stride];
        for column in 0..width as usize {
            // GL row order == BMP bottom-up storage order: row 0 is the
            // bottom of the image in BOTH, so NO flip is expected here.
            let source = row * width as usize * 4 + column * 4;
            assert_eq!(
                &line[column * 3..column * 3 + 3],
                &[rgba[source + 2], rgba[source + 1], rgba[source]],
                "row {row} column {column}: 24-bit BMP stores BGR, and the rows must not be flipped"
            );
        }
        assert_eq!(
            &line[width as usize * 3..],
            &[0, 0, 0],
            "row {row}: the alignment padding must be zeroed"
        );
    }

    // The logged statistics must describe the pixels that were actually
    // written, so the black-vs-content conclusion in the log is trustworthy.
    assert_eq!(stats[0].min, 10);
    assert_eq!(stats[0].max, 71);
    assert_eq!(stats[1].min, 20);
    assert_eq!(stats[1].max, 81);
    assert_eq!(stats[2].min, 30);
    assert_eq!(stats[2].max, 91);
    assert_eq!(stats[3].min, 255, "this fixture is fully opaque");
    assert_eq!(stats[3].max, 255);
    // R mean = (10+40+70+11+41+71)/6 = 243/6 = 40.5
    assert!((stats[0].avg - 40.5).abs() < 0.001, "R mean was {}", stats[0].avg);
}

/// The conclusion the whole diagnostic exists for: a frame whose every RGB
/// sample is zero is black, and the log must establish that through min AND
/// max — a single sampled pixel could never do it.
///
/// The fixture is OPAQUE black (0,0,0,255), not all-zero bytes, because that
/// is what a real readback of a black picture looks like and it is the harder
/// case: the colour channels must still measure black while alpha sits at its
/// maximum, so a diagnostic that mixed the channels together would show
/// `max=255` and wrongly read the frame as "has content".
#[test]
fn an_opaque_black_readback_measures_as_a_black_frame_in_every_colour_channel() {
    let (width, height) = (4u32, 2u32);
    let rgba: Vec<u8> = (0..width * height)
        .flat_map(|_| [0u8, 0, 0, 255])
        .collect();
    let stats = channel_stats(&rgba);
    for (index, stats) in stats.iter().take(3).enumerate() {
        assert_eq!(
            (stats.min, stats.max, stats.avg),
            (0, 0, 0.0),
            "colour channel {index} must measure black"
        );
    }
    assert_eq!(
        (stats[3].min, stats[3].max),
        (255, 255),
        "alpha is fully opaque and must not be mistaken for colour"
    );

    // And the same content still encodes to a well-formed file.
    let file = TempBmp::new("black");
    write_bmp24(&file.0, width, height, &rgba).expect("a black frame must still be written");
    let bytes = std::fs::read(&file.0).expect("readable");
    let bmp = parse_bmp(&bytes);
    assert_eq!((bmp.width, bmp.height), (4, 2));
    assert!(bmp.pixels.chunks_exact(3).all(|pixel| pixel == [0, 0, 0]));
}

/// Statistics must describe the WHOLE frame, not a corner: one bright pixel in
/// a dark frame is exactly the case a spot check would get wrong.
#[test]
fn channel_statistics_span_the_whole_frame_not_just_its_first_pixel() {
    let mut rgba = vec![0u8; 4 * 2 * 4];
    rgba[0] = 255; // a single lit pixel, in the first pixel of GL row 0
    let stats = channel_stats(&rgba);
    assert_eq!(stats[0].max, 255, "the lit pixel must reach the maximum");
    assert_eq!(stats[0].min, 0, "and the dark pixels must still reach the minimum");
    // 255 / 8 pixels, not 255 / 1.
    assert!((stats[0].avg - 31.875).abs() < 0.001, "R mean was {}", stats[0].avg);
    assert_eq!(stats[1].max, 0, "no other channel was lit");
}

#[test]
fn a_buffer_that_does_not_match_its_dimensions_is_refused() {
    assert!(encode_bmp24(0, 2, &[]).is_err(), "a zero width has no meaningful BMP");
    assert!(encode_bmp24(2, 0, &[]).is_err(), "a zero height has no meaningful BMP");
    assert!(
        encode_bmp24(2, 2, &[0u8; 15]).is_err(),
        "a short readback must be refused rather than padded into garbage"
    );
    assert!(encode_bmp24(2, 2, &[0u8; 17]).is_err(), "so must a long one");
}

/// Successive dumps must not overwrite each other: "three samples" that are
/// one sample written three times would prove nothing about a pipeline that
/// recovers.
#[test]
fn successive_dumps_get_their_own_files_instead_of_overwriting() {
    let dump = FrameDump { path: PathBuf::from(r"C:\diag\frame.bmp"), at: 30, done: 0, next_at: None };
    assert_eq!(dump.path_for(0), PathBuf::from(r"C:\diag\frame.bmp"), "the first dump uses the configured path verbatim");
    assert_eq!(dump.path_for(1), PathBuf::from(r"C:\diag\frame-1.bmp"));
    assert_eq!(dump.path_for(2), PathBuf::from(r"C:\diag\frame-2.bmp"));
}

/// The throttle has to actually throttle, and has to disarm itself once the
/// cap is reached — otherwise a long session keeps writing files.
#[test]
fn the_dump_gate_waits_for_the_threshold_then_spaces_the_samples_out() {
    let mut dump = FrameDump { path: PathBuf::from("frame.bmp"), at: 30, done: 0, next_at: None };
    assert!(!dump.is_due(29), "nothing before the configured frame count");
    assert!(dump.is_due(30), "the threshold frame is due immediately");
    assert!(dump.is_due(31), "and the next frame is still due: no wait armed yet");

    dump.record_attempt(0);
    assert_eq!(dump.done, 1);
    assert!(
        !dump.is_due(31),
        "a sample just taken must not immediately allow another"
    );

    // Reaching the cap disarms the diagnostic regardless of the frame count.
    for index in 1..FRAME_DUMP_MAX {
        dump.record_attempt(index);
    }
    assert_eq!(dump.done, FRAME_DUMP_MAX);
    assert!(
        !dump.is_due(10_000),
        "the dump must stop once it has written {FRAME_DUMP_MAX} files"
    );
}
