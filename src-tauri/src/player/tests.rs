//! Integration tests for the in-process libmpv engine (ENGINE-001/006/007/
//! 021/024 + playback smoke + shutdown semantics). These need the real DLL
//! (`src-tauri/bin/libmpv-2.dll`); when it is absent they skip with a loud
//! message instead of failing. Wire-mapping unit tests live with their
//! modules (events.rs, engine.rs, ffi.rs, options.rs).

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::engine::Engine;
use super::ffi;
use super::{ensure_spawned, EngineSlot};
use crate::mpv::IpcMessage;

type Collected = Arc<Mutex<Vec<(IpcMessage, u64, u64)>>>;

/// Engine tests share one process: serialize them so thread counting, process
/// scanning and audio startup stay deterministic (cargo test is parallel by
/// default). The S2 render tests (player::render::tests) take the same lock.
static ENGINE_TEST_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn serial() -> std::sync::MutexGuard<'static, ()> {
    ENGINE_TEST_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Skip (loudly) when the DLL is missing; the S1 environment ships it.
pub(crate) fn engine_available() -> bool {
    match ffi::resolve_libmpv_dll() {
        Ok(_) => true,
        Err(resolve_error) => {
            eprintln!("SKIP: libmpv DLL unavailable, integration test not run: {resolve_error}");
            false
        }
    }
}

pub(crate) fn collector() -> (crate::mpv::EventSink, Collected) {
    let collected: Collected = Arc::new(Mutex::new(Vec::new()));
    let sink: crate::mpv::EventSink = {
        let collected = Arc::clone(&collected);
        Arc::new(move |message, epoch, conn| {
            collected.lock().unwrap().push((message, epoch, conn))
        })
    };
    (sink, collected)
}

pub(crate) fn command(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_string()).collect()
}

pub(crate) fn wait_for(
    collected: &Collected,
    timeout: Duration,
    predicate: impl Fn(&(IpcMessage, u64, u64)) -> bool,
) -> Option<(IpcMessage, u64, u64)> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(found) =
            collected.lock().unwrap().iter().find(|entry| predicate(entry)).cloned()
        {
            return Some(found);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn is_event(message: &IpcMessage, name: &str) -> bool {
    matches!(message, IpcMessage::MpvEvent { event, .. } if event == name)
}

fn end_file_fields(message: &IpcMessage) -> Option<(Option<String>, Option<String>)> {
    match message {
        IpcMessage::MpvEvent { event, reason, error } if event == "end-file" => {
            Some((reason.clone(), error.clone()))
        }
        _ => None,
    }
}

fn property_number(message: &IpcMessage, property: &str) -> Option<f64> {
    match message {
        IpcMessage::PropertyChange { name, data } if name == property => data.as_f64(),
        _ => None,
    }
}

fn close_event_count(collected: &Collected) -> usize {
    collected
        .lock()
        .unwrap()
        .iter()
        .filter(|(message, _, _)| matches!(message, IpcMessage::ConnectionClosed { .. }))
        .count()
}

/// Threads of this process whose thread description equals `name` (the
/// engine's `libmpv-events` or the render slice's `libmpv-render`). Counting
/// OUR named threads is immune to the test harness's own threads, unlike a
/// whole-process count (which is polluted by libtest parallelism).
pub(crate) fn named_thread_count(name: &str) -> u32 {
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD,
    };
    use windows_sys::Win32::System::Threading::{
        GetThreadDescription, OpenThread, THREAD_QUERY_LIMITED_INFORMATION,
    };
    let mut count = 0u32;
    // SAFETY: plain read-only snapshot walk; every handle is closed and the
    // description buffer is freed on the path that allocated it.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return 0;
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let owner = std::process::id();
        if Thread32First(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32OwnerProcessID == owner {
                    let thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        let mut description: *mut u16 = std::ptr::null_mut();
                        if GetThreadDescription(thread, &mut description) >= 0
                            && !description.is_null()
                        {
                            let mut length = 0usize;
                            while *description.add(length) != 0 {
                                length += 1;
                            }
                            let description_text = String::from_utf16_lossy(
                                std::slice::from_raw_parts(description, length),
                            );
                            if description_text == name {
                                count += 1;
                            }
                            LocalFree(description as _);
                        }
                        CloseHandle(thread);
                    }
                }
                if Thread32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    count
}

