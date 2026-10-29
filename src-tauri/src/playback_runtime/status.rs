//! Frontend-facing status of the optional fallback engine.
//!
//! Two distinct things are modelled:
//!
//! * [`FallbackStatus`] -- the settled state of the install on disk.
//! * [`FallbackProgress`] -- the stage of an in-flight install.
//!
//! They are separate types on purpose. A progress value is transient and must
//! never be persisted or mistaken for the installed state, and the installed
//! state must never carry a "percent".
//!
//! ## "File exists" is not "installed"
//!
//! [`FallbackStatus::Installed`] is only produced after the size gate AND a
//! successful Windows version read. A truncated download, a zero-byte
//! placeholder, or an unrelated file dropped at the target path all resolve to
//! [`FallbackStatus::Invalid`], which the UI must treat as "not usable" -- not
//! as "installed, maybe broken".

use serde::Serialize;
use std::path::Path;

use super::metadata;

/// Settled install state, serialized as an internally tagged enum:
/// `{"state":"notInstalled"}`, `{"state":"installed","version":...}`, ...
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum FallbackStatus {
    /// No executable at the pinned path.
    NotInstalled,
    /// Present, big enough, and carrying a readable Windows version resource.
    Installed {
        version: String,
        path: String,
        size: u64,
    },
    /// Present but unusable. `reason` is a short, user-safe explanation.
    Invalid { reason: String },
}

/// Stage of an in-flight install, serialized as an internally tagged enum.
///
/// `Downloading` carries a real byte counter. `total` is `None` whenever the
/// server did not report a `Content-Length`: the UI must render an
/// indeterminate bar in that case rather than inventing a percentage.
/// `Verifying` / `Extracting` / `Publishing` are inherently indeterminate --
/// they carry no numbers, and none should be synthesized.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum FallbackProgress {
    Downloading {
        downloaded: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
    },
    Verifying,
    Extracting,
    Publishing,
}

impl FallbackProgress {
    /// Integer percentage in `0..=100`, or `None` when the total is unknown.
    /// Deliberately returns `None` instead of a guess: a fabricated percentage
    /// is worse than a spinner. `Some` is also the only answer that means "this
    /// stage is byte-metered", so callers must not invent a second predicate.
    pub fn percent(&self) -> Option<u8> {
        match self {
            Self::Downloading { downloaded, total: Some(total) } if *total > 0 => {
                let pct = (*downloaded as u128 * 100) / (*total as u128);
                Some(pct.min(100) as u8)
            }
            _ => None,
        }
    }
}

/// Builds the canonical install path for a version under a local-data root.
///
/// Pure function on purpose: taking `&Path` instead of an `AppHandle` makes the
/// path layout testable without spinning up Tauri. The layout is
/// `<local_data>/engines/mpv/<version>/mpv.exe`.
pub fn engine_exe_path(local_data_root: &Path, version: &str) -> std::path::PathBuf {
    local_data_root
        .join("engines")
        .join(metadata::ENGINE_DIR_NAME)
        .join(version)
        .join(metadata::MPV_EXE_ENTRY)
}

/// Root for in-flight work: `<local_data>/engines/.staging`.
pub fn staging_root(local_data_root: &Path) -> std::path::PathBuf {
    local_data_root
        .join("engines")
        .join(metadata::STAGING_DIR_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_path_layout_is_exact() {
        let root = Path::new(r"C:\Users\someone\AppData\Local\DrPlay");
        let path = engine_exe_path(root, "2026-10-18-fffe7a23a8");
        let expected = root
            .join("engines")
            .join("mpv")
            .join("2026-10-18-fffe7a23a8")
            .join("mpv.exe");
        assert_eq!(path, expected);
        assert!(path.ends_with(r"engines\mpv\2026-10-18-fffe7a23a8\mpv.exe"));
    }

    #[test]
    fn staging_root_sits_beside_the_versions() {
        let root = Path::new("/data");
        assert_eq!(staging_root(root), Path::new("/data/engines/.staging"));
        assert!(engine_exe_path(root, "v1").starts_with(root.join("engines").join("mpv")));
    }

    #[test]
    fn status_serializes_with_stable_tags() {
        let not_installed = serde_json::to_string(&FallbackStatus::NotInstalled).unwrap();
        assert_eq!(not_installed, r#"{"state":"notInstalled"}"#);

        let installed = serde_json::to_string(&FallbackStatus::Installed {
            version: "v1".into(),
            path: r"C:\p\mpv.exe".into(),
            size: 121_946_112,
        })
        .unwrap();
        assert_eq!(
            installed,
            r#"{"state":"installed","version":"v1","path":"C:\\p\\mpv.exe","size":121946112}"#
        );

        let invalid = serde_json::to_string(&FallbackStatus::Invalid { reason: "r".into() }).unwrap();
        assert_eq!(invalid, r#"{"state":"invalid","reason":"r"}"#);
    }

    #[test]
    fn progress_serializes_and_only_downloading_is_determinate() {
        let unknown_total =
            serde_json::to_string(&FallbackProgress::Downloading { downloaded: 42, total: None })
                .unwrap();
        assert_eq!(unknown_total, r#"{"stage":"downloading","downloaded":42}"#);
        assert_eq!(FallbackProgress::Downloading { downloaded: 42, total: None }.percent(), None);

        let known = FallbackProgress::Downloading { downloaded: 12, total: Some(48) };
        assert_eq!(known.percent(), Some(25));
        assert_eq!(
            serde_json::to_string(&known).unwrap(),
            r#"{"stage":"downloading","downloaded":12,"total":48}"#
        );

        assert_eq!(
            serde_json::to_string(&FallbackProgress::Verifying).unwrap(),
            r#"{"stage":"verifying"}"#
        );
        assert_eq!(
            serde_json::to_string(&FallbackProgress::Extracting).unwrap(),
            r#"{"stage":"extracting"}"#
        );
        assert_eq!(
            serde_json::to_string(&FallbackProgress::Publishing).unwrap(),
            r#"{"stage":"publishing"}"#
        );
        // Only a byte-metered download can answer with a percentage; every
        // other stage is inherently indeterminate.
        assert_eq!(FallbackProgress::Verifying.percent(), None);
        assert_eq!(FallbackProgress::Extracting.percent(), None);
        assert_eq!(FallbackProgress::Publishing.percent(), None);
    }

    #[test]
    fn percent_never_exceeds_one_hundred() {
        let over = FallbackProgress::Downloading { downloaded: 500, total: Some(100) };
        assert_eq!(over.percent(), Some(100));
        let zero_total = FallbackProgress::Downloading { downloaded: 0, total: Some(0) };
        assert_eq!(zero_total.percent(), None);
    }
}
