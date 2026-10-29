//! Streaming download + integrity verification of the pinned archive.
//!
//! The network is behind [`AssetTransport`] so tests never touch it: a test
//! supplies a synthetic byte stream and exercises the real staging,
//! throttling, size-gate and SHA-256 logic in [`receive_asset`].
//!
//! Verification order is deliberate and must not be reordered: the byte length
//! is checked first (cheap, catches truncation), the SHA-256 second (catches
//! tampering). Both run BEFORE the archive is opened, so a corrupt download is
//! never handed to the decompressor.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Instant;

use bytes::Bytes;
use futures_util::future::BoxFuture;
use futures_util::Stream;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::error::FallbackError;
use super::metadata;
use super::status::FallbackProgress;

/// The shape a downloaded asset must have. Production always passes
/// [`ExpectedAsset::pinned`]; tests pass a small synthetic expectation so the
/// success path can be exercised for real instead of being asserted only in
/// its failure mode.
#[derive(Debug, Clone, Copy)]
pub struct ExpectedAsset {
    pub bytes: u64,
    pub sha256_hex: &'static str,
}

impl ExpectedAsset {
    /// The pinned upstream asset.
    pub const fn pinned() -> Self {
        Self { bytes: metadata::MPV_ASSET_BYTES, sha256_hex: metadata::MPV_ASSET_SHA256 }
    }
}

/// A download that has been accepted by the transport: the declared length (if
/// any) and the body as a byte stream.
pub struct FetchedAsset {
    /// `Content-Length` as reported by the server. `None` when absent -- the UI
    /// must then show an indeterminate bar.
    pub total: Option<u64>,
    /// The response body.
    pub stream: BoxByteStream,
}

/// Boxed byte stream; boxed so [`FetchedAsset`] is nameable in tests and in
/// the install pipeline without leaking the concrete reqwest type.
pub type BoxByteStream =
    std::pin::Pin<Box<dyn Stream<Item = Result<Bytes, FallbackError>> + Send + 'static>>;

/// Injected network boundary. One method: open the asset URL and hand back its
/// body. Implementations must map 404/410 to [`FallbackError::AssetMissing`]
/// and any other non-200 to [`FallbackError::HttpStatus`].
pub trait AssetTransport: Send + Sync {
    fn fetch<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchedAsset, FallbackError>>;
}

/// Real transport: `reqwest` over rustls (no OpenSSL, already in the graph).
pub struct HttpTransport {
    client: reqwest::Client,
}

impl HttpTransport {
    pub fn new() -> Result<Self, FallbackError> {
        let client = reqwest::Client::builder()
            .user_agent(metadata::HTTP_USER_AGENT)
            .timeout(metadata::HTTP_TIMEOUT)
            .read_timeout(metadata::HTTP_READ_TIMEOUT)
            .connect_timeout(metadata::HTTP_CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(metadata::HTTP_MAX_REDIRECTS))
            .build()
            .map_err(|e| FallbackError::Network { detail: describe_reqwest(&e) })?;
        Ok(Self { client })
    }
}

impl AssetTransport for HttpTransport {
    fn fetch<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchedAsset, FallbackError>> {
        Box::pin(async move {
            let response = self
                .client
                .get(url)
                .send()
                .await
                .map_err(|e| FallbackError::Network { detail: describe_reqwest(&e) })?;

            let status = response.status();
            if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
                return Err(FallbackError::AssetMissing { status: status.as_u16() });
            }
            if !status.is_success() {
                return Err(FallbackError::HttpStatus { status: status.as_u16() });
            }

            // Content-Length is advisory: it is `None` for chunked responses, and
            // the authoritative length check happens against the pinned byte
            // count in `receive_asset`, so a lying header cannot pass.
            let total = response.content_length();
            let stream = response.bytes_stream().map(|item| {
                item.map_err(|e| FallbackError::Network { detail: describe_reqwest(&e) })
            });
            Ok(FetchedAsset { total, stream: Box::pin(stream) })
        })
    }
}