/// Poll the named-thread count until it reaches `expected` (thread naming is
/// applied by the new thread itself, so a just-spawned thread may briefly
/// still be nameless).
pub(crate) fn wait_for_named_threads(name: &str, expected: u32, timeout: Duration) -> u32 {
    let deadline = Instant::now() + timeout;
    loop {
        let count = named_thread_count(name);
        if count == expected || Instant::now() >= deadline {
            return count;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

static WINDOW_SCAN_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static WINDOW_VISIBLE_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static WINDOW_HIDDEN_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

unsafe extern "system" fn count_owned_window(
    hwnd: *mut std::ffi::c_void,
    param: isize,
) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowThreadProcessId, IsWindowVisible,
    };
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == WINDOW_SCAN_PID.load(std::sync::atomic::Ordering::SeqCst) {
        if IsWindowVisible(hwnd) != 0 {
            WINDOW_VISIBLE_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        } else {
            WINDOW_HIDDEN_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _ = param;
    1 // continue enumeration
}

/// `(visible, hidden)` top-level windows owned by this process. The S2
/// no-window invariant: the VISIBLE count must never grow while the engine
/// runs (the render anchor window is deliberately HIDDEN and is counted in
/// the second number for transparency).
pub(crate) fn window_visibility_counts() -> (u32, u32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::EnumWindows;
    WINDOW_SCAN_PID.store(std::process::id(), std::sync::atomic::Ordering::SeqCst);
    WINDOW_VISIBLE_COUNT.store(0, std::sync::atomic::Ordering::SeqCst);
    WINDOW_HIDDEN_COUNT.store(0, std::sync::atomic::Ordering::SeqCst);
    // SAFETY: the callback only reads its arguments and bumps statics.
    unsafe { EnumWindows(Some(count_owned_window), 0) };
    (
        WINDOW_VISIBLE_COUNT.load(std::sync::atomic::Ordering::SeqCst),
        WINDOW_HIDDEN_COUNT.load(std::sync::atomic::Ordering::SeqCst),
    )
}

/// PIDs of running `mpv*` processes (the sidecar would be `mpv.exe`).
fn mpv_process_ids() -> BTreeSet<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut found = BTreeSet::new();
    // SAFETY: read-only snapshot walk, dwSize set as required.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return found;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let name_bytes =
                    entry.szExeFile.split(|unit| *unit == 0).next().unwrap_or(&[]);
                let name = String::from_utf16_lossy(name_bytes).to_ascii_lowercase();
                if name.starts_with("mpv") {
                    found.insert(entry.th32ProcessID);
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    found
}

/// 3 seconds of 440 Hz PCM16 mono — long enough that the pause lands before
/// eof, short enough to keep the smoke fast (the engine is stopped early).
const TEST_WAV_SECONDS: u32 = 3;

pub(crate) fn write_test_wav(path: &Path) {
    let sample_rate: u32 = 44_100;
    let sample_count = sample_rate * TEST_WAV_SECONDS;
    let mut samples: Vec<u8> = Vec::with_capacity((sample_count * 2) as usize);
    for index in 0..sample_count {
        let t = f64::from(index) / f64::from(sample_rate);
        let sample = (t * 440.0 * std::f64::consts::TAU).sin() * 0.2;
        let pcm = (sample * f64::from(i16::MAX)) as i16;
        samples.extend_from_slice(&pcm.to_le_bytes());
    }
    let data_len = samples.len() as u32;
    let mut file: Vec<u8> = Vec::with_capacity(44 + samples.len());
    file.extend_from_slice(b"RIFF");
    file.extend_from_slice(&(36 + data_len).to_le_bytes());
    file.extend_from_slice(b"WAVE");
    file.extend_from_slice(b"fmt ");
    file.extend_from_slice(&16u32.to_le_bytes()); // PCM header size
    file.extend_from_slice(&1u16.to_le_bytes()); // format = PCM
    file.extend_from_slice(&1u16.to_le_bytes()); // mono
    file.extend_from_slice(&sample_rate.to_le_bytes());
    file.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    file.extend_from_slice(&2u16.to_le_bytes()); // block align
    file.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    file.extend_from_slice(b"data");
    file.extend_from_slice(&data_len.to_le_bytes());
    file.extend_from_slice(&samples);
    std::fs::write(path, file).expect("test WAV fixture must be writable");
}

// --- ENGINE-001 -------------------------------------------------------------

/// The adopted DLL loads, resolves every symbol and reports client API 2.5
/// (131077); the minimum accepted is 2.1 (131073).
#[test]
fn engine_001_dll_loads_and_reports_the_expected_api_version() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let dll = ffi::resolve_libmpv_dll().expect("resolved above");
    let api = ffi::Api::load(&dll).expect("the DLL must load and resolve every symbol");
    // SAFETY: plain extern getter, no preconditions.
    let version = unsafe { (api.client_api_version)() };
    eprintln!(
        "ENGINE-001: libmpv client API version = {version} (expected {})",
        ffi::API_VERSION_EXPECTED
    );
    assert_eq!(version, ffi::API_VERSION_EXPECTED, "the committed DLL reports client API 2.5");
    assert!(version >= ffi::API_VERSION_MIN);
}

// --- ENGINE-006 / 007 -------------------------------------------------------

/// Create -> destroy -> create again, twice, with no event-thread
/// accumulation: exactly one named event thread exists while an engine is
/// alive, and destroy joins it before returning.
#[test]
fn engine_006_007_create_destroy_recreate_without_thread_leak() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let event_thread = super::engine::EVENT_THREAD_NAME;
    assert_eq!(
        wait_for_named_threads(event_thread, 0, Duration::from_secs(1)),
        0,
        "no engine event thread may exist before the first create"
    );

    for cycle in 0..2 {
        let (sink, _collected) = collector();
        let engine = Engine::create(sink).expect("ENGINE-006/007: recreate must succeed");
        assert!(engine.is_alive());
        assert_eq!(
            wait_for_named_threads(event_thread, 1, Duration::from_secs(2)),
            1,
            "cycle {cycle}: a live engine owns exactly one event thread"
        );
        engine.destroy(true).expect("destroy must succeed");
        assert!(!engine.is_alive(), "a destroyed engine must reject further use");
        assert_eq!(
            wait_for_named_threads(event_thread, 0, Duration::from_secs(3)),
            0,
            "cycle {cycle}: the event thread must be joined by destroy"
        );
    }
}

// --- ENGINE-021 -------------------------------------------------------------

/// `mpv_spawn` semantics: a second spawn on a live engine replies with the
/// same `conn`; after a destroy the next spawn creates a NEW engine with a
/// strictly greater `conn` (process-wide monotonic identity).
#[tokio::test]
#[allow(clippy::await_holding_lock)] // intentional: serializes against the other engine tests
async fn engine_021_spawn_is_idempotent_and_replaces_a_destroyed_engine() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let slot: EngineSlot = tokio::sync::Mutex::new(None);
    let (sink, _collected) = collector();
    let first = ensure_spawned(&slot, sink.clone()).await.expect("first spawn must succeed");
    let second = ensure_spawned(&slot, sink).await.expect("second spawn must succeed");
    assert_eq!(first["conn"], second["conn"], "a live engine must be reused");
    let first_conn = first["conn"].as_u64().expect("conn must be numeric");
    assert!(first_conn >= 1, "connection ids start at 1, got {first_conn}");

    // Take the engine out and destroy it: the next spawn must replace it.
    let engine = slot.lock().await.take().expect("the slot must hold the engine");
    engine.destroy(true).expect("cleanup destroy");
    let (sink, _collected) = collector();
    let third = ensure_spawned(&slot, sink).await.expect("respawn after destroy must succeed");
    let third_conn = third["conn"].as_u64().expect("conn must be numeric");
    assert!(
        third_conn > first_conn,
        "a replaced engine must get a strictly greater conn ({first_conn} -> {third_conn})"
    );

    let engine = slot.lock().await.take().expect("the slot must hold the engine");
    engine.destroy(true).expect("cleanup destroy");
}

