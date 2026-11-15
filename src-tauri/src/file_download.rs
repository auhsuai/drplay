//! Streaming single-file download from Google Drive to disk.
//!
//! Step 1 of the download rework: replaces the old frontend
//! `fetch` + `arrayBuffer()` path (whole file buffered in RAM, absolute
//! 5-minute timeout, no progress, no resume) with a Rust-first streamer.
//!
//! ## Pipeline
//!
//! ```text
//! start_file_download (Tauri command, Channel progress)
//!     |
//! download_file (transport-injected core, testable without the network)
//!     |
//!   .part file (+ .part.json sidecar) -> size gate -> MD5 gate -> rename
//! ```
//!
//! Rules that must not be reordered or weakened:
//!
//! * Bytes are streamed chunk-by-chunk into `<dest>.part` in the destination
//!   directory (same filesystem, so the final `rename` is atomic). The whole
//!   file is never held in memory.
//! * The `.part` file is kept on network/timeout/disk errors so a later run
//!   can resume it with `Range`; it is deleted only when the user cancels
//!   outright, or when a *completed* stream fails verification (a retry then
//!   starts clean instead of re-verifying the same bad bytes forever).
//! * Timeouts are idle timeouts (no byte for [`IDLE_TIMEOUT`]), never an
//!   absolute deadline for the whole file.
//! * Retries cover only 429 / 5xx and 403-with-a-rate-limit-reason, with
//!   exponential backoff + jitter and `Retry-After` honoured. A 401 refreshes
//!   the access token once (through the same vault + `auth.rs` path the
//!   stream proxy uses) and continues with a fresh `Range` request.
//! * Resume follows the status table in [`decide_resume`]: 206 with the
//!   expected offset appends; 200 after a `Range` request means the server
//!   ignored the range and the part must be truncated first — appending a
//!   200 body to a partial file would corrupt it; 416 with a complete part
//!   goes straight to verification.
//! * Integrity: the length gate runs first, then the MD5 gate against the
//!   `md5Checksum` Drive reports for binary files. Drive does NOT report a
//!   SHA-256 for user files, so no SHA-256 is ever invented here. When no
//!   MD5 is available the size gate is the only check, and that is reported
//!   honestly (no fabricated checksum).
//!
//! Out of scope for this step (deliberately): multi-file queues, speed
//! limiting, Google Docs export, Drive shortcuts. Folder downloads (Step 2)
//! reuse this module per file and only add `ensure_download_directory`
//! below, which creates the destination tree with the same `create_dir_all`
//! the single-file path already uses.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::future::BoxFuture;
use futures_util::Stream;
use futures_util::StreamExt;
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

/// No byte for this long mid-stream: the network is dead, not slow. The
/// header phase has its own (shorter) deadline in the transport; this only
/// bounds gaps between body chunks, so a multi-GB file is never cut off for
/// being large.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// How many network attempts (each a fresh request, resumed from the current
/// `.part` length) before the download gives up. The 401 token refresh does
/// not consume an attempt.
const MAX_ATTEMPTS: u32 = 3;
/// Drive redirects `files/{id}?alt=media` to a signed host; each hop is
/// followed manually so `Authorization` can be re-applied (reqwest strips it
/// on cross-origin redirects).
const MAX_REDIRECTS: u32 = 10;
/// Buffered writer capacity for the `.part` file. 64 KiB keeps syscalls low
/// without holding a meaningful amount of memory.
const WRITE_BUF_CAPACITY: usize = 64 * 1024;
/// Bytes read at a time when re-hashing a resumed `.part` prefix.
const HASH_READ_CHUNK: usize = 1024 * 1024;
/// Rename retries on Windows: antivirus/indexer can briefly hold a fresh
/// file, so a single failed rename is not a failed download.
const RENAME_RETRIES: u32 = 3;
/// Progress is emitted at most this often, or immediately when the whole
/// percent advances (same shape as `playback_runtime::download`).
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(200);
const PROGRESS_PERCENT_STEP: u64 = 1;

/// Drive API origin for `files/{id}?alt=media`.
const DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// What the frontend passes to `start_file_download`.
///
/// `expected_size` / `md5` come from a `files.get?fields=size,md5Checksum`
/// call the frontend makes before starting; both are optional because the
/// metadata call itself can fail — the download then falls back to the
/// `Content-Length` / `Content-Range` the server reports, and to the size
/// gate only when no MD5 is available.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDownloadRequest {
    pub download_id: String,
    pub file_id: String,
    pub dest_path: String,
    pub token: String,
    pub expected_size: Option<u64>,
    pub md5: Option<String>,
}

/// Returned by `start_file_download` when the file is on disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDownloadResult {
    pub path: String,
    pub size: u64,
    pub resumed: bool,
}

/// Progress event sent over the Tauri `Channel`.
///
/// `total` / `percent` are `None` — never zero — when the length is unknown,
/// so the UI cannot mistake "no Content-Length" for a determinate bar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum FileDownloadProgress {
    // NOTE: the enum-level `rename_all` only renames the variant names;
    // struct-variant field names need their own `rename_all` (serde does
    // not inherit it into variants). Without this the wire JSON would
    // carry `download_id` / `speed_bytes_per_sec` while the frontend
    // Channel type reads `downloadId` / `speedBytesPerSec`.
    #[serde(rename_all = "camelCase")]
    Downloading {
        download_id: String,
        downloaded: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        percent: Option<u8>,
        #[serde(skip_serializing_if = "Option::is_none")]
        speed_bytes_per_sec: Option<u64>,
        paused: bool,
    },
    #[serde(rename_all = "camelCase")]
    Verifying {
        download_id: String,
        downloaded: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
    },
}

impl FileDownloadProgress {
    pub fn percent(&self) -> Option<u8> {
        match self {
            Self::Downloading {
                downloaded,
                total: Some(total),
                ..
            } if *total > 0 => {
                let pct = (*downloaded as u128 * 100) / (*total as u128);
                Some(pct.min(100) as u8)
            }
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Everything that can go wrong while downloading one user file.
///
/// `code()` is a stable snake_case slug: the frontend branches on the prefix
/// before the first `": "` to pick a localised message, so changing a slug
/// is a breaking change for the UI. `Display` never embeds a token, a full
/// URL, or a checksum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileDownloadError {
    /// Transport-level failure (DNS, TLS, connection reset, stream cut).
    Network { detail: String },
    /// The server answered, but not with a usable status.
    HttpStatus { status: u16 },
    /// 404/410: the file is gone from Drive (deleted or trashed).
    FileMissing { status: u16 },
    /// 403 that is not a rate limit: the account may not download this file.
    Forbidden { status: u16 },
    /// 429, or 403 whose body names a Drive usage-limit reason.
    RateLimited { retry_after_secs: Option<u64> },
    /// 401, and the one token refresh did not produce a usable token.
    Unauthorized,
    /// The token refresh itself failed (vault unreadable, endpoint error).
    AuthRefresh { detail: String },
    /// No byte arrived for [`IDLE_TIMEOUT`] mid-stream.
    IdleTimeout,
    /// The user cancelled. Not a failure: the `.part` file is kept for resume.
    Cancelled,
    /// A download with this id is already running in this process.
    AlreadyInProgress,
    /// The destination path is unusable (empty name, parent not a directory).
    InvalidPath { detail: String },
    /// The destination already holds a file that is NOT the complete
    /// expected download (wrong size, or no expected size to compare
    /// against). The bulk-download flow treats this as a per-file failure
    /// instead of silently overwriting the user's file: `std::fs::rename`
    /// on Windows refuses to replace an existing file anyway, so
    /// downloading first and failing at publish would waste the transfer.
    AlreadyExists { detail: String },
    /// Not enough free space on the destination volume.
    InsufficientSpace { needed: u64, available: u64 },
    /// The finished byte count differs from the expected size.
    SizeMismatch { expected: u64, actual: u64 },
    /// The finished MD5 differs from Drive's `md5Checksum`.
    ChecksumMismatch,
    /// The verified file could not be renamed into place.
    PublishFailed { detail: String },
    /// A write/flush/sync of the `.part` file failed (incl. disk full).
    Io { detail: String },
}

impl FileDownloadError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Network { .. } => "network",
            Self::HttpStatus { .. } => "http_status",
            Self::FileMissing { .. } => "file_missing",
            Self::Forbidden { .. } => "forbidden",
            Self::RateLimited { .. } => "rate_limited",
            Self::Unauthorized => "unauthorized",
            Self::AuthRefresh { .. } => "auth_refresh",
            Self::IdleTimeout => "idle_timeout",
            Self::Cancelled => "cancelled",
            Self::AlreadyInProgress => "already_in_progress",
            Self::InvalidPath { .. } => "invalid_path",
            Self::AlreadyExists { .. } => "already_exists",
            Self::InsufficientSpace { .. } => "insufficient_space",
            Self::SizeMismatch { .. } => "size_mismatch",
            Self::ChecksumMismatch => "checksum_mismatch",
            Self::PublishFailed { .. } => "publish_failed",
            Self::Io { .. } => "io",
        }
    }

    /// Whether the attempt loop may retry this error with a fresh request.
    /// Cancellation, verification failures and user/path errors are never
    /// retried: retrying them can only repeat the same outcome.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Network { .. }
                | Self::HttpStatus { .. }
                | Self::RateLimited { .. }
                | Self::IdleTimeout
                | Self::Io { .. }
        )
    }

    /// Retry-After seconds carried by a rate-limit error, if the server sent
    /// one.
    pub fn retry_after_secs(&self) -> Option<u64> {
        match self {
            Self::RateLimited { retry_after_secs } => *retry_after_secs,
            _ => None,
        }
    }
}

