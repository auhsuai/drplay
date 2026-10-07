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

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::ipc::{EventSink, IpcMessage, MpvIpc};
use super::process::{connect_pipe, new_pipe_name, spawn_mpv, MPV_LOG_FILE_NAME};
use crate::stream_proxy::TokenSource;

/// Deadline for "mpv must reach this state". Generous for a cold file on a
/// warm page cache, short enough that a wedged engine fails instead of hanging.
const READY_TIMEOUT: Duration = Duration::from_secs(20);
/// Budget for one IPC round-trip.
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
/// Gap allowed around a seek target: the SAME contract the production seek-ack
/// uses (`SEEK_ACK_TOLERANCE_SECS = 1`, src/lib/mpvProtocol.ts).
const SEEK_TOLERANCE_SECS: f64 = 1.0;
/// Fraction of the duration the forward-seek tests aim at.
const SEEK_TARGET_FRACTION: f64 = 0.75;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn fixture(name: &str) -> PathBuf {
    let dir = std::env::var("DRPLAY_VIDEO_FIXTURES").unwrap_or_else(|_| {
        panic!("DRPLAY_VIDEO_FIXTURES must point at the fixture directory (probe.mkv, large.mkv, ...)")
    });
    let path = PathBuf::from(dir).join(name);
    assert!(
        path.is_file(),
        "fixture {name} is missing at {} — generate it first",
        path.display()
    );
    path
}

// ---------------------------------------------------------------------------
// Real HTTP Range origin (stands in for Drive `files/{id}?alt=media`)
// ---------------------------------------------------------------------------

/// What one origin response served, so tests can prove the proxy streams ranges
/// instead of slurping whole files.
#[derive(Clone, Debug)]
struct ServedRange {
    path: String,
    range: Option<String>,
    status: u16,
    declared_bytes: usize,
    content_range: Option<String>,
    had_bearer: bool,
}

struct Origin {
    port: u16,
    served: Arc<Mutex<Vec<ServedRange>>>,
    pulled: Arc<std::sync::atomic::AtomicUsize>,
}

impl Origin {
    fn requests(&self) -> Vec<ServedRange> {
        self.served.lock().expect("origin log must be lockable").clone()
    }

    /// Largest single range the CLIENT (mpv, via the proxy) asked for.
    fn max_response_bytes(&self) -> usize {
        self.requests().iter().map(|entry| entry.declared_bytes).max().unwrap_or(0)
    }

    /// Bytes actually pulled OFF DISK and handed to the proxy. This is the
    /// measurement that answers "does the proxy buffer the whole file?": a
    /// buffering proxy would pull the file even when mpv stopped reading, a
    /// streaming one only pulls as far as the client consumes.
    fn bytes_pulled(&self) -> usize {
        self.pulled.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Counts bytes handed to the proxy, then delegates. Backpressure (not a local
/// buffer) is what keeps this number small when the client stops reading.
struct CountingReader<R> {
    inner: R,
    counter: Arc<std::sync::atomic::AtomicUsize>,
}

impl<R: std::io::Read> std::io::Read for CountingReader<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(out)?;
        self.counter.fetch_add(count, std::sync::atomic::Ordering::SeqCst);
        Ok(count)
    }
}

/// Stall injected into the FIRST response: send a prefix, then go silent (the
/// connection stays open, no EOF) — a network dying mid-body.
#[derive(Clone, Copy)]
struct Stall {
    first_bytes: usize,
    stall: Duration,
}

/// Read impl: hand out the prefix, sleep (silence, no EOF), then finish.
struct StallingReader {
    file: std::fs::File,
    remaining: usize,
    sent: usize,
    stall_after: usize,
    stall: Duration,
    stalled: bool,
}

impl std::io::Read for StallingReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        if self.sent >= self.stall_after && !self.stalled {
            self.stalled = true;
            std::thread::sleep(self.stall);
        }
        let wanted = out.len().min(self.remaining);
        let count = std::io::Read::read(&mut self.file, &mut out[..wanted])?;
        self.remaining -= count;
        self.sent += count;
        Ok(count)
    }
}

fn parse_range(header: Option<&str>, total: usize) -> (usize, usize) {
    let last = total.saturating_sub(1);
    let Some(header) = header else { return (0, last) };
    let raw = header.trim().strip_prefix("bytes=").unwrap_or(header);
    let mut parts = raw.splitn(2, '-');
    let start = parts.next().unwrap_or("0").trim().parse::<usize>().unwrap_or(0);
    let end = parts.next().unwrap_or("").trim().parse::<usize>().unwrap_or(last);
    (start.min(last), end.min(last))
}