// --- ENGINE-024 -------------------------------------------------------------

/// libmpv mode must never spawn an mpv process: the sidecar stays untouched.
#[test]
fn engine_024_libmpv_mode_spawns_no_mpv_processes() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let before = mpv_process_ids();
    let (sink, _collected) = collector();
    let engine = Engine::create(sink).expect("engine must create");
    engine.destroy(true).expect("engine must destroy");
    let after = mpv_process_ids();
    let new_processes: Vec<&u32> = after.difference(&before).collect();
    assert!(
        new_processes.is_empty(),
        "libmpv mode must not spawn mpv*.exe (new pids: {new_processes:?})"
    );
}

// --- Playback smoke ---------------------------------------------------------

/// Real playback end to end: load a generated WAV, watch the observed
/// properties flow with the right epoch/conn, pause, seek, stop — then a
/// commanded shutdown that stays silent on the wire.
#[tokio::test]
#[allow(clippy::await_holding_lock)] // intentional: serializes against the other engine tests
async fn playback_smoke_load_pause_seek_stop_and_wire_events() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let (visible_before, hidden_before) = window_visibility_counts();
    let (sink, collected) = collector();
    let engine = Engine::create(sink).expect("engine must create");
    let conn = engine.conn();

    // Keep the smoke silent: the tone exists for the engine, not the user.
    engine
        .send_command(&command(&["set_property", "volume", "0"]))
        .expect("volume must be settable");

    let wav = std::env::temp_dir().join(format!("drplay-s1-smoke-{}.wav", std::process::id()));
    write_test_wav(&wav);
    let wav_path = wav.to_string_lossy().into_owned();

    let reply = engine
        .send_command(&command(&["loadfile", wav_path.as_str(), "replace"]))
        .expect("loadfile must be accepted");
    assert_eq!(reply.load_epoch, 1, "the loadfile reply carries the bumped epoch");
    assert!(
        reply.data["playlist_entry_id"].as_u64().is_some(),
        "loadfile data must be the playlist entry node, got {:?}",
        reply.data
    );

    let loaded = wait_for(&collected, Duration::from_secs(10), |(message, _, _)| {
        is_event(message, "file-loaded")
    })
    .expect("file-loaded must arrive within 10s");
    assert_eq!(loaded.1, 1, "events after the loadfile reply carry the new epoch");
    assert_eq!(loaded.2, conn, "events carry the engine identity");

    let position = wait_for(&collected, Duration::from_secs(10), |(message, _, _)| {
        property_number(message, "time-pos").map(|value| value > 0.0).unwrap_or(false)
    })
    .expect("time-pos must advance past 0");
    assert_eq!(position.1, 1, "observed property events carry the current epoch");
    let (visible_playing, hidden_playing) = window_visibility_counts();
    assert_eq!(
        visible_playing, visible_before,
        "no VISIBLE window may appear while playback runs (S2: the render anchor is hidden; visible {visible_before} -> {visible_playing}, hidden {hidden_before} -> {hidden_playing})"
    );

    engine
        .send_command(&command(&["set_property", "pause", "yes"]))
        .expect("pause must be accepted");
    let paused_event = wait_for(&collected, Duration::from_secs(5), |(message, _, _)| {
        matches!(message, IpcMessage::PropertyChange { name, data } if name == "pause" && *data == Value::Bool(true))
    });
    if paused_event.is_none() {
        // Property events can coalesce under load; fall back to a direct read
        // exactly like the frontend's watchdog does.
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut paused = false;
        while Instant::now() < deadline {
            if engine.get_property("pause").ok() == Some(Value::Bool(true)) {
                paused = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(paused, "pause must be observable via event or property read");
    }

    engine
        .send_command(&command(&["seek", "0.2", "absolute"]))
        .expect("seek must be accepted");
    std::thread::sleep(Duration::from_millis(300));
    engine.send_command(&command(&["stop"])).expect("stop must be accepted");

    let ended = wait_for(&collected, Duration::from_secs(5), |(message, _, _)| {
        end_file_fields(message).is_some()
    })
    .expect("end-file must arrive after stop");
    let (reason, error) = end_file_fields(&ended.0).expect("checked above");
    assert_eq!(reason.as_deref(), Some("stop"), "stop must map to end-file reason=stop");
    assert_eq!(error, None, "a clean stop carries no error");

    let (visible_audio, hidden_audio) = window_visibility_counts();
    assert_eq!(
        visible_audio, visible_before,
        "no VISIBLE window may ever appear in libmpv mode (audio-only fixture; hidden {hidden_before} -> {hidden_audio})"
    );

    engine.destroy(true).expect("commanded shutdown must succeed");
    assert!(!engine.is_alive());
    assert_eq!(close_event_count(&collected), 0, "a commanded shutdown must not emit ipc-closed");
    let (visible_after, hidden_after) = window_visibility_counts();
    assert_eq!(
        visible_after, visible_before,
        "no VISIBLE window may outlive the engine either (hidden {hidden_after})"
    );
    let _ = std::fs::remove_file(&wav);
}

// --- Shutdown semantics -----------------------------------------------------

/// Commanded shutdown: silent (no `ipc-closed`). Un-commanded teardown:
/// exactly one `ipc-closed` with the wire's `eof` cause — and destroy is
/// idempotent, so a second call cannot double-report.
#[tokio::test]
#[allow(clippy::await_holding_lock)] // intentional: serializes against the other engine tests
async fn shutdown_semantics_commanded_silent_uncommanded_reports_close_once() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let (sink, commanded_collected) = collector();
    let engine = Engine::create(sink).expect("engine must create");
    engine.destroy(true).expect("commanded destroy must succeed");
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(close_event_count(&commanded_collected), 0, "commanded shutdown must stay silent");

    let (sink, uncommanded_collected) = collector();
    let engine = Engine::create(sink).expect("engine must create");
    engine.destroy(false).expect("un-commanded destroy must succeed");
    assert_eq!(
        close_event_count(&uncommanded_collected),
        1,
        "an un-commanded teardown must report exactly one engine loss"
    );
    engine.destroy(false).expect("destroy must be idempotent");
    assert_eq!(close_event_count(&uncommanded_collected), 1, "no double report");
}