impl std::fmt::Display for FileDownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network { detail } => write!(f, "a network error occurred: {detail}"),
            Self::HttpStatus { status } => write!(f, "the server answered with HTTP {status}"),
            Self::FileMissing { status } => {
                write!(
                    f,
                    "the file is no longer available on Google Drive (HTTP {status})"
                )
            }
            Self::Forbidden { status } => {
                write!(f, "this account may not download the file (HTTP {status})")
            }
            Self::RateLimited { .. } => write!(f, "Google Drive is rate limiting downloads"),
            Self::Unauthorized => {
                write!(f, "the Google sign-in expired and could not be refreshed")
            }
            Self::AuthRefresh { detail } => {
                write!(f, "refreshing the Google sign-in failed: {detail}")
            }
            Self::IdleTimeout => write!(
                f,
                "the download stalled: no data arrived for {IDLE_TIMEOUT:?}"
            ),
            Self::Cancelled => write!(f, "the download was cancelled"),
            Self::AlreadyInProgress => write!(f, "a download with this id is already running"),
            Self::AlreadyExists { detail } => write!(
                f,
                "a file already exists at the destination: {detail}"
            ),
            Self::InvalidPath { detail } => write!(f, "the destination path is unusable: {detail}"),
            Self::InsufficientSpace { needed, available } => write!(
                f,
                "not enough free space: need {needed} bytes, {available} available"
            ),
            Self::SizeMismatch { expected, actual } => {
                write!(
                    f,
                    "the downloaded size ({actual}) differs from the expected size ({expected})"
                )
            }
            Self::ChecksumMismatch => {
                write!(f, "the download does not match the file on Google Drive")
            }
            Self::PublishFailed { detail } => write!(
                f,
                "the finished file could not be moved into place: {detail}"
            ),
            Self::Io { detail } => write!(f, "writing the download failed: {detail}"),
        }
    }
}

impl std::error::Error for FileDownloadError {}

/// The command error string: a stable code prefix, then user-safe prose.
pub fn download_error_message(error: &FileDownloadError) -> String {
    format!("{}: {error}", error.code())
}

// ---------------------------------------------------------------------------
// Resume bookkeeping
// ---------------------------------------------------------------------------

/// What a response status means for the `.part` file on disk.
///
/// The 200 case is the trap: a server that ignores `Range` answers 200 with
/// the *whole* file, so appending that body to a partial file corrupts it.
/// A 200 after a ranged request therefore always restarts from zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeAction {
    /// Append the body at `offset`.
    Append,
    /// Delete the `.part` file and start from zero.
    Restart,
    /// The part is already complete: verify it, then publish.
    VerifyAndPublish,
}

/// Pure resume decision, so the status table is testable without a network.
///
/// `offset` is the current `.part` length; `content_range_start` is the
/// start of the `Content-Range` header on a 206 (if any); `total` is the
/// known full size (if any).
pub fn decide_resume(
    status: u16,
    offset: u64,
    content_range_start: Option<u64>,
    total: Option<u64>,
) -> ResumeAction {
    match status {
        206 => {
            // A 206 that starts anywhere other than our offset is a different
            // byte range than the one we asked for: never append it.
            if content_range_start == Some(offset) {
                ResumeAction::Append
            } else {
                ResumeAction::Restart
            }
        }
        200 => {
            if offset == 0 {
                ResumeAction::Append
            } else {
                ResumeAction::Restart
            }
        }
        416 => {
            // Range not satisfiable: only a complete part can be salvaged.
            if offset > 0 && total == Some(offset) {
                ResumeAction::VerifyAndPublish
            } else {
                ResumeAction::Restart
            }
        }
        _ => ResumeAction::Restart,
    }
}

/// Parse the start offset out of `Content-Range: bytes 123-456/789`.
pub fn parse_content_range_start(header: &str) -> Option<u64> {
    let rest = header.strip_prefix("bytes ")?;
    let (start, _) = rest.split_once('-')?;
    start.trim().parse().ok()
}

/// Parse a `Retry-After` header value (numeric seconds only; HTTP-dates are
/// ignored rather than misread).
pub fn parse_retry_after_secs(value: &str) -> Option<u64> {
    value.trim().parse().ok()
}

/// Exponential backoff with jitter, capped at 32 s: `min(1000 * 2^attempt,
/// 32000) + [0, 1000) ms` from the wall clock (no extra RNG dependency).
/// A server-sent `Retry-After` wins over the computed delay.
pub fn backoff_delay_ms(attempt: u32, retry_after_secs: Option<u64>) -> u64 {
    if let Some(secs) = retry_after_secs {
        return secs.saturating_mul(1000).min(32_000);
    }
    let base = 1000u64.saturating_mul(1u64 << attempt.min(15));
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 % 1000)
        .unwrap_or(0);
    base.min(32_000).saturating_add(jitter)
}

/// Sidecar written next to the `.part` file (`<dest>.part.json`) so a resume
/// survives an app restart. The ETag / Last-Modified pair is the *only*
/// validator sent back as `If-Range` (one validator, never both).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PartSidecar {
    file_id: String,
    total: Option<u64>,
    etag: Option<String>,
    last_modified: Option<String>,
    downloaded: u64,
}

fn part_path_for(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

fn sidecar_path_for(part: &Path) -> PathBuf {
    let mut s = part.as_os_str().to_owned();
    s.push(".json");
    PathBuf::from(s)
}

fn write_sidecar(path: &Path, sidecar: &PartSidecar) {
    if let Ok(json) = serde_json::to_string(sidecar) {
        let _ = std::fs::write(path, json);
    }
}

fn read_sidecar(path: &Path) -> Option<PartSidecar> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Free bytes available on the volume holding `path`, or `None` when the
/// platform cannot answer (the caller then skips the pre-flight check
/// instead of blocking the download on an unknown).
pub fn free_space_available(path: &Path) -> Option<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        let mut free: u64 = 0;
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok != 0 {
            Some(free)
        } else {
            None
        }
    }
    #[cfg(unix)]
    {
        use std::ffi::CString;
        let cpath = CString::new(path.as_os_str().as_encoded_bytes()).ok()?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::statvfs(cpath.as_ptr(), &mut stat) };
        if rc == 0 {
            Some(stat.f_bavail * stat.f_frsize)
        } else {
            None
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        None
    }
}

// ---------------------------------------------------------------------------
// Pause / cancel registry
// ---------------------------------------------------------------------------

/// Shared control for one running download. `paused` is a level (not an
/// edge): the worker re-checks it after every chunk, and `notify` wakes it
/// the moment pause/cancel changes.
pub struct DownloadControl {
    pub cancelled: AtomicBool,
    pub paused: AtomicBool,
    pub notify: Notify,
}

impl DownloadControl {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }
}

static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<DownloadControl>>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Arc<DownloadControl>>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Try to claim `download_id` for a new download. Returns `None` when a
/// download with this id is already running — the start command turns that
/// into `already_in_progress` instead of racing the same `.part` file.
pub fn try_register(download_id: &str) -> Option<Arc<DownloadControl>> {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    if map.contains_key(download_id) {
        return None;
    }
    let control = Arc::new(DownloadControl::new());
    map.insert(download_id.to_string(), control.clone());
    Some(control)
}

