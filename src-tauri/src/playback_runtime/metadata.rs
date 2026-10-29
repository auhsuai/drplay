//! Single source of truth for the optional `mpv.exe` fallback distribution.
//!
//! Every fact about WHERE the binary comes from and WHAT it must look like
//! lives here, so bumping the pinned build touches exactly one file. Nothing
//! in this module performs IO or network access.
//!
//! ## Why the pin, and why it will break
//!
//! Upstream (`zhongfly/mpv-winbuild`) ships Windows builds as `.7z` archives
//! and PRUNES old releases after roughly 30 days. The pinned tag will start
//! returning 404/410 eventually. Two rules follow from that and neither is
//! negotiable:
//!
//! 1. A missing asset must produce an explicit, user-facing error
//!    ([`crate::playback_runtime::error::FallbackError::AssetMissing`]) that names the
//!    mirror hook below. It must NEVER silently fall through to "latest":
//!    the frontend would otherwise install an unverified binary, and an
//!    unverified binary is worse than no fallback at all.
//! 2. Recovering means either re-pinning [`MPV_VERSION`] /
//!    [`MPV_ASSET_SHA256`] here, or standing up the DrPlay-controlled mirror
//!    and pointing [`MIRROR_BASE_URL`] at it.

use std::time::Duration;

/// Sub-directory name under `<app_local_data_dir>/engines/` for this engine.
pub const ENGINE_DIR_NAME: &str = "mpv";

/// Name of the engine executable inside the archive and on disk.
pub const MPV_EXE_ENTRY: &str = "mpv.exe";

/// Pinned upstream release tag. This is the version string that appears in
/// every on-disk path (`engines/mpv/<MPV_VERSION>/mpv.exe`) and in
/// [`crate::playback_runtime::status::FallbackStatus`].
pub const MPV_VERSION: &str = "2026-10-18-fffe7a23a8";

/// Exact asset file name for the pinned release (x86_64, no installer).
pub const MPV_ASSET_NAME: &str = "mpv-x86_64-20261018-git-fffe7a23a8.7z";

/// Exact size of [`MPV_ASSET_NAME`] in bytes, as published by the GitHub
/// releases API. The downloader refuses any payload of a different length.
pub const MPV_ASSET_BYTES: u64 = 33_611_100;

/// Lowercase hex SHA-256 of [`MPV_ASSET_NAME`]. Verified BEFORE the archive is
/// opened; a mismatch discards the download.
pub const MPV_ASSET_SHA256: &str = "53eabe4d795021d1760e93567084da0c1eea22b624b1c9a43cbc39409a35b93b";

/// Floor for the EXTRACTED `mpv.exe` in bytes. 100 MiB: the pinned build
/// extracts to ~121,946,112 bytes, so anything below this is truncated, a
/// stub, or not mpv at all.
pub const MPV_EXE_BYTE_FLOOR: u64 = 100 * 1024 * 1024;

/// Hard ceiling for the extracted executable. Not a security boundary, a
/// decompression-bomb guard: a hostile archive must not be able to fill the
/// disk because we only check the floor.
pub const MPV_EXE_BYTE_CEILING: u64 = 300 * 1024 * 1024;

/// Base of the upstream download URL. The full asset URL is
/// `<base>/<tag>/<asset>`; see [`download_url`].
pub const DOWNLOAD_BASE_URL: &str =
    "https://github.com/zhongfly/mpv-winbuild/releases/download";

/// DrPlay-controlled mirror hook, used when upstream prunes the pinned tag.
///
/// Contract: when `Some(base)`, the asset is fetched from
/// `<base>/<MPV_VERSION>/<MPV_ASSET_NAME>` -- same layout as upstream, so a
/// mirror is a byte-for-byte copy behind another host. The SHA-256 check runs
/// either way, so a compromised or stale mirror cannot substitute a binary.
///
/// `None` today: no mirror exists yet.
pub const MIRROR_BASE_URL: Option<&str> = None;

/// Directory (under the staging root) that receives the partial download.
pub const STAGING_ARCHIVE_FILE: &str = "archive.7z.part";

/// Root (relative to `<app_local_data_dir>/engines`) for in-flight work.
pub const STAGING_DIR_NAME: &str = ".staging";

/// Leftover staging dirs older than this are removed by
/// [`crate::playback_runtime::install::cleanup_stale_staging`].
pub const STAGING_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Minimum spacing between two progress callbacks when the download is not
/// crossing a whole-percent boundary.
pub const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(200);

/// Whole-percent granularity that forces a progress callback regardless of
/// [`PROGRESS_MIN_INTERVAL`]. Only applies while the total length is known.
pub const PROGRESS_PERCENT_STEP: u64 = 1;

/// Overall request timeout for the download. Generous: 33 MB on a slow line.
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Per-read stall timeout. Catches a dead socket long before [`HTTP_TIMEOUT`].
pub const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Connection establishment timeout.
pub const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// User-Agent for the asset request. GitHub rejects requests without one.
pub const HTTP_USER_AGENT: &str = "DrPlay-FallbackInstaller";

/// Number of redirects reqwest follows for the asset download (GitHub sends
/// the browser URL to `release-assets.githubusercontent.com`).
pub const HTTP_MAX_REDIRECTS: usize = 8;

/// Full URL of the pinned asset, honouring [`MIRROR_BASE_URL`] when set.
pub fn download_url() -> String {
    match MIRROR_BASE_URL {
        Some(base) => format!("{}/{}/{}", base.trim_end_matches('/'), MPV_VERSION, MPV_ASSET_NAME),
        None => format!("{}/{}/{}", DOWNLOAD_BASE_URL, MPV_VERSION, MPV_ASSET_NAME),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_url_is_composed_from_the_pin() {
        let url = download_url();
        assert!(url.ends_with(&format!("/{}/{}", MPV_VERSION, MPV_ASSET_NAME)), "{url}");
        assert!(url.starts_with("https://"), "{url}");
    }

    #[test]
    fn assets_facts_are_consistent() {
        assert_eq!(MPV_ASSET_NAME.contains(MPV_VERSION), false, "asset name encodes the date, not the tag");
        assert!(MPV_ASSET_NAME.contains("20261018"));
        assert_eq!(MPV_ASSET_SHA256.len(), 64);
        assert!(MPV_ASSET_SHA256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert!(MPV_EXE_BYTE_FLOOR < MPV_EXE_BYTE_CEILING);
        assert!(MPV_EXE_BYTE_FLOOR >= 100 * 1024 * 1024);
        assert!(MPV_ASSET_BYTES > 30_000_000);
    }
}