// --- Core death without a commanded teardown --------------------------------

/// A core that quits on its own must surface exactly like the sidecar dying:
/// one `ipc-closed`, the engine turns not-alive (so the next spawn replaces
/// it), and the teardown stays silent afterwards.
#[tokio::test]
#[allow(clippy::await_holding_lock)] // intentional: serializes against the other engine tests
async fn engine_quit_command_surfaces_ipc_closed_and_stops_the_engine() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let (sink, collected) = collector();
    let engine = Engine::create(sink).expect("engine must create");
    engine.send_command(&command(&["quit"])).expect("quit must be accepted");

    let closed = wait_for(&collected, Duration::from_secs(10), |(message, _, _)| {
        matches!(message, IpcMessage::ConnectionClosed { .. })
    })
    .expect("an un-commanded core death must emit ipc-closed");
    assert_eq!(
        closed.0,
        IpcMessage::ConnectionClosed { cause: "eof".to_string() },
        "the close cause mirrors the wire's pipe-eof vocabulary"
    );
    assert_eq!(closed.2, engine.conn());
    assert!(!engine.is_alive(), "a dead core must not be reused as a live engine");

    engine.destroy(true).expect("teardown after core death must succeed");
    assert_eq!(
        close_event_count(&collected),
        1,
        "core death must be reported exactly once, never doubled by teardown"
    );
}