/// Signal a running download. Returns `true` when a control existed.
/// `resume` clears `paused`; `pause` sets it; `cancel` sets `cancelled`
/// (and also wakes a paused worker so it can observe the cancel).
pub fn signal_download(download_id: &str, action: DownloadAction) -> bool {
    let control = {
        let map = registry().lock().unwrap_or_else(|e| e.into_inner());
        map.get(download_id).cloned()
    };
    let Some(control) = control else {
        return false;
    };
    match action {
        DownloadAction::Pause => control.paused.store(true, Ordering::SeqCst),
        DownloadAction::Resume => control.paused.store(false, Ordering::SeqCst),
        DownloadAction::Cancel => control.cancelled.store(true, Ordering::SeqCst),
    }
    control.notify.notify_waiters();
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadAction {
    Pause,
    Resume,
    Cancel,
}

fn unregister(download_id: &str) {
    if let Ok(mut map) = registry().lock() {
        map.remove(download_id);
    }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// One download request to the transport: the URL, the current token, and
/// the resume headers (only set when resuming from a non-empty `.part`).
#[derive(Debug, Clone)]
pub struct FetchRequest {
    pub url: String,
    pub token: String,
    pub range_start: Option<u64>,
    /// A single validator for `If-Range`: ETag preferred, Last-Modified
    /// otherwise. `None` when resuming without a known validator.
    pub if_range: Option<String>,
}

/// What the transport hands back. `stream` is `Some` only for 200/206;
/// other statuses carry a short `error_detail` instead (the transport reads
/// the small error body itself so the core never has to).
///
/// No `Debug` derive on purpose: the boxed byte stream has none, and a
/// manual impl would add noise for no diagnostic value.
pub struct FetchedFile {
    pub status: u16,
    /// Full file size: `Content-Length` on a 200, the total in
    /// `Content-Range` on a 206.
    pub total: Option<u64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub accept_ranges: bool,
    pub content_range_start: Option<u64>,
    /// `true` when the body names a Drive usage-limit reason (or the
    /// status is 429): the failure is a rate limit, not a permission error.
    pub rate_limited: bool,
    /// Parsed `Retry-After` seconds, when the server sent one.
    pub retry_after_secs: Option<u64>,
    pub error_detail: Option<String>,
    pub stream: Option<BoxByteStream>,
}

/// Boxed byte stream; boxed so [`FetchedFile`] is nameable in tests and in
/// the download core without leaking the concrete reqwest type.
pub type BoxByteStream =
    std::pin::Pin<Box<dyn Stream<Item = Result<Bytes, FileDownloadError>> + Send + 'static>>;

/// Injected network boundary. One method: open the download URL and hand
/// back its headers + body. Implementations must follow redirects manually
/// (re-applying `Authorization` on every hop) and must map 404/410 to a
/// `FileMissing`-shaped response (status 404/410, no stream), never panic.
pub trait FileTransport: Send + Sync {
    fn fetch<'a>(
        &'a self,
        req: &'a FetchRequest,
    ) -> BoxFuture<'a, Result<FetchedFile, FileDownloadError>>;
}

/// Something that can mint a fresh access token. Production reuses the OS
/// vault + `auth.rs` path the stream proxy uses; tests inject a fixed token.
pub trait TokenRefresher: Send + Sync {
    fn refresh<'a>(&'a self) -> BoxFuture<'a, Result<String, FileDownloadError>>;
}

/// Production token refresher: reads the refresh token from the OS vault and
/// mints through `auth::refresh_google_token`, persisting a rotation
/// best-effort (a failed persist must not fail a mint that already worked).
pub struct ProductionTokenRefresher;

impl TokenRefresher for ProductionTokenRefresher {
    fn refresh<'a>(&'a self) -> BoxFuture<'a, Result<String, FileDownloadError>> {
        Box::pin(async move {
            let stored =
                tauri::async_runtime::spawn_blocking(crate::token_store::get_refresh_token)
                    .await
                    .map_err(|e| FileDownloadError::AuthRefresh {
                        detail: format!("reading the stored sign-in failed: {e}"),
                    })?
                    .map_err(|e| FileDownloadError::AuthRefresh { detail: e })?;
            let refresh_token = stored.ok_or(FileDownloadError::Unauthorized)?;
            let payload = crate::auth::refresh_google_token(refresh_token)
                .await
                .map_err(|e| FileDownloadError::AuthRefresh { detail: e })?;
            let access = payload["access_token"]
                .as_str()
                .ok_or(FileDownloadError::Unauthorized)?
                .to_string();
            if let Some(rotated) = payload["refresh_token"].as_str() {
                let rotated = rotated.to_string();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    crate::token_store::set_refresh_token(rotated)
                })
                .await;
            }
            Ok(access)
        })
    }
}

/// Real transport: `reqwest` over rustls (already in the graph), redirects
/// followed manually so the Bearer token survives cross-origin hops.
pub struct HttpFileTransport {
    client: reqwest::Client,
}

impl HttpFileTransport {
    pub fn new() -> Result<Self, FileDownloadError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| FileDownloadError::Network {
                detail: describe_reqwest(&e),
            })?;
        Ok(Self { client })
    }
}

impl FileTransport for HttpFileTransport {
    fn fetch<'a>(
        &'a self,
        req: &'a FetchRequest,
    ) -> BoxFuture<'a, Result<FetchedFile, FileDownloadError>> {
        Box::pin(async move {
            let mut url = req.url.clone();
            let mut hops = 0u32;
            loop {
                let mut builder = self
                    .client
                    .get(&url)
                    .header("Authorization", format!("Bearer {}", req.token));
                if let Some(start) = req.range_start {
                    builder = builder.header("Range", format!("bytes={start}-"));
                    if let Some(validator) = &req.if_range {
                        builder = builder.header("If-Range", validator.clone());
                    }
                }
                let response = builder
                    .send()
                    .await
                    .map_err(|e| FileDownloadError::Network {
                        detail: describe_reqwest(&e),
                    })?;

                let status = response.status();
                // Manual redirect: resolve (possibly relative) Location
                // against the current URL and re-apply Authorization on the
                // next hop. Google signs the redirect target, but re-applying
                // costs nothing and keeps the behaviour identical for every
                // hop instead of depending on the signature.
                if status.is_redirection() {
                    if hops >= MAX_REDIRECTS {
                        return Err(FileDownloadError::Network {
                            detail: "too many redirects".to_string(),
                        });
                    }
                    let Some(location) = response
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string())
                    else {
                        return Err(FileDownloadError::HttpStatus {
                            status: status.as_u16(),
                        });
                    };
                    let base = url::Url::parse(&url).map_err(|_| FileDownloadError::Network {
                        detail: "the download URL is invalid".to_string(),
                    })?;
                    url = base
                        .join(&location)
                        .map_err(|_| FileDownloadError::Network {
                            detail: "the download redirect is invalid".to_string(),
                        })?
                        .to_string();
                    hops += 1;
                    continue;
                }
                return Ok(response_to_fetched(response).await);
            }
        })
    }
}

/// reqwest errors can embed the full URL (including a signed redirect query
/// string). Only the classification and a short generic cause surface.
fn describe_reqwest(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "request timed out".to_string()
    } else if err.is_connect() {
        "could not connect to Google Drive".to_string()
    } else if err.is_body() || err.is_decode() {
        "the download stream was interrupted".to_string()
    } else if err.is_redirect() {
        "too many redirects".to_string()
    } else if err.is_builder() {
        "the download request could not be built".to_string()
    } else {
        "a network error occurred".to_string()
    }
}

async fn response_to_fetched(response: reqwest::Response) -> FetchedFile {
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let etag = headers
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let last_modified = headers
        .get(reqwest::header::LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let accept_ranges = headers
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim() != "none");
    let (total, content_range_start) = match headers
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
    {
        Some(range) => {
            // `bytes 123-456/789`: total is after the slash, start after the
            // space. A malformed value degrades to "unknown", never panics.
            let (start, total) = range
                .strip_prefix("bytes ")
                .and_then(|rest| rest.split_once('/'))
                .map(|(range_part, total_part)| {
                    (
                        range_part
                            .split_once('-')
                            .and_then(|(s, _)| s.trim().parse().ok()),
                        total_part.trim().parse().ok(),
                    )
                })
                .unwrap_or((None, None));
            (total, start)
        }
        None => (response.content_length(), None),
    };

    if status == 200 || status == 206 {
        let stream = response.bytes_stream().map(|item| {
            item.map_err(|e| FileDownloadError::Network {
                detail: describe_reqwest(&e),
            })
        });
        return FetchedFile {
            status,
            total,
            etag,
            last_modified,
            accept_ranges,
            content_range_start,
            rate_limited: false,
            retry_after_secs: None,
            error_detail: None,
            stream: Some(Box::pin(stream)),
        };
    }

    // Non-2xx: read the (small) error body for the rate-limit reason, then
    // truncate — a Drive error body is JSON, never a file body.
    let body = response.text().await.unwrap_or_default();
    let mut detail: String = body.chars().take(500).collect();
    if detail.is_empty() {
        detail = format!("HTTP {status}");
    }
    let rate_limited = status == 429
        || body.contains("rateLimitExceeded")
        || body.contains("userRateLimitExceeded");
    let retry_after_secs = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_retry_after_secs);
    FetchedFile {
        status,
        total,
        etag,
        last_modified,
        accept_ranges,
        content_range_start,
        rate_limited,
        retry_after_secs,
        error_detail: Some(detail),
        stream: None,
    }
}

