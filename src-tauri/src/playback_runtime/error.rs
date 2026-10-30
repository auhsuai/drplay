//! Typed errors for the optional `mpv.exe` fallback.
//!
//! Two consumers matter: the Settings UI (which shows [`Display`]) and Slice 3
//! (which maps [`FallbackError::code`] onto frontend strings). Both must be
//! stable, so [`Display`] never embeds a URL carrying a token, a full user
//! path, or any other value we would not want pasted into a bug report.

use std::fmt;

/// Everything that can go wrong while installing the fallback engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FallbackError {
    /// The OS/arch has no pinned build (only x86_64 Windows exists upstream).
    UnsupportedPlatform,
    /// Tauri could not resolve `<app_local_data_dir>`.
    PathUnavailable,
    /// Another install call is already running in this process.
    AlreadyInProgress,
    /// Transport-level failure (DNS, TLS, connection reset, timeout, IO).
    Network { detail: String },
    /// The asset endpoint answered, but not with 200.
    HttpStatus { status: u16 },
    /// 404/410: upstream pruned the pinned tag. Names the mirror hook.
    AssetMissing { status: u16 },
    /// Downloaded length differs from the pinned asset size.
    SizeMismatch { expected: u64, actual: u64 },
    /// SHA-256 of the download differs from the pinned hash.
    ChecksumMismatch { expected: String, actual: String },
    /// The archive opened, but contains no `mpv.exe` at its root.
    EntryMissing,
    /// A matched entry name is absolute, escapes the root, or is unexpected.
    UnsafeEntry { name: String },
    /// The extracted executable is below the pinned floor.
    ExeTooSmall { actual: u64, floor: u64 },
    /// The entry is larger than the ceiling: refused as a decompression bomb.
    ExeTooLarge { actual: u64, ceiling: u64 },
    /// The archive opened but could not be decoded (bad 7z, unsupported codec).
    ArchiveUnreadable { detail: String },
    /// The extracted executable has no readable Windows version resource.
    VersionUnreadable { detail: String },
    /// The validated binary could not be moved into its final location.
    PublishFailed { detail: String },
    /// The installed engine directory could not be deleted.
    RemoveFailed { detail: String },
}

impl FallbackError {
    /// Stable snake_case slug. Slice 3 maps this onto frontend copy; changing a
    /// slug is a breaking change for the UI.
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::PathUnavailable => "path_unavailable",
            Self::AlreadyInProgress => "already_in_progress",
            Self::Network { .. } => "network",
            Self::HttpStatus { .. } => "http_status",
            Self::AssetMissing { .. } => "asset_missing",
            Self::SizeMismatch { .. } => "size_mismatch",
            Self::ChecksumMismatch { .. } => "checksum_mismatch",
            Self::EntryMissing => "entry_missing",
            Self::UnsafeEntry { .. } => "unsafe_entry",
            Self::ExeTooSmall { .. } => "exe_too_small",
            Self::ExeTooLarge { .. } => "exe_too_large",
            Self::ArchiveUnreadable { .. } => "archive_unreadable",
            Self::VersionUnreadable { .. } => "version_unreadable",
            Self::PublishFailed { .. } => "publish_failed",
            Self::RemoveFailed { .. } => "remove_failed",
        }
    }

    /// Whether the UI should offer a "Retry" button.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Network { .. }
                | Self::HttpStatus { .. }
                | Self::PublishFailed { .. }
                | Self::RemoveFailed { .. }
        )
    }
}

fn mebibytes(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
}