// --- Teardown hooks (S2 extension point) ------------------------------------

/// The S2 render slice registers a teardown hook to free its render context
/// BEFORE mpv_destroy (spec §18). Pin the contract: the hook runs exactly
/// once on destroy, and never on a live engine.
#[tokio::test]
#[allow(clippy::await_holding_lock)] // intentional: serializes against the other engine tests
async fn teardown_hook_runs_exactly_once_on_destroy() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let (sink, _collected) = collector();
    let engine = Engine::create(sink).expect("engine must create");
    let ran = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let ran_for_hook = Arc::clone(&ran);
    engine.add_teardown_hook(Box::new(move |_engine| {
        ran_for_hook.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }));
    assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), 0, "hooks must not run early");
    engine.destroy(true).expect("destroy must succeed");
    assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), 1, "the hook must run once");
    engine.destroy(true).expect("destroy is idempotent");
    assert_eq!(ran.load(std::sync::atomic::Ordering::SeqCst), 1, "a second destroy must not rerun hooks");
}

// --- End-file error mapping (real DLL) --------------------------------------

/// A failing load must surface as `end-file {reason: "error", error:
/// <mpv_error_string>}` — the exact legacy `file_error` value.
#[tokio::test]
#[allow(clippy::await_holding_lock)] // intentional: serializes against the other engine tests
async fn failing_load_reports_end_file_error_from_mpv_error_string() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let (sink, collected) = collector();
    let engine = Engine::create(sink).expect("engine must create");
    let missing = std::env::temp_dir().join(format!("drplay-s1-missing-{}.wav", std::process::id()));
    let _ = std::fs::remove_file(&missing);
    let missing_path = missing.to_string_lossy().into_owned();
    let reply = engine
        .send_command(&command(&["loadfile", missing_path.as_str(), "replace"]))
        .expect("loadfile itself is accepted; the failure surfaces as end-file");
    assert_eq!(reply.load_epoch, 1);

    let ended = wait_for(&collected, Duration::from_secs(10), |(message, _, _)| {
        end_file_fields(message).is_some()
    })
    .expect("end-file must arrive for a missing file");
    let (reason, error) = end_file_fields(&ended.0).expect("checked above");
    assert_eq!(reason.as_deref(), Some("error"));
    assert_eq!(
        error.as_deref(),
        Some("loading failed"),
        "mpv_error_string(MPV_ERROR_LOADING_FAILED) is the legacy file_error value"
    );
    engine.destroy(true).expect("cleanup destroy");
}