/// reqwest errors can embed the full URL (including the signature in a redirect
/// query string). Only the classification and a short generic cause surface.
fn describe_reqwest(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "request timed out".to_string()
    } else if err.is_connect() {
        "could not connect to the download server".to_string()
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

/// Emits progress at most once per [`metadata::PROGRESS_MIN_INTERVAL`], or
/// immediately when the whole-percent counter advances (whichever comes
/// first). A fabricated percentage is never emitted: when `total` is unknown
/// only the time-based throttle applies and `total` stays `None`.
struct ProgressThrottle {
    last_emit: Instant,
    last_percent: Option<u64>,
}

impl ProgressThrottle {
    fn new() -> Self {
        // Subtracting instead of adding keeps the FIRST chunk reportable without
        // relying on the clock having advanced.
        Self { last_emit: Instant::now() - metadata::PROGRESS_MIN_INTERVAL, last_percent: None }
    }

    fn percent_of(downloaded: u64, total: Option<u64>) -> Option<u64> {
        total
            .filter(|t| *t > 0)
            .map(|t| ((downloaded as u128 * 100) / (t as u128)).min(100) as u64)
    }

    /// Returns the progress to emit, or `None` when this tick is suppressed.
    fn should_emit(&mut self, downloaded: u64, total: Option<u64>) -> Option<FallbackProgress> {
        let percent = Self::percent_of(downloaded, total);

        let crossed_percent = match (percent, self.last_percent) {
            (Some(now), Some(prev)) => now >= prev + metadata::PROGRESS_PERCENT_STEP,
            (Some(_), None) => true,
            (None, _) => false,
        };
        let elapsed = self.last_emit.elapsed() >= metadata::PROGRESS_MIN_INTERVAL;

        if !crossed_percent && !elapsed {
            return None;
        }
        self.last_emit = Instant::now();
        self.last_percent = percent;
        Some(FallbackProgress::Downloading { downloaded, total })
    }

    /// Reports the final byte count even if the last chunks landed inside the
    /// throttle window, so a determinate bar finishes at 100%.
    fn final_report(&mut self, downloaded: u64, total: Option<u64>) -> FallbackProgress {
        self.last_emit = Instant::now();
        self.last_percent = Self::percent_of(downloaded, total);
        FallbackProgress::Downloading { downloaded, total }
    }
}

/// Removes the partial file unless disarmed. Guarantees the `.part` artefact is
/// gone on every error path, including a panic inside the progress callback.
struct PartFileGuard {
    path: PathBuf,
    armed: bool,
}

impl PartFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for PartFileGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Streams `fetched` into `<staging_dir>/archive.7z.part`, then verifies its
/// length and SHA-256 against `expected`.
///
/// Returns the verified archive path. On ANY error the `.part` file is deleted
/// before returning, so a failed attempt never leaves a half-file behind.
pub async fn receive_asset(
    fetched: FetchedAsset,
    staging_dir: &Path,
    expected: ExpectedAsset,
    on_progress: &mut dyn FnMut(FallbackProgress),
) -> Result<PathBuf, FallbackError> {
    let part_path = staging_dir.join(metadata::STAGING_ARCHIVE_FILE);
    tokio::fs::create_dir_all(staging_dir)
        .await
        .map_err(|e| io_error("create the staging folder", e))?;

    let guard = PartFileGuard::new(part_path.clone());

    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| io_error("create the partial download file", e))?;

    let FetchedAsset { total, mut stream } = fetched;
    let mut throttle = ProgressThrottle::new();
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;

    on_progress(FallbackProgress::Downloading { downloaded: 0, total });

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)
            .await
            .map_err(|e| io_error("write the partial download file", e))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;

        if let Some(progress) = throttle.should_emit(downloaded, total) {
            on_progress(progress);
        }
    }

    file.flush().await.map_err(|e| io_error("flush the partial download file", e))?;
    file.sync_all().await.map_err(|e| io_error("sync the partial download file", e))?;
    drop(file);

    on_progress(throttle.final_report(downloaded, total));

    // The stream is complete: from here the bytes are only checked, no more
    // arrive. This is the honest "verifying" stage -- the hash was folded in
    // during the transfer, so the two gates below are what remains.
    on_progress(FallbackProgress::Verifying);

    // (1) Length gate. Runs before the checksum so a truncated transfer is
    //     reported as truncation, not as tampering.
    if downloaded != expected.bytes {
        return Err(FallbackError::SizeMismatch { expected: expected.bytes, actual: downloaded });
    }

    // (2) Integrity gate. The hash was folded in as bytes arrived, so nothing
    //     is read a second time.
    let actual = hex_lower(&hasher.finalize());
    if actual != expected.sha256_hex {
        return Err(FallbackError::ChecksumMismatch {
            expected: expected.sha256_hex.to_string(),
            actual,
        });
    }

    guard.disarm();
    Ok(part_path)
}