// ---------------------------------------------------------------------------
// Progress throttle + speed
// ---------------------------------------------------------------------------

/// Emits progress at most once per [`PROGRESS_MIN_INTERVAL`], or immediately
/// when the whole-percent counter advances. A fabricated percentage is never
/// emitted: when `total` is unknown only the time-based throttle applies.
struct ProgressThrottle {
    last_emit: Instant,
    last_percent: Option<u64>,
    last_downloaded: u64,
    last_speed_at: Instant,
    speed_ewma: Option<f64>,
}

impl ProgressThrottle {
    fn new() -> Self {
        Self {
            last_emit: Instant::now() - PROGRESS_MIN_INTERVAL,
            last_percent: None,
            last_downloaded: 0,
            last_speed_at: Instant::now(),
            speed_ewma: None,
        }
    }

    fn percent_of(downloaded: u64, total: Option<u64>) -> Option<u64> {
        total
            .filter(|t| *t > 0)
            .map(|t| ((downloaded as u128 * 100) / (t as u128)).min(100) as u64)
    }

    /// EWMA of the transfer speed in bytes/second, updated from the bytes
    /// that arrived since the previous tick.
    fn speed(&mut self, downloaded: u64) -> Option<u64> {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_speed_at).as_secs_f64();
        if elapsed <= 0.0 {
            return self.speed_ewma.map(|s| s as u64);
        }
        let delta = downloaded.saturating_sub(self.last_downloaded);
        let instant = delta as f64 / elapsed;
        self.last_speed_at = now;
        self.last_downloaded = downloaded;
        let speed = match self.speed_ewma {
            Some(prev) => 0.7 * prev + 0.3 * instant,
            None => instant,
        };
        self.speed_ewma = Some(speed);
        Some(speed as u64)
    }

    fn should_emit(
        &mut self,
        download_id: &str,
        downloaded: u64,
        total: Option<u64>,
        paused: bool,
    ) -> Option<FileDownloadProgress> {
        let percent = Self::percent_of(downloaded, total);
        let crossed_percent = match (percent, self.last_percent) {
            (Some(now), Some(prev)) => now >= prev + PROGRESS_PERCENT_STEP,
            (Some(_), None) => true,
            (None, _) => false,
        };
        let elapsed = self.last_emit.elapsed() >= PROGRESS_MIN_INTERVAL;
        if !crossed_percent && !elapsed {
            return None;
        }
        self.last_emit = Instant::now();
        self.last_percent = percent;
        let speed = self.speed(downloaded);
        Some(FileDownloadProgress::Downloading {
            download_id: download_id.to_string(),
            downloaded,
            total,
            percent: percent.map(|p| p as u8),
            speed_bytes_per_sec: speed,
            paused,
        })
    }

    fn final_report(
        &mut self,
        download_id: &str,
        downloaded: u64,
        total: Option<u64>,
    ) -> FileDownloadProgress {
        self.last_emit = Instant::now();
        self.last_percent = Self::percent_of(downloaded, total);
        FileDownloadProgress::Downloading {
            download_id: download_id.to_string(),
            downloaded,
            total,
            percent: Self::percent_of(downloaded, total).map(|p| p as u8),
            speed_bytes_per_sec: self.speed(downloaded),
            paused: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Core download
// ---------------------------------------------------------------------------

/// Outcome of one stream attempt: the stream finished, or it failed in a
/// way the attempt loop may retry from the current `.part` length.
enum StreamOutcome {
    Done { downloaded: u64 },
    Retryable(FileDownloadError),
}

/// Runs one download to completion (or a terminal error), driving the
/// transport. Pure with respect to the network: every byte comes through
/// `transport`, every token refresh through `token_source`.
#[allow(clippy::too_many_lines)]
pub async fn download_file(
    transport: &dyn FileTransport,
    token_source: &dyn TokenRefresher,
    req: &FileDownloadRequest,
    control: &Arc<DownloadControl>,
    on_progress: &mut (dyn FnMut(FileDownloadProgress) + Send),
) -> Result<FileDownloadResult, FileDownloadError> {
    let dest = PathBuf::from(&req.dest_path);
    let Some(file_name) = dest.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Err(FileDownloadError::InvalidPath {
            detail: "the destination has no file name".to_string(),
        });
    };
    if file_name.trim().is_empty() {
        return Err(FileDownloadError::InvalidPath {
            detail: "the destination file name is empty".to_string(),
        });
    }
    let parent = dest.parent().ok_or(FileDownloadError::InvalidPath {
        detail: "the destination has no parent directory".to_string(),
    })?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| FileDownloadError::Io {
            detail: format!("create the destination folder: {e}"),
        })?;
    if !parent.is_dir() {
        return Err(FileDownloadError::InvalidPath {
            detail: "the destination parent is not a directory".to_string(),
        });
    }

    // A destination file that is already complete needs no network at all:
    // re-running the same selection skips it instead of re-downloading the
    // whole file and then failing at publish (`std::fs::rename` refuses to
    // replace an existing file on Windows). The gate is size-only by
    // design — hashing a multi-GB file on every re-run would cost more
    // than the re-download it saves — and it only applies when the
    // frontend knew the expected size. A same-named file of a different
    // size is an error, never a silent overwrite.
    if let Ok(meta) = tokio::fs::metadata(&dest).await {
        if meta.is_dir() {
            return Err(FileDownloadError::InvalidPath {
                detail: "the destination is a directory".to_string(),
            });
        }
        match req.expected_size {
            Some(expected) if meta.len() == expected => {
                return Ok(FileDownloadResult {
                    path: dest.to_string_lossy().into_owned(),
                    size: meta.len(),
                    resumed: false,
                });
            }
            _ => {
                return Err(FileDownloadError::AlreadyExists {
                    detail: format!(
                        "\"{}\" already exists",
                        dest.to_string_lossy()
                    ),
                });
            }
        }
    }

    // Pre-flight free-space check: refuse a download that cannot fit
    // instead of failing halfway through a multi-GB transfer.
    if let Some(expected) = req.expected_size {
        if let Some(free) = free_space_available(parent) {
            if free < expected {
                return Err(FileDownloadError::InsufficientSpace {
                    needed: expected,
                    available: free,
                });
            }
        }
    }

    let part = part_path_for(&dest);
    let sidecar_path = sidecar_path_for(&part);

    // --- Resume state -------------------------------------------------------
    // The sidecar is consumed here and dropped: from this point on the only
    // resume state is (offset, etag, last_modified, total).
    let part_len = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let mut offset: u64 = 0;
    let mut resumed = false;
    let mut total: Option<u64> = req.expected_size;
    let mut etag: Option<String> = None;
    let mut last_modified: Option<String> = None;
    if part_len > 0 {
        let s = read_sidecar(&sidecar_path);
        let valid = s.as_ref().map_or(false, |s| {
            s.file_id == req.file_id
                && s.downloaded == part_len
                && s.total.map_or(true, |t| part_len <= t)
                && req
                    .expected_size
                    .map_or(true, |e| s.total.map_or(true, |t| t == e))
        });
        if valid {
            let s = s.expect("sidecar is Some in the valid branch");
            offset = part_len;
            resumed = true;
            total = s.total.or(total);
            etag = s.etag;
            last_modified = s.last_modified;
        } else {
            // A part without a matching sidecar cannot be trusted (wrong
            // file, or a stale prefix): drop it rather than appending to
            // bytes that belong to something else.
            let _ = tokio::fs::remove_file(&part).await;
            let _ = tokio::fs::remove_file(&sidecar_path).await;
        }
    }

    let url = format!("{}/{}?alt=media", DRIVE_FILES_URL, req.file_id);
    let mut token = req.token.clone();
    let mut refreshed = false;
    let mut attempt: u32 = 0;

    loop {
        if control.cancelled.load(Ordering::SeqCst) {
            write_sidecar(
                &sidecar_path,
                &PartSidecar {
                    file_id: req.file_id.clone(),
                    total,
                    etag: etag.clone(),
                    last_modified: last_modified.clone(),
                    downloaded: offset,
                },
            );
            return Err(FileDownloadError::Cancelled);
        }
        attempt += 1;

        let fetch_req = FetchRequest {
            url: url.clone(),
            token: token.clone(),
            range_start: if offset > 0 { Some(offset) } else { None },
            if_range: if offset > 0 {
                etag.clone().or_else(|| last_modified.clone())
            } else {
                None
            },
        };
        let fetched = match transport.fetch(&fetch_req).await {
            Ok(f) => f,
            Err(e) => {
                if e.is_retryable() && attempt < MAX_ATTEMPTS {
                    sleep_with_cancel(control, backoff_delay_ms(attempt, e.retry_after_secs()))
                        .await?;
                    continue;
                }
                return Err(e);
            }
        };

        match fetched.status {
            401 if !refreshed => {
                // One refresh, then continue with a fresh Range request —
                // never re-download bytes already on disk.
                token = token_source.refresh().await?;
                refreshed = true;
                continue;
            }
            401 => return Err(FileDownloadError::Unauthorized),
            404 | 410 => {
                return Err(FileDownloadError::FileMissing {
                    status: fetched.status,
                })
            }
            403 if fetched.rate_limited => {
                let err = FileDownloadError::RateLimited {
                    retry_after_secs: fetched.retry_after_secs,
                };
                if attempt < MAX_ATTEMPTS {
                    sleep_with_cancel(control, backoff_delay_ms(attempt, fetched.retry_after_secs))
                        .await?;
                    continue;
                }
                return Err(err);
            }
            403 => return Err(FileDownloadError::Forbidden { status: 403 }),
            429 => {
                if attempt < MAX_ATTEMPTS {
                    sleep_with_cancel(control, backoff_delay_ms(attempt, fetched.retry_after_secs))
                        .await?;
                    continue;
                }
                return Err(FileDownloadError::RateLimited {
                    retry_after_secs: fetched.retry_after_secs,
                });
            }
            500..=599 => {
                if attempt < MAX_ATTEMPTS {
                    sleep_with_cancel(control, backoff_delay_ms(attempt, None)).await?;
                    continue;
                }
                return Err(FileDownloadError::HttpStatus {
                    status: fetched.status,
                });
            }
            200 | 206 | 416 => {}
            other => return Err(FileDownloadError::HttpStatus { status: other }),
        }

        // The server's own total wins over the metadata estimate for
        // progress; a disagreement with the expected size is a hard failure
        // (the file on Drive changed under us), not something to stream
        // through and discover at the size gate.
        if let Some(server_total) = fetched.total {
            if let Some(expected) = req.expected_size {
                if server_total != expected {
                    return Err(FileDownloadError::SizeMismatch {
                        expected,
                        actual: server_total,
                    });
                }
            }
            total = Some(server_total);
        }
        if offset > 0 {
            if let Some(server_etag) = &fetched.etag {
                if let Some(known_etag) = &etag {
                    if server_etag != known_etag {
                        // The file on Drive changed since the part was
                        // written: the prefix is stale, restart clean.
                        let _ = tokio::fs::remove_file(&part).await;
                        let _ = tokio::fs::remove_file(&sidecar_path).await;
                        offset = 0;
                        resumed = false;
                        etag = None;
                        last_modified = None;
                        if attempt < MAX_ATTEMPTS {
                            continue;
                        }
                        return Err(FileDownloadError::HttpStatus {
                            status: fetched.status,
                        });
                    }
                }
            }
        }
        // Remember the fresh validators for the next attempt / sidecar.
        if fetched.etag.is_some() {
            etag = fetched.etag.clone();
        }
        if fetched.last_modified.is_some() {
            last_modified = fetched.last_modified.clone();
        }

        let action = decide_resume(fetched.status, offset, fetched.content_range_start, total);
        match action {
            ResumeAction::Restart => {
                if offset > 0 {
                    let _ = tokio::fs::remove_file(&part).await;
                    let _ = tokio::fs::remove_file(&sidecar_path).await;
                    offset = 0;
                    resumed = false;
                    etag = None;
                    last_modified = None;
                }
                if fetched.status == 416 {
                    // 416 with nothing resumable: the server has no bytes
                    // for us at all. Retrying the same request loops; fail.
                    return Err(FileDownloadError::HttpStatus { status: 416 });
                }
            }
            ResumeAction::VerifyAndPublish => {
                on_progress(FileDownloadProgress::Verifying {
                    download_id: req.download_id.clone(),
                    downloaded: offset,
                    total,
                });
                return finish_download(&part, &sidecar_path, &dest, req, offset, true).await;
            }
            ResumeAction::Append => {}
        }

        let Some(stream) = fetched.stream else {
            return Err(FileDownloadError::HttpStatus {
                status: fetched.status,
            });
        };

        match stream_into_part(
            stream,
            &part,
            &sidecar_path,
            req,
            total,
            etag.clone(),
            last_modified.clone(),
            offset,
            control,
            on_progress,
        )
        .await
        {
            Ok(StreamOutcome::Done { downloaded }) => {
                offset = downloaded;
                on_progress(FileDownloadProgress::Verifying {
                    download_id: req.download_id.clone(),
                    downloaded: offset,
                    total,
                });
                return finish_download(&part, &sidecar_path, &dest, req, offset, resumed).await;
            }
            Ok(StreamOutcome::Retryable(err)) => {
                // The part on disk already holds the bytes written so far:
                // persist the sidecar now so the next attempt resumes from
                // there instead of restarting (a crash before this write
                // would otherwise orphan the bytes).
                offset = tokio::fs::metadata(&part)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(offset);
                write_sidecar(
                    &sidecar_path,
                    &PartSidecar {
                        file_id: req.file_id.clone(),
                        total,
                        etag: etag.clone(),
                        last_modified: last_modified.clone(),
                        downloaded: offset,
                    },
                );
                if attempt < MAX_ATTEMPTS {
                    sleep_with_cancel(control, backoff_delay_ms(attempt, err.retry_after_secs()))
                        .await?;
                    continue;
                }
                return Err(err);
            }
            Err(err) => return Err(err),
        }
    }
}