/// Serve `path` with real `Range` support (the exact capability the proxy and
/// mpv depend on), recording every response. Ids in `missing_ids` answer 404.
fn spawn_origin(path: &Path, stall: Option<Stall>, missing_ids: &[&str]) -> Origin {
    use std::io::{Read, Seek, SeekFrom};

    const WORKERS: usize = 8;
    let total = std::fs::metadata(path).expect("fixture metadata must be readable").len() as usize;
    let served: Arc<Mutex<Vec<ServedRange>>> = Arc::new(Mutex::new(Vec::new()));
    let pulled: Arc<std::sync::atomic::AtomicUsize> = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let path: Arc<PathBuf> = Arc::new(path.to_path_buf());
    let stall = Arc::new(Mutex::new(stall));
    let missing: Arc<Vec<String>> = Arc::new(missing_ids.iter().map(|id| (*id).to_string()).collect());
    let first_response = Arc::new(Mutex::new(true));

    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").expect("range origin must bind"));
    let port = server.server_addr().to_ip().expect("origin address").port();
    for _ in 0..WORKERS {
        let server = Arc::clone(&server);
        let served = Arc::clone(&served);
        let pulled = Arc::clone(&pulled);
        let path = Arc::clone(&path);
        let stall = Arc::clone(&stall);
        let missing = Arc::clone(&missing);
        let first_response = Arc::clone(&first_response);
        std::thread::spawn(move || loop {
            let Ok(request) = server.recv() else { continue };
            let url = request.url().to_string();
            let mut record = ServedRange {
                path: url.clone(),
                range: None,
                status: 200,
                declared_bytes: 0,
                content_range: None,
                had_bearer: false,
            };
            for header in request.headers() {
                let name = header.field.as_str().as_str();
                if name.eq_ignore_ascii_case("range") {
                    record.range = Some(header.value.as_str().to_string());
                }
                if name.eq_ignore_ascii_case("authorization") {
                    record.had_bearer = header.value.as_str().starts_with("Bearer ");
                }
            }
            let requested_id = url
                .split("/drive/v3/files/")
                .nth(1)
                .map(|rest| rest.split(['?', '/']).next().unwrap_or("").to_string())
                .unwrap_or_default();
            let known = !missing.iter().any(|id| *id == requested_id);

            let is_first = {
                let mut guard = first_response.lock().expect("first-response flag");
                let was_first = *guard;
                *guard = false;
                was_first
            };
            let this_stall = if is_first { *stall.lock().expect("stall lock") } else { None };

            let response: tiny_http::Response<Box<dyn Read + Send>> = if !known {
                record.status = 404;
                tiny_http::Response::from_data(b"file not found".to_vec()).boxed()
            } else {
                let (start, end) = parse_range(record.range.as_deref(), total);
                let length = end - start + 1;
                record.status = 206;
                record.declared_bytes = length;
                record.content_range = Some(format!("bytes {start}-{end}/{total}"));
                let opened = std::fs::File::open(path.as_ref())
                    .and_then(|mut file| {
                        file.seek(SeekFrom::Start(start as u64))?;
                        Ok(file)
                    })
                    .expect("fixture must be openable");
                let reader: Box<dyn Read + Send> = match this_stall {
                    Some(stall) => Box::new(CountingReader {
                        inner: StallingReader {
                            file: opened,
                            remaining: length,
                            sent: 0,
                            stall_after: stall.first_bytes,
                            stall: stall.stall,
                            stalled: false,
                        },
                        counter: Arc::clone(&pulled),
                    }),
                    None => Box::new(CountingReader {
                        inner: opened.take(length as u64),
                        counter: Arc::clone(&pulled),
                    }),
                };
                let mut response = tiny_http::Response::from_data(Vec::new())
                    .with_status_code(206)
                    .with_data(reader, Some(length));
                for (name, value) in [
                    ("Content-Range", record.content_range.clone().unwrap_or_default()),
                    ("Accept-Ranges", "bytes".to_string()),
                ] {
                    response.add_header(
                        tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes())
                            .expect("header must be valid"),
                    );
                }
                response.boxed()
            };
            served.lock().expect("origin log lock").push(record);
            let _ = request.respond(response);
        });
    }
    Origin { port, served, pulled }
}