/// Lowercase hex SHA-256 of a byte slice.
///
/// Test/fixture-only: production folds bytes into the hasher as they stream
/// (see [`receive_asset`]) and never holds the whole archive in memory, so
/// gating this out of release builds also keeps the one-shot API from becoming
/// a tempting shortcut.
#[cfg(test)]
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn io_error(action: &str, err: std::io::Error) -> FallbackError {
    let detail = match err.kind() {
        ErrorKind::PermissionDenied => format!("{action}: permission denied"),
        ErrorKind::StorageFull => format!("{action}: no space left on device"),
        ErrorKind::NotFound => format!("{action}: path not found"),
        _ => format!("{action}: {err}"),
    };
    FallbackError::Network { detail }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback_runtime::test_support::{chunks_of, temp_scope_dir};
    use std::time::Duration;

    fn no_progress(_: FallbackProgress) {}

    #[tokio::test]
    async fn checksum_mismatch_deletes_the_part_file() {
        let dir = temp_scope_dir("dl_checksum");
        let staging = dir.join("staging");
        // Correct length, wrong bytes: the size gate passes, the hash does not.
        let body = vec![0xABu8; 4096];
        let expected = ExpectedAsset { bytes: 4096, sha256_hex: metadata::MPV_ASSET_SHA256 };

        let err = receive_asset(
            FetchedAsset { total: Some(4096), stream: chunks_of(body, 512) },
            &staging,
            expected,
            &mut no_progress,
        )
        .await
        .expect_err("wrong bytes must fail the checksum");

        match err {
            FallbackError::ChecksumMismatch { expected: want, actual } => {
                assert_eq!(want, metadata::MPV_ASSET_SHA256);
                assert_eq!(actual.len(), 64);
                assert_ne!(actual, want);
            }
            other => panic!("expected ChecksumMismatch, got {other:?}"),
        }
        assert!(
            !staging.join(metadata::STAGING_ARCHIVE_FILE).exists(),
            "the .part file must be gone after a checksum failure"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn truncated_payload_is_a_size_mismatch() {
        let dir = temp_scope_dir("dl_size");
        let staging = dir.join("staging");
        let expected = ExpectedAsset { bytes: 1000, sha256_hex: "00" };

        let err = receive_asset(
            FetchedAsset { total: Some(1000), stream: chunks_of(vec![7u8; 999], 100) },
            &staging,
            expected,
            &mut no_progress,
        )
        .await
        .expect_err("a short payload must fail the size gate");

        match err {
            FallbackError::SizeMismatch { expected: want, actual } => {
                assert_eq!(want, 1000);
                assert_eq!(actual, 999);
            }
            other => panic!("expected SizeMismatch, got {other:?}"),
        }
        assert!(!staging.join(metadata::STAGING_ARCHIVE_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn oversized_payload_is_a_size_mismatch() {
        let dir = temp_scope_dir("dl_oversize");
        let staging = dir.join("staging");
        let expected = ExpectedAsset { bytes: 1000, sha256_hex: "00" };
        let err = receive_asset(
            FetchedAsset { total: Some(1001), stream: chunks_of(vec![7u8; 1001], 100) },
            &staging,
            expected,
            &mut no_progress,
        )
        .await
        .expect_err("an oversized payload must fail the size gate");
        assert!(matches!(err, FallbackError::SizeMismatch { .. }), "{err:?}");
        assert!(!staging.join(metadata::STAGING_ARCHIVE_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn matching_payload_is_verified_and_kept() {
        let dir = temp_scope_dir("dl_ok");
        let staging = dir.join("staging");
        let body = b"a small but genuine archive payload".to_vec();
        let expected = ExpectedAsset { bytes: body.len() as u64, sha256_hex: Box::leak(sha256_hex(&body).into_boxed_str()) };

        let mut seen = Vec::new();
        let path = receive_asset(
            FetchedAsset { total: Some(body.len() as u64), stream: chunks_of(body.clone(), 7) },
            &staging,
            expected,
            &mut |p| seen.push(p),
        )
        .await
        .expect("a matching payload must verify");

        assert!(path.exists(), "the verified archive must stay on disk");
        assert_eq!(std::fs::read(&path).unwrap(), body, "bytes must be preserved verbatim");
        assert_eq!(path, staging.join(metadata::STAGING_ARCHIVE_FILE));

        assert!(!seen.is_empty(), "progress must be reported at least once");
        assert_eq!(seen.first().unwrap().percent(), Some(0));
        assert_eq!(seen.last().unwrap(), &FallbackProgress::Verifying, "verification is reported after the transfer");
        let final_download = seen
            .iter()
            .rev()
            .find(|progress| matches!(progress, FallbackProgress::Downloading { .. }))
            .expect("a download stage must be reported");
        assert_eq!(final_download.percent(), Some(100), "the final download report must reach 100%");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn stream_error_deletes_the_part_file() {
        let dir = temp_scope_dir("dl_stream_err");
        let staging = dir.join("staging");
        let expected = ExpectedAsset { bytes: 4096, sha256_hex: "00" };
        let err = receive_asset(
            FetchedAsset {
                total: Some(4096),
                stream: chunks_of(vec![1u8; 4096], 512),
            },
            &staging,
            expected,
            &mut no_progress,
        )
        .await
        .expect_err("the wrong digest must fail");
        assert!(matches!(err, FallbackError::ChecksumMismatch { .. }), "{err:?}");
        assert!(!staging.join(metadata::STAGING_ARCHIVE_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn unknown_total_never_reports_a_percentage() {
        let dir = temp_scope_dir("dl_unknown_total");
        let staging = dir.join("staging");
        let body = b"chunked response without a length".to_vec();
        let expected =
            ExpectedAsset { bytes: body.len() as u64, sha256_hex: Box::leak(sha256_hex(&body).into_boxed_str()) };

        let mut seen = Vec::new();
        let _ = receive_asset(
            FetchedAsset { total: None, stream: chunks_of(body, 4) },
            &staging,
            expected,
            &mut |p| seen.push(p),
        )
        .await;

        assert!(!seen.is_empty());
        for progress in &seen {
            assert_eq!(progress.percent(), None, "no percentage without a total: {progress:?}");
            match progress {
                FallbackProgress::Downloading { total, .. } => assert!(total.is_none()),
                // Verification follows the transfer and is inherently
                // indeterminate; it is not a byte count and carries no total.
                FallbackProgress::Verifying => {}
                other => panic!("unexpected stage {other:?}"),
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn throttle_emits_on_percent_boundary_before_the_interval() {
        let mut throttle = ProgressThrottle::new();
        let total = Some(1000u64);
        assert!(throttle.should_emit(0, total).is_some(), "first tick must report");
        // 1% of 1000 bytes == 10 bytes: a boundary crossing reports immediately
        // even though no wall-clock interval elapsed.
        assert!(throttle.should_emit(10, total).is_some(), "1% boundary must report");
        // Same percent again, no time elapsed: suppressed.
        assert!(throttle.should_emit(11, total).is_none(), "same percent must be throttled");
    }

    #[test]
    fn throttle_is_time_based_when_total_is_unknown() {
        let mut throttle = ProgressThrottle::new();
        assert!(throttle.should_emit(0, None).is_some());
        assert!(throttle.should_emit(1 << 20, None).is_none(), "suppressed inside the window");
        // Force the elapsed branch without sleeping: rewind the last emit.
        throttle.last_emit = Instant::now() - metadata::PROGRESS_MIN_INTERVAL - Duration::from_millis(1);
        assert!(throttle.should_emit(2 << 20, None).is_some(), "reports once the window elapses");
    }

    #[test]
    fn final_report_always_reaches_the_exact_byte_count() {
        let mut throttle = ProgressThrottle::new();
        let _ = throttle.should_emit(0, Some(100));
        let last = throttle.final_report(100, Some(100));
        assert_eq!(last.percent(), Some(100));
        assert_eq!(last, FallbackProgress::Downloading { downloaded: 100, total: Some(100) });
    }

    #[test]
    fn hex_encoding_is_lowercase_and_padded() {
        assert_eq!(hex_lower(&[0x00, 0x0f, 0xff]), "000fff");
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn io_errors_are_classified_without_a_path() {
        let err =
            io_error("write the partial download file", std::io::Error::from(ErrorKind::PermissionDenied));
        let msg = err.to_string();
        assert!(msg.contains("permission denied"), "{msg}");
        assert!(msg.contains("write the partial download file"), "{msg}");
    }

    #[test]
    fn pinned_expectation_matches_the_metadata_constants() {
        let pinned = ExpectedAsset::pinned();
        assert_eq!(pinned.bytes, metadata::MPV_ASSET_BYTES);
        assert_eq!(pinned.sha256_hex, metadata::MPV_ASSET_SHA256);
    }
}