impl fmt::Display for FallbackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedPlatform => write!(
                f,
                "the optional fallback engine is not available for this platform (Windows x86_64 only)"
            ),
            Self::PathUnavailable => write!(
                f,
                "the application data folder is unavailable, so the fallback engine cannot be installed"
            ),
            Self::AlreadyInProgress => {
                write!(f, "a fallback engine install is already running")
            }
            Self::Network { detail } => {
                write!(f, "could not download the fallback engine: {detail}")
            }
            Self::HttpStatus { status } => {
                write!(f, "the download server answered with HTTP {status}")
            }
            Self::AssetMissing { status } => write!(
                f,
                "the pinned fallback engine build is no longer published (HTTP {status}). \
                 The upstream project removes old releases; DrPlay needs to re-pin the build \
                 or enable the mirror (see MIRROR_BASE_URL in playback_runtime/metadata.rs)"
            ),
            Self::SizeMismatch { expected, actual } => write!(
                f,
                "the downloaded archive is incomplete or altered (expected {}, got {})",
                mebibytes(*expected),
                mebibytes(*actual)
            ),
            Self::ChecksumMismatch { .. } => write!(
                f,
                "the downloaded archive failed its integrity check and was discarded"
            ),
            Self::EntryMissing => write!(
                f,
                "the downloaded archive does not contain {}",
                crate::playback_runtime::metadata::MPV_EXE_ENTRY
            ),
            Self::UnsafeEntry { name } => write!(
                f,
                "the downloaded archive contains an unsafe entry name ({name}); refusing to extract"
            ),
            Self::ExeTooSmall { actual, floor } => write!(
                f,
                "the extracted executable is too small to be usable ({} of at least {})",
                mebibytes(*actual),
                mebibytes(*floor)
            ),
            Self::ExeTooLarge { actual, ceiling } => write!(
                f,
                "the extracted executable is implausibly large and was refused ({} of at most {})",
                mebibytes(*actual),
                mebibytes(*ceiling)
            ),
            Self::ArchiveUnreadable { detail } => {
                write!(f, "the downloaded archive could not be opened: {detail}")
            }
            Self::VersionUnreadable { detail } => write!(
                f,
                "the extracted executable could not be identified as a valid Windows program: {detail}"
            ),
            Self::PublishFailed { detail } => {
                write!(f, "could not finalize the fallback engine install: {detail}")
            }
            Self::RemoveFailed { detail } => {
                write!(f, "could not remove the fallback engine: {detail}")
            }
        }
    }
}

impl std::error::Error for FallbackError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_and_unique() {
        let all = [
            FallbackError::UnsupportedPlatform,
            FallbackError::PathUnavailable,
            FallbackError::AlreadyInProgress,
            FallbackError::Network { detail: String::new() },
            FallbackError::HttpStatus { status: 500 },
            FallbackError::AssetMissing { status: 404 },
            FallbackError::SizeMismatch { expected: 1, actual: 2 },
            FallbackError::ChecksumMismatch { expected: "a".into(), actual: "b".into() },
            FallbackError::EntryMissing,
            FallbackError::UnsafeEntry { name: "x".into() },
            FallbackError::ExeTooSmall { actual: 1, floor: 2 },
            FallbackError::ExeTooLarge { actual: 3, ceiling: 2 },
            FallbackError::ArchiveUnreadable { detail: String::new() },
            FallbackError::VersionUnreadable { detail: String::new() },
            FallbackError::PublishFailed { detail: String::new() },
            FallbackError::RemoveFailed { detail: String::new() },
        ];
        let mut seen = std::collections::HashSet::new();
        for err in &all {
            assert!(seen.insert(err.code()), "duplicate code {}", err.code());
            assert!(
                err.code().chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{} is not snake_case",
                err.code()
            );
            assert!(!err.to_string().is_empty());
        }
        assert_eq!(all.len(), seen.len());
    }

    #[test]
    fn asset_missing_names_the_mirror_hook() {
        let msg = FallbackError::AssetMissing { status: 404 }.to_string();
        assert!(msg.contains("MIRROR_BASE_URL"), "{msg}");
        assert!(msg.contains("404"), "{msg}");
    }

    #[test]
    fn display_never_leaks_the_expected_checksum() {
        let err = FallbackError::ChecksumMismatch {
            expected: "53eabe4d795021d1760e93567084da0c1eea22b624b1c9a43cbc39409a35b93b".into(),
            actual: "deadbeef".into(),
        };
        let msg = err.to_string();
        assert!(!msg.contains("53eabe"), "{msg}");
        assert!(!msg.contains("deadbeef"), "{msg}");
    }

    #[test]
    fn retryability_is_scoped() {
        assert!(FallbackError::Network { detail: "x".into() }.is_retryable());
        assert!(FallbackError::HttpStatus { status: 503 }.is_retryable());
        assert!(!FallbackError::AssetMissing { status: 404 }.is_retryable());
        assert!(!FallbackError::ChecksumMismatch { expected: "a".into(), actual: "b".into() }.is_retryable());
    }
}