/// The frozen command vocabulary must keep working through the engine: the
/// sidecar's IPC special-cases `set_property`/`get_property` via the client
/// API (input/ipc.c:194-246), and mpv v0.41's command parser renamed the
/// underscore forms away — this pins the parity for the exact commands the
/// frontend sends (set_property is what volume/pause/video use).
#[tokio::test]
#[allow(clippy::await_holding_lock)] // intentional: serializes against the other engine tests
async fn command_vocabulary_set_and_get_property_parity() {
    let _serial = serial();
    if !engine_available() {
        return;
    }
    let (sink, collected) = collector();
    let engine = Engine::create(sink).expect("engine must create");

    // set_property: exactly what mpvAudio.ts sends for volume/pause/video.
    let reply = engine
        .send_command(&command(&["set_property", "volume", "0"]))
        .expect("set_property must be accepted (IPC special-case parity)");
    assert_eq!(reply.data, Value::Null, "set_property reply data is null on the wire");
    assert_eq!(reply.load_epoch, 0, "set_property must not bump the load epoch");
    engine
        .send_command(&command(&["set_property", "pause", "yes"]))
        .expect("set_property pause yes must parse like the sidecar's");
    assert_eq!(
        engine.get_property("pause").expect("read back"),
        Value::Bool(true),
        "the string value must take effect exactly like the sidecar's"
    );

    // get_property through mpv_command shares the dedicated read path.
    let reply = engine
        .send_command(&command(&["get_property", "pause"]))
        .expect("get_property must be accepted (IPC special-case parity)");
    assert_eq!(reply.data, Value::Bool(true));
    assert_eq!(reply.load_epoch, 0);

    // A missing property keeps the legacy error string.
    let error = engine
        .send_command(&command(&["get_property", "no-such-property-xyz"]))
        .expect_err("an unknown property must be rejected");
    assert_eq!(error.wire_message(), "mpv error: property not found");

    // Wrong arity mirrors the IPC special-case rejection (-4).
    engine
        .send_command(&command(&["set_property", "volume"]))
        .expect_err("set_property with 2 arguments must be rejected");

    // The new-name `set` goes through the real parser, same as the sidecar.
    engine
        .send_command(&command(&["set", "volume", "0"]))
        .expect("the parser's `set` command must work too");

    engine.destroy(true).expect("cleanup destroy");
    assert_eq!(close_event_count(&collected), 0);
}

/// The pull complement (`video_host_first_frame_presented`, player/mod.rs)
/// must answer false while no render surface exists — no engine spawned,
/// headless engine, or the legacy engine — so the frontend keeps waiting for
/// the push event exactly like before the pull existed. The `true` case needs
/// a real composition surface and is covered by the runtime verification, not
/// by this process-local test.
#[test]
fn first_frame_pull_is_false_without_a_render_surface() {
    let _serial = serial();
    assert!(!super::video_surface_first_frame_presented());
}