/// Sleep for `ms`, waking early when the download is cancelled. A cancel
/// during backoff must surface as [`FileDownloadError::Cancelled`], not as
/// a retry that starts after the user already gave up.
async fn sleep_with_cancel(
    control: &Arc<DownloadControl>,
    ms: u64,
) -> Result<(), FileDownloadError> {
    let sleep = tokio::time::sleep(Duration::from_millis(ms));
    tokio::pin!(sleep);
    loop {
        if control.cancelled.load(Ordering::SeqCst) {
            return Err(FileDownloadError::Cancelled);
        }
        tokio::select! {
            () = control.notify.notified() => {
                if control.cancelled.load(Ordering::SeqCst) {
                    return Err(FileDownloadError::Cancelled);
                }
            }
            () = &mut sleep => return Ok(()),
        }
    }
}

/// Streams one response body into the `.part` file, appending at `offset`.
///
/// Pausing flushes the writer and waits (without holding the stream open in
/// a busy loop); cancelling keeps the part + sidecar for a later resume.
/// The MD5 is NOT folded in here: the finish step re-hashes the completed
/// part file from disk, which is the only way the hash can cover a resumed
/// prefix as well as the bytes of this attempt.
#[allow(clippy::too_many_arguments)]
async fn stream_into_part(
    mut stream: BoxByteStream,
    part: &Path,
    sidecar_path: &Path,
    req: &FileDownloadRequest,
    total: Option<u64>,
    etag: Option<String>,
    last_modified: Option<String>,
    offset: u64,
    control: &Arc<DownloadControl>,
    on_progress: &mut (dyn FnMut(FileDownloadProgress) + Send),
) -> Result<StreamOutcome, FileDownloadError> {
    let file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(part)
        .await
        .map_err(|e| map_io_error("open the partial download file", e))?;
    let mut writer = tokio::io::BufWriter::with_capacity(WRITE_BUF_CAPACITY, file);

    let mut throttle = ProgressThrottle::new();
    let mut downloaded: u64 = offset;
    let mut paused_reported = false;
    on_progress(FileDownloadProgress::Downloading {
        download_id: req.download_id.clone(),
        downloaded,
        total,
        percent: ProgressThrottle::percent_of(downloaded, total).map(|p| p as u8),
        speed_bytes_per_sec: None,
        paused: false,
    });

    loop {
        if control.cancelled.load(Ordering::SeqCst) {
            let _ = writer.flush().await;
            write_sidecar(
                sidecar_path,
                &PartSidecar {
                    file_id: req.file_id.clone(),
                    total,
                    etag: etag.clone(),
                    last_modified: last_modified.clone(),
                    downloaded,
                },
            );
            return Ok(StreamOutcome::Retryable(FileDownloadError::Cancelled));
        }

        if control.paused.load(Ordering::SeqCst) {
            let _ = writer.flush().await;
            write_sidecar(
                sidecar_path,
                &PartSidecar {
                    file_id: req.file_id.clone(),
                    total,
                    etag: etag.clone(),
                    last_modified: last_modified.clone(),
                    downloaded,
                },
            );
            if !paused_reported {
                on_progress(FileDownloadProgress::Downloading {
                    download_id: req.download_id.clone(),
                    downloaded,
                    total,
                    percent: ProgressThrottle::percent_of(downloaded, total).map(|p| p as u8),
                    speed_bytes_per_sec: None,
                    paused: true,
                });
                paused_reported = true;
            }
            // Wait for resume/cancel without spinning; a 250 ms cap keeps
            // a missed notification from parking the worker forever.
            tokio::select! {
                () = control.notify.notified() => {}
                () = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
            if control.paused.load(Ordering::SeqCst) {
                continue;
            }
            paused_reported = false;
            on_progress(FileDownloadProgress::Downloading {
                download_id: req.download_id.clone(),
                downloaded,
                total,
                percent: ProgressThrottle::percent_of(downloaded, total).map(|p| p as u8),
                speed_bytes_per_sec: None,
                paused: false,
            });
            continue;
        }

        let next = tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await;
        let chunk = match next {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_elapsed) => {
                let _ = writer.flush().await;
                return Ok(StreamOutcome::Retryable(FileDownloadError::IdleTimeout));
            }
        };
        let chunk = match chunk {
            Ok(bytes) => bytes,
            Err(e) => {
                let _ = writer.flush().await;
                return Ok(StreamOutcome::Retryable(e));
            }
        };
        writer
            .write_all(&chunk)
            .await
            .map_err(|e| map_io_error("write the partial download file", e))?;
        downloaded += chunk.len() as u64;

        if let Some(progress) = throttle.should_emit(&req.download_id, downloaded, total, false) {
            on_progress(progress);
        }
    }

    writer
        .flush()
        .await
        .map_err(|e| map_io_error("flush the partial download file", e))?;
    // Durability before the publish: the bytes must be on disk, not just in
    // the OS page cache, before the size/MD5 gates run.
    writer
        .get_ref()
        .sync_all()
        .await
        .map_err(|e| map_io_error("sync the partial download file", e))?;
    drop(writer);

    on_progress(throttle.final_report(&req.download_id, downloaded, total));

    Ok(StreamOutcome::Done { downloaded })
}