// ---------------------------------------------------------------------------
// Real proxy (src/stream_proxy/server.rs) with the PRODUCTION timeouts
// ---------------------------------------------------------------------------

/// Token source that never touches the OS vault or Google: the proxy still runs
/// its real code path, it just gets a fixed token.
struct FixedTokens;

impl crate::stream_proxy::TokenSource for FixedTokens {
    fn current(&self) -> Option<String> {
        Some(HARNESS_TOKEN.to_string())
    }

    fn refresh(
        self: Arc<Self>,
        _force: bool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>> {
        Box::pin(async { Ok(HARNESS_TOKEN.to_string()) })
    }
}

const HARNESS_TOKEN: &str = "harness-token-not-a-real-credential";
/// The two production deadlines, spelled out. These mirror
/// `UPSTREAM_HEADERS_TIMEOUT` / `UPSTREAM_BODY_IDLE_TIMEOUT` in
/// stream_proxy/mod.rs: if a shipped value changes, this harness must change
/// with it — the tests exist to measure the SHIPPED numbers.
const PROXY_HEADERS_TIMEOUT: Duration = Duration::from_secs(15);
const PROXY_BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(20);

fn spawn_real_proxy(upstream_port: u16, body_idle_timeout: Duration) -> u16 {
    let sink: crate::stream_proxy::server::ErrorSink = Arc::new(|_file_id, _status| {});
    crate::stream_proxy::server::spawn_proxy(
        sink,
        format!("http://127.0.0.1:{upstream_port}"),
        Arc::new(FixedTokens),
        PROXY_HEADERS_TIMEOUT,
        body_idle_timeout,
    )
    .expect("the real proxy must start")
}

/// The URL the frontend hands mpv: `buildProxyStreamUrl`
/// (src/lib/mpvProtocol.ts:169) is exactly this shape — localhost origin,
/// `/stream/`, the file id, nothing else.
fn proxy_url(proxy_port: u16, file_id: &str) -> String {
    format!("http://127.0.0.1:{proxy_port}/stream/{file_id}")
}

// ---------------------------------------------------------------------------
// Real mpv sidecar
// ---------------------------------------------------------------------------

/// A live sidecar, driven exactly the way the frontend drives it. Dropping it
/// kills mpv (the child is `kill_on_drop` and pinned to a kill-on-close job), so
/// a panicking test cannot orphan a process.
struct Session {
    ipc: MpvIpc,
    child: tokio::process::Child,
    _job: super::job::JobHandle,
    pid: u32,
    events: Arc<Mutex<Vec<IpcMessage>>>,
    log_path: PathBuf,
}

impl Session {
    async fn spawn(tag: &str) -> Session {
        let dir = std::env::temp_dir()
            .join(format!("drplay-video-probe-{}-{}", std::process::id(), tag));
        std::fs::create_dir_all(&dir).expect("probe log dir must be creatable");
        let log_path = dir.join(MPV_LOG_FILE_NAME);
        let pipe_name = new_pipe_name();
        let spawned = spawn_mpv(&pipe_name, Some(log_path.as_path())).expect("sidecar must spawn");
        let pid = spawned.child.id().expect("a spawned child has a pid");

        let client = connect_pipe(&pipe_name)
            .await
            .expect("the sidecar pipe must connect (bounded retry)");
        let events: Arc<Mutex<Vec<IpcMessage>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let events = Arc::clone(&events);
            Arc::new(move |message, _epoch, _conn| events.lock().expect("events lock").push(message))
        };
        Session {
            ipc: MpvIpc::new(client, sink),
            child: spawned.child,
            _job: spawned.job,
            pid,
            events,
            log_path,
        }
    }

    /// One IPC round-trip, bounded: a wedged engine surfaces as an Err instead
    /// of parking the test.
    async fn command(&self, args: Vec<Value>) -> Result<Value, String> {
        tokio::time::timeout(QUERY_TIMEOUT, self.ipc.send_command(args))
            .await
            .map_err(|_elapsed| format!("mpv IPC timed out after {QUERY_TIMEOUT:?}"))?
    }

    async fn property(&self, name: &str) -> Result<Value, String> {
        self.command(vec![json!("get_property"), json!(name)]).await
    }

    async fn property_f64(&self, name: &str) -> Option<f64> {
        self.property(name).await.ok().and_then(|value| value.as_f64())
    }