/// Verifies a completed `.part` file and publishes it as the destination.
///
/// Order: length gate first (cheap, catches truncation), MD5 gate second.
/// A verification failure deletes the part + sidecar so a retry starts
/// clean instead of re-verifying the same bad bytes. A rename failure keeps
/// the part: the bytes are good, only the move failed, and the user can
/// retry the publish without re-downloading.
#[allow(clippy::too_many_arguments)]
async fn finish_download(
    part: &Path,
    sidecar_path: &Path,
    dest: &Path,
    req: &FileDownloadRequest,
    downloaded: u64,
    resumed: bool,
) -> Result<FileDownloadResult, FileDownloadError> {
    // Length gate.
    if let Some(expected) = req.expected_size {
        if downloaded != expected {
            let _ = tokio::fs::remove_file(part).await;
            let _ = tokio::fs::remove_file(sidecar_path).await;
            return Err(FileDownloadError::SizeMismatch {
                expected,
                actual: downloaded,
            });
        }
    }
    // MD5 gate (Drive's md5Checksum, when the frontend could fetch it).
    if let Some(expected_md5) = req.md5.as_deref() {
        let actual_md5 = hash_file_md5(part).await?;
        if actual_md5.to_lowercase() != expected_md5.to_lowercase() {
            let _ = tokio::fs::remove_file(part).await;
            let _ = tokio::fs::remove_file(sidecar_path).await;
            return Err(FileDownloadError::ChecksumMismatch);
        }
    }

    // Publish: rename with retries (Windows AV/indexer can briefly hold a
    // fresh file). The part stays put on failure — the bytes are verified.
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..RENAME_RETRIES {
        match std::fs::rename(part, dest) {
            Ok(()) => {
                let _ = tokio::fs::remove_file(sidecar_path).await;
                return Ok(FileDownloadResult {
                    path: dest.to_string_lossy().into_owned(),
                    size: downloaded,
                    resumed,
                });
            }
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < RENAME_RETRIES {
                    tokio::time::sleep(Duration::from_millis(150 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(FileDownloadError::PublishFailed {
        detail: last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "rename failed".to_string()),
    })
}

/// Lowercase hex MD5 of a whole file, read sequentially in 1 MiB chunks.
async fn hash_file_md5(path: &Path) -> Result<String, FileDownloadError> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| FileDownloadError::Io {
            detail: format!("open the finished download to verify it: {e}"),
        })?;
    let mut hasher = Md5::new();
    let mut buf = vec![0u8; HASH_READ_CHUNK];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| FileDownloadError::Io {
                detail: format!("read the finished download to verify it: {e}"),
            })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    Ok(out)
}

fn map_io_error(action: &str, err: std::io::Error) -> FileDownloadError {
    let detail = match err.kind() {
        ErrorKind::PermissionDenied => format!("{action}: permission denied"),
        ErrorKind::StorageFull => format!("{action}: no space left on device"),
        ErrorKind::NotFound => format!("{action}: path not found"),
        _ => format!("{action}: {err}"),
    };
    FileDownloadError::Io { detail }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Starts a streaming download of one Drive file.
///
/// The command resolves only when the file is on disk (or the download
/// fails / is cancelled); progress arrives over `on_progress` while it
/// runs. The `download_id` is frontend-generated (`crypto.randomUUID()`)
/// and is what pause/resume/cancel address. A second start with an id that
/// is already running fails fast with `already_in_progress` instead of
/// racing the same `.part` file.
#[tauri::command]
pub async fn start_file_download(
    request: FileDownloadRequest,
    on_progress: Channel<FileDownloadProgress>,
) -> Result<FileDownloadResult, String> {
    let download_id = request.download_id.clone();
    // Claim the id first: a second start with an id that is already running
    // fails fast with `already_in_progress` instead of racing the same
    // `.part` file.
    let Some(control) = try_register(&download_id) else {
        return Err(download_error_message(
            &FileDownloadError::AlreadyInProgress,
        ));
    };
    let transport = HttpFileTransport::new().map_err(|e| download_error_message(&e))?;
    let token_source = ProductionTokenRefresher;
    let result = download_file(
        &transport,
        &token_source,
        &request,
        &control,
        &mut |progress| {
            let _ = on_progress.send(progress);
        },
    )
    .await;
    unregister(&download_id);
    result.map_err(|e| download_error_message(&e))
}

/// Pauses a running download (the worker flushes the `.part` file and waits;
/// nothing is deleted). Returns `true` when a download with this id was
/// running. Resuming is [`resume_file_download`].
#[tauri::command]
pub fn pause_file_download(download_id: String) -> Result<bool, String> {
    Ok(signal_download(&download_id, DownloadAction::Pause))
}

/// Resumes a paused download. Returns `true` when a download with this id
/// was running.
#[tauri::command]
pub fn resume_file_download(download_id: String) -> Result<bool, String> {
    Ok(signal_download(&download_id, DownloadAction::Resume))
}

/// Cancels a running download. The `.part` file and its sidecar are kept so
/// a later start with the same destination resumes instead of restarting.
/// Returns `true` when a download with this id was running.
#[tauri::command]
pub fn cancel_file_download(download_id: String) -> Result<bool, String> {
    Ok(signal_download(&download_id, DownloadAction::Cancel))
}

/// Free bytes on the volume holding `dir`, or `null` when the platform
/// cannot answer. The frontend uses it for the pre-flight warning in the
/// download dialog; the start command re-checks the same value itself, so
/// a race between the dialog and the start can only make the warning
/// stale, never the download wrong.
#[tauri::command]
pub fn file_download_free_space(dir: String) -> Result<Option<u64>, String> {
    let path = PathBuf::from(&dir);
    if !path.is_dir() {
        return Err(format!("not a directory: \"{dir}\""));
    }
    Ok(free_space_available(&path))
}

/// Create the destination directory tree for a folder download
/// (`create_dir_all`, so nested subfolders are created in one call).
/// Deliberately a Rust command, not the frontend fs plugin: the
/// capabilities file grants no `fs:allow-mkdir`, and the single-file
/// download already creates its parent the same way inside
/// `download_file`. The root folder is created even when every file in
/// it is skipped, so the user still sees the (empty) folder.
#[tauri::command]
pub fn ensure_download_directory(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if dir.as_os_str().is_empty() {
        return Err("the destination path is empty".to_string());
    }
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create the destination folder: {e}"))?;
    if !dir.is_dir() {
        return Err(format!("the destination is not a directory: \"{path}\""));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;
    use std::sync::atomic::AtomicUsize;

    fn no_progress(_: FileDownloadProgress) {}

    fn req(dest: &Path) -> FileDownloadRequest {
        FileDownloadRequest {
            download_id: "dl-1".to_string(),
            file_id: "file-1".to_string(),
            dest_path: dest.to_string_lossy().into_owned(),
            token: "tok".to_string(),
            expected_size: None,
            md5: None,
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "drplay_file_download_{}_{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test fixture dir must be creatable");
        dir
    }

    /// A transport serving a fixed body with a fixed status, optionally
    /// failing the stream after `fail_after_chunks` chunks.
    struct StubTransport {
        body: Vec<u8>,
        status: u16,
        content_range_start: Option<u64>,
        total: Option<u64>,
        fail_after_chunks: Option<usize>,
        calls: Arc<AtomicUsize>,
    }

    impl StubTransport {
        fn serving(body: Vec<u8>) -> Arc<Self> {
            Arc::new(Self {
                total: Some(body.len() as u64),
                body,
                status: 200,
                content_range_start: None,
                fail_after_chunks: None,
                calls: Arc::new(AtomicUsize::new(0)),
            })
        }
    }

    impl FileTransport for StubTransport {
        fn fetch<'a>(
            &'a self,
            req: &'a FetchRequest,
        ) -> BoxFuture<'a, Result<FetchedFile, FileDownloadError>> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let body = self.body.clone();
            let status = self.status;
            let total = self.total;
            let start = self.content_range_start;
            let fail_after = self.fail_after_chunks;
            // A ranged request against a 200-only stub simulates a server
            // that ignores Range: the stub answers 200 with the whole body.
            let effective_status = if req.range_start.is_some() && status == 200 {
                200
            } else {
                status
            };
            Box::pin(async move {
                let _ = call;
                let stream: BoxByteStream = if effective_status == 200 || effective_status == 206 {
                    let chunks: Vec<Result<Bytes, FileDownloadError>> = body
                        .chunks(4)
                        .enumerate()
                        .map(|(i, c)| {
                            if let Some(limit) = fail_after {
                                if i >= limit {
                                    return Err(FileDownloadError::Network {
                                        detail: "stub stream cut".to_string(),
                                    });
                                }
                            }
                            Ok(Bytes::copy_from_slice(c))
                        })
                        .collect();
                    Box::pin(stream::iter(chunks))
                } else {
                    Box::pin(stream::empty())
                };
                Ok(FetchedFile {
                    status: effective_status,
                    total,
                    etag: Some("\"etag-1\"".to_string()),
                    last_modified: None,
                    accept_ranges: true,
                    content_range_start: start,
                    rate_limited: false,
                    retry_after_secs: None,
                    error_detail: None,
                    stream: if effective_status == 200 || effective_status == 206 {
                        Some(stream)
                    } else {
                        None
                    },
                })
            })
        }
    }

    struct FixedToken;
    impl TokenRefresher for FixedToken {
        fn refresh<'a>(&'a self) -> BoxFuture<'a, Result<String, FileDownloadError>> {
            Box::pin(async move { Ok("fresh-tok".to_string()) })
        }
    }

    // --- decide_resume ------------------------------------------------------

    #[test]
    fn resume_table_206_200_416() {
        // 206 starting exactly at our offset appends.
        assert_eq!(
            decide_resume(206, 100, Some(100), Some(1000)),
            ResumeAction::Append
        );
        // 206 starting anywhere else restarts — appending it would corrupt.
        assert_eq!(
            decide_resume(206, 100, Some(0), Some(1000)),
            ResumeAction::Restart
        );
        assert_eq!(
            decide_resume(206, 100, None, Some(1000)),
            ResumeAction::Restart
        );
        // 200 with an empty part is a normal fresh download.
        assert_eq!(
            decide_resume(200, 0, None, Some(1000)),
            ResumeAction::Append
        );
        // 200 after a Range request means the server ignored the range:
        // appending the whole body to a partial file would corrupt it.
        assert_eq!(
            decide_resume(200, 100, None, Some(1000)),
            ResumeAction::Restart
        );
        // 416 with a complete part goes straight to verification.
        assert_eq!(
            decide_resume(416, 1000, None, Some(1000)),
            ResumeAction::VerifyAndPublish
        );
        // 416 with an incomplete part restarts.
        assert_eq!(
            decide_resume(416, 100, None, Some(1000)),
            ResumeAction::Restart
        );
        assert_eq!(
            decide_resume(416, 0, None, Some(1000)),
            ResumeAction::Restart
        );
    }

    #[test]
    fn content_range_parsing() {
        assert_eq!(parse_content_range_start("bytes 123-456/789"), Some(123));
        assert_eq!(parse_content_range_start("bytes 0-0/1"), Some(0));
        assert_eq!(parse_content_range_start("bytes */789"), None);
        assert_eq!(parse_content_range_start("garbage"), None);
    }

    #[test]
    fn backoff_is_bounded_and_retry_after_wins() {
        assert_eq!(backoff_delay_ms(0, Some(5)), 5_000);
        assert_eq!(
            backoff_delay_ms(0, Some(99)),
            32_000,
            "Retry-After is capped at 32 s"
        );
        let first = backoff_delay_ms(0, None);
        assert!(
            (1_000..=2_000).contains(&first),
            "attempt 0 is ~1 s + jitter: {first}"
        );
        let late = backoff_delay_ms(10, None);
        assert!(
            (32_000..=33_000).contains(&late),
            "backoff caps at 32 s + jitter: {late}"
        );
    }

    #[test]
    fn error_codes_are_stable_slugs() {
        assert_eq!(FileDownloadError::Cancelled.code(), "cancelled");
        assert_eq!(
            FileDownloadError::ChecksumMismatch.code(),
            "checksum_mismatch"
        );
        assert_eq!(
            FileDownloadError::InsufficientSpace {
                needed: 1,
                available: 0
            }
            .code(),
            "insufficient_space"
        );
        assert_eq!(
            download_error_message(&FileDownloadError::FileMissing { status: 404 }),
            "file_missing: the file is no longer available on Google Drive (HTTP 404)"
        );
        assert!(!FileDownloadError::ChecksumMismatch.is_retryable());
        assert!(!FileDownloadError::Cancelled.is_retryable());
        assert!(FileDownloadError::IdleTimeout.is_retryable());
        assert!(FileDownloadError::Network { detail: "x".into() }.is_retryable());
    }

    #[test]
    fn free_space_answers_for_a_real_directory() {
        let dir = temp_dir("free_space");
        let free = free_space_available(&dir);
        assert!(free.is_some(), "a real temp dir must report free space");
        assert!(free.unwrap() > 0, "free space must be positive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn progress_never_fabricates_a_percentage() {
        let known = FileDownloadProgress::Downloading {
            download_id: "d".into(),
            downloaded: 25,
            total: Some(100),
            percent: None,
            speed_bytes_per_sec: None,
            paused: false,
        };
        assert_eq!(known.percent(), Some(25));
        let unknown = FileDownloadProgress::Downloading {
            download_id: "d".into(),
            downloaded: 25,
            total: None,
            percent: None,
            speed_bytes_per_sec: None,
            paused: false,
        };
        assert_eq!(unknown.percent(), None);
        let json = serde_json::to_string(&unknown).unwrap();
        assert_eq!(
            json, r#"{"stage":"downloading","downloadId":"d","downloaded":25,"paused":false}"#,
            "unknown total/percent/speed must be absent, never zero"
        );
    }

    // --- end-to-end through the stub transport ------------------------------

    #[tokio::test]
    async fn whole_file_streams_to_disk_and_publishes() {
        let dir = temp_dir("whole");
        let dest = dir.join("song.mp3");
        let body = b"a small but genuine media payload".to_vec();
        let mut r = req(&dest);
        r.expected_size = Some(body.len() as u64);
        // Correct MD5 for the body.
        let mut hasher = Md5::new();
        hasher.update(&body);
        let mut hex = String::new();
        for b in hasher.finalize() {
            hex.push_str(&format!("{b:02x}"));
        }
        r.md5 = Some(hex);

        let transport = StubTransport::serving(body.clone());
        let control = Arc::new(DownloadControl::new());
        let mut seen = Vec::new();
        let out = download_file(&*transport, &FixedToken, &r, &control, &mut |p| {
            seen.push(p)
        })
        .await
        .expect("a matching stub download must succeed");

        assert_eq!(out.path, dest.to_string_lossy());
        assert_eq!(out.size, body.len() as u64);
        assert!(!out.resumed);
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert!(
            !part_path_for(&dest).exists(),
            "no .part file may survive success"
        );
        assert!(!sidecar_path_for(&part_path_for(&dest)).exists());
        assert!(!seen.is_empty());
        let last = seen
            .iter()
            .rev()
            .find(|p| matches!(p, FileDownloadProgress::Downloading { .. }))
            .unwrap();
        assert_eq!(last.percent(), Some(100));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn existing_complete_destination_is_skipped_without_network() {
        // Re-running the same selection must not re-download a file that is
        // already on disk at the expected size: the transport is never
        // called (calls stays 0) and the result reports the existing size.
        let dir = temp_dir("skip-complete");
        let dest = dir.join("song.mp3");
        let body = b"already here".to_vec();
        std::fs::write(&dest, &body).unwrap();
        let mut r = req(&dest);
        r.expected_size = Some(body.len() as u64);

        let transport = StubTransport::serving(b"different bytes".to_vec());
        let calls = Arc::clone(&transport.calls);
        let control = Arc::new(DownloadControl::new());
        let out = download_file(&*transport, &FixedToken, &r, &control, &mut no_progress)
            .await
            .expect("a complete destination must be skipped, not re-downloaded");
        assert_eq!(out.path, dest.to_string_lossy());
        assert_eq!(out.size, body.len() as u64);
        assert_eq!(calls.load(Ordering::SeqCst), 0, "no bytes may move");
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn existing_destination_with_wrong_size_is_an_error_not_an_overwrite() {
        let dir = temp_dir("skip-wrong-size");
        let dest = dir.join("song.mp3");
        std::fs::write(&dest, b"short").unwrap();
        let mut r = req(&dest);
        r.expected_size = Some(100);

        let transport = StubTransport::serving(vec![0u8; 100]);
        let control = Arc::new(DownloadControl::new());
        let err = download_file(&*transport, &FixedToken, &r, &control, &mut no_progress)
            .await
            .expect_err("a same-named file of a different size must fail");
        assert!(
            matches!(err, FileDownloadError::AlreadyExists { .. }),
            "{err:?}"
        );
        // The user's file is untouched.
        assert_eq!(std::fs::read(&dest).unwrap(), b"short");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn existing_destination_directory_is_an_invalid_path() {
        let dir = temp_dir("skip-is-dir");
        let dest = dir.join("song.mp3");
        std::fs::create_dir_all(&dest).unwrap();
        let mut r = req(&dest);
        r.expected_size = Some(10);

        let transport = StubTransport::serving(vec![0u8; 10]);
        let control = Arc::new(DownloadControl::new());
        let err = download_file(&*transport, &FixedToken, &r, &control, &mut no_progress)
            .await
            .expect_err("a directory at the destination must fail");
        assert!(
            matches!(err, FileDownloadError::InvalidPath { .. }),
            "{err:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn checksum_mismatch_deletes_the_part_file() {
        let dir = temp_dir("checksum");
        let dest = dir.join("song.mp3");
        let body = vec![0xABu8; 64];
        let mut r = req(&dest);
        r.expected_size = Some(64);
        r.md5 = Some("00000000000000000000000000000000".to_string());

        let transport = StubTransport::serving(body);
        let control = Arc::new(DownloadControl::new());
        let err = download_file(&*transport, &FixedToken, &r, &control, &mut no_progress)
            .await
            .expect_err("a wrong MD5 must fail");
        assert!(
            matches!(err, FileDownloadError::ChecksumMismatch),
            "{err:?}"
        );
        assert!(!dest.exists());
        assert!(
            !part_path_for(&dest).exists(),
            "a bad download must not leave a .part file"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn size_mismatch_is_reported() {
        let dir = temp_dir("size");
        let dest = dir.join("song.mp3");
        let body = vec![7u8; 32];
        let mut r = req(&dest);
        r.expected_size = Some(33);

        let transport = StubTransport::serving(body);
        let control = Arc::new(DownloadControl::new());
        let err = download_file(&*transport, &FixedToken, &r, &control, &mut no_progress)
            .await
            .expect_err("a short payload must fail the size gate");
        assert!(
            matches!(
                err,
                FileDownloadError::SizeMismatch {
                    expected: 33,
                    actual: 32
                }
            ),
            "{err:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_cut_stream_is_retried_from_the_part_length() {
        let dir = temp_dir("retry");
        let dest = dir.join("song.mp3");
        let body: Vec<u8> = (0..40u8).collect();
        let mut r = req(&dest);
        r.expected_size = Some(40);

        // First attempt serves 200 and dies after 2 chunks (8 bytes); the
        // retry must resume with Range instead of restarting.
        let failing = Arc::new(StubTransport {
            body: body.clone(),
            status: 200,
            content_range_start: None,
            total: Some(40),
            fail_after_chunks: Some(2),
            calls: Arc::new(AtomicUsize::new(0)),
        });
        let control = Arc::new(DownloadControl::new());
        let err = download_file(&*failing, &FixedToken, &r, &control, &mut no_progress).await;
        // The stub always fails the same way, so after MAX_ATTEMPTS the
        // download gives up — but the .part file must hold the 8 bytes.
        assert!(
            err.is_err(),
            "a permanently failing stub must eventually fail"
        );
        assert_eq!(std::fs::read(part_path_for(&dest)).unwrap().len(), 8);

        // A healthy 206 transport resumes from those 8 bytes.
        let mut resumed_body = body.clone();
        let prefix = resumed_body.drain(..8).collect::<Vec<u8>>();
        assert_eq!(prefix.len(), 8);
        let transport = Arc::new(StubTransport {
            body: resumed_body,
            status: 206,
            content_range_start: Some(8),
            total: Some(40),
            fail_after_chunks: None,
            calls: Arc::new(AtomicUsize::new(0)),
        });
        let out = download_file(&*transport, &FixedToken, &r, &control, &mut no_progress)
            .await
            .expect("a 206 resume must complete the file");
        assert!(out.resumed);
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn insufficient_space_is_refused_before_any_network() {
        let dir = temp_dir("space");
        let dest = dir.join("huge.mp3");
        let mut r = req(&dest);
        r.expected_size = Some(u64::MAX);

        let transport = StubTransport::serving(vec![1, 2, 3]);
        let control = Arc::new(DownloadControl::new());
        let err = download_file(&*transport, &FixedToken, &r, &control, &mut no_progress)
            .await
            .expect_err("an impossible size must be refused up front");
        assert!(
            matches!(err, FileDownloadError::InsufficientSpace { .. }),
            "{err:?}"
        );
        assert_eq!(
            transport.calls.load(Ordering::SeqCst),
            0,
            "no request may be sent"
        );
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancel_keeps_the_part_file_for_resume() {
        let dir = temp_dir("cancel");
        let dest = dir.join("song.mp3");
        let body: Vec<u8> = (0..64u8).collect();
        let mut r = req(&dest);
        r.expected_size = Some(64);

        // A transport whose stream yields one chunk and then never yields
        // another: the worker parks until it is cancelled (the 30 s idle
        // timeout is the only other exit, and the test cancels first).
        struct HangingTransport {
            body: Vec<u8>,
        }
        impl FileTransport for HangingTransport {
            fn fetch<'a>(
                &'a self,
                _req: &'a FetchRequest,
            ) -> BoxFuture<'a, Result<FetchedFile, FileDownloadError>> {
                let first = Bytes::copy_from_slice(&self.body[..4]);
                let stream: BoxByteStream =
                    Box::pin(stream::iter([Ok(first)]).chain(stream::pending()));
                Box::pin(async move {
                    Ok(FetchedFile {
                        status: 200,
                        total: Some(64),
                        etag: Some("\"etag-1\"".to_string()),
                        last_modified: None,
                        accept_ranges: true,
                        content_range_start: None,
                        rate_limited: false,
                        retry_after_secs: None,
                        error_detail: None,
                        stream: Some(stream),
                    })
                })
            }
        }

        let transport = Arc::new(HangingTransport { body });
        let control = Arc::new(DownloadControl::new());
        let control2 = control.clone();
        let handle = tokio::spawn(async move {
            download_file(&*transport, &FixedToken, &r, &control2, &mut no_progress).await
        });
        // Let the first chunk land, then cancel.
        tokio::time::sleep(Duration::from_millis(100)).await;
        control.cancelled.store(true, Ordering::SeqCst);
        control.notify.notify_waiters();
        let err = handle
            .await
            .expect("the task must join")
            .expect_err("cancel must fail the download");
        assert!(matches!(err, FileDownloadError::Cancelled), "{err:?}");
        assert!(
            part_path_for(&dest).exists(),
            "cancel must keep the .part file"
        );
        assert!(
            sidecar_path_for(&part_path_for(&dest)).exists(),
            "cancel must keep the sidecar"
        );
        assert_eq!(
            std::fs::read(part_path_for(&dest)).unwrap().len(),
            4,
            "one 4-byte chunk landed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_download_directory_creates_nested_tree() {
        let dir = temp_dir("ensure_dir");
        let nested = dir.join("Root").join("Sub").join("Deep");
        ensure_download_directory(nested.to_string_lossy().into_owned())
            .expect("nested folders must be created");
        assert!(nested.is_dir());
        // Idempotent: creating an existing tree is a no-op, not an error.
        ensure_download_directory(nested.to_string_lossy().into_owned())
            .expect("re-creating an existing folder must succeed");
        assert!(ensure_download_directory(String::new()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