    /// `mpvAudio.loadTrack` (src/lib/mpvAudio.ts:782-794) verbatim: `set_property
    /// video` FIRST, then `loadfile <proxy url> replace`. `video` is "1" for a
    /// video track and "no" for an audio one.
    async fn load_like_the_app(&self, url: &str, video: bool) -> Result<Value, String> {
        self.command(vec![
            json!("set_property"),
            json!("video"),
            json!(if video { "1" } else { "no" }),
        ])
        .await?;
        self.command(vec![json!("loadfile"), json!(url), json!("replace")]).await
    }

    /// Poll a property until `predicate` holds.
    async fn wait_property<F>(&self, name: &str, deadline: Duration, mut predicate: F) -> Option<Value>
    where
        F: FnMut(&Value) -> bool,
    {
        let stop = Instant::now() + deadline;
        loop {
            if let Ok(value) = self.property(name).await {
                if predicate(&value) {
                    return Some(value);
                }
            }
            if Instant::now() >= stop {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }

    async fn wait_duration(&self) -> f64 {
        self.wait_property("duration", READY_TIMEOUT, |value| value.as_f64().unwrap_or(0.0) > 0.0)
            .await
            .and_then(|value| value.as_f64())
            .unwrap_or_else(|| panic!("duration must be known within {READY_TIMEOUT:?}"))
    }

    /// "A video frame is on screen" = mpv's `vo-configured` went true. That is
    /// the property mpv itself sets once a video output is live, so it is the
    /// honest signal — `video-out-params/W` does not exist in 0.41 (measured: it
    /// never resolves), and the resolution is read from the VO log line instead.
    async fn wait_first_video_frame(&self, deadline: Duration) -> bool {
        self.wait_property("vo-configured", deadline, |value| value.as_bool() == Some(true))
            .await
            .is_some()
    }

    /// `VO: [gpu-next] 640x360 yuv420p` -> `gpu-next 640x360 yuv420p`, straight
    /// out of the sidecar log.
    fn vo_line(&self) -> Option<String> {
        let log = self.log();
        let line = log.lines().find(|line| line.contains("VO: ["))?;
        let (_, rest) = line.split_once("VO: [")?;
        let (driver, size) = rest.split_once(']')?;
        Some(format!("{}{}", driver, size.trim_start()))
    }

    async fn wait_playing(&self) -> bool {
        self.wait_property("time-pos", READY_TIMEOUT, |value| value.as_f64().unwrap_or(-1.0) > 0.0)
            .await
            .is_some()
    }

    /// Wait until a top-level WINDOW owned by this mpv process exists.
    async fn wait_for_window(&self, deadline: Duration) -> Option<String> {
        let stop = Instant::now() + deadline;
        loop {
            if let Some(title) = first_window(self.pid) {
                return Some(title);
            }
            if Instant::now() >= stop {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    /// Give mpv a bounded moment to destroy a window it should not keep.
    async fn settle(&self) {
        tokio::time::sleep(Duration::from_millis(1200)).await;
    }

    fn end_file_events(&self) -> Vec<(Option<String>, Option<String>)> {
        self.events
            .lock()
            .expect("events lock")
            .iter()
            .filter_map(|message| match message {
                IpcMessage::MpvEvent { event, reason, error } if event == "end-file" => {
                    Some((reason.clone(), error.clone()))
                }
                _ => None,
            })
            .collect()
    }

    fn log(&self) -> String {
        std::fs::read_to_string(&self.log_path).unwrap_or_default()
    }

    /// mpv's own monotonic clock at a log line. Used for startup latency:
    /// `[   0.124][v][vd] Opening decoder h264` -> `0.124`.
    fn log_timestamp_secs(&self, needle: &str) -> Option<f64> {
        let log = self.log();
        log.lines().find_map(|line| {
            let (stamp, rest) = line.strip_prefix('[')?.split_once(']')?;
            rest.contains(needle).then(|| stamp.trim().parse::<f64>().ok())?
        })
    }

    /// The app's own shutdown: `quit` + wait for the exit. The job handle is
    /// dropped with the Session, so nothing can survive this.
    async fn quit(&mut self) {
        let _ = self.command(vec![json!("quit")]).await;
        let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
    }
}

// ---------------------------------------------------------------------------
// Process / window / memory observation
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{BOOL, FILETIME, HWND, LPARAM};
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    /// Pid the `EnumWindows` callback filters on. `EnumWindowsProcW` is a plain
    /// fn pointer with no environment, so the target rides in a static and the
    /// collected titles ride in `LPARAM`.
    static ENUM_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    /// Every VISIBLE top-level window owned by `pid`, with its title. This is
    /// the ground truth for "did mpv open a video window" — a window class or an
    /// assumption about gpu-next would not be evidence, the OS window list is.
    pub fn visible_windows(pid: u32) -> Vec<String> {
        extern "system" fn visit(hwnd: HWND, param: LPARAM) -> BOOL {
            let titles = unsafe { &mut *((param as *mut Vec<String>)) };
            let mut owner = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, &mut owner) };
            let wanted = ENUM_PID.load(std::sync::atomic::Ordering::SeqCst);
            if owner == wanted && unsafe { IsWindowVisible(hwnd) } != 0 {
                let mut buffer = [0u16; 512];
                let length = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
                if length > 0 {
                    titles.push(String::from_utf16_lossy(&buffer[..length as usize]));
                }
            }
            1
        }

        ENUM_PID.store(pid, std::sync::atomic::Ordering::SeqCst);
        let mut titles: Vec<String> = Vec::new();
        let ok = unsafe { EnumWindows(Some(visit), (&mut titles as *mut Vec<String>) as LPARAM) };
        assert_ne!(ok, 0, "EnumWindows must enumerate (desktop window list unavailable)");
        titles
    }

    /// WorkingSet / PrivateUsage in bytes for `pid`.
    pub fn memory(pid: u32) -> Option<(u64, u64)> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = unsafe {
            GetProcessMemoryInfo(
                handle,
                (&raw mut counters).cast::<PROCESS_MEMORY_COUNTERS>(),
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            )
        };
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        (ok != 0).then_some((counters.WorkingSetSize as u64, counters.PrivateUsage as u64))
    }

    /// (kernel + user) CPU seconds consumed by `pid` so far.
    pub fn cpu_secs(pid: u32) -> Option<f64> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let mut times = [
            FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
        ];
        let ok = unsafe {
            GetProcessTimes(handle, &mut times[0], &mut times[1], &mut times[2], &mut times[3])
        };
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        if ok == 0 {
            return None;
        }
        let ticks = |value: FILETIME| {
            (((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64) as f64 / 10_000_000.0
        };
        Some(ticks(times[2]) + ticks(times[3]))
    }

    /// Every live process whose image is `image`, as pids.
    ///
    /// ToolHelp rather than `tasklist`: a test harness must not depend on a
    /// subprocess to answer "is there an orphan engine", and this is the same
    /// enumeration the task manager does.
    pub fn pids_named(image: &str) -> Vec<u32> {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Vec::new();
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..unsafe { std::mem::zeroed() }
        };
        let mut pids = Vec::new();
        let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while ok {
            let end = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case(image) {
                pids.push(entry.th32ProcessID);
            }
            ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { windows_sys::Win32::Foundation::CloseHandle(snapshot) };
        pids
    }
}

fn first_window(pid: u32) -> Option<String> {
    #[cfg(windows)]
    {
        win::visible_windows(pid).into_iter().next()
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

fn all_windows(pid: u32) -> Vec<String> {
    #[cfg(windows)]
    {
        win::visible_windows(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Vec::new()
    }
}

fn memory_mb(pid: u32) -> Option<(f64, f64)> {
    #[cfg(windows)]
    {
        win::memory(pid).map(|(working, private)| (working as f64 / 1048576.0, private as f64 / 1048576.0))
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

fn cpu_secs(pid: u32) -> Option<f64> {
    #[cfg(windows)]
    {
        win::cpu_secs(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

/// pids of every live `mpv.exe` on the box.
fn mpv_pids() -> Vec<u32> {
    #[cfg(windows)]
    {
        win::pids_named("mpv.exe")
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// pids of every live `drplay.exe` on the box.
fn drplay_pids() -> Vec<u32> {
    #[cfg(windows)]
    {
        win::pids_named("drplay.exe")
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

fn report(label: impl std::fmt::Display, value: impl std::fmt::Display) {
    println!("[evidence] {label}: {value}");
}

async fn assert_no_mpv(context: &str) {
    let pids = mpv_pids();
    report(format!("{context}: mpv.exe pids"), format!("{pids:?}"));
    assert!(pids.is_empty(), "no mpv.exe may survive {context}, got {pids:?}");
}

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
    let mut results: Vec<(String, f64, Option<(f64, f64)>)> = Vec::new();

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

async fn peak_memory_mb(session: &Session, window: Duration) -> f64 {
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
