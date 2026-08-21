// Shared test fixtures for the cover module family. Helpers relied on by
// several submodules' `#[cfg(test)]` modules live here so each module's tests
// stay focused on its own responsibility. This file only compiles under
// `#[cfg(test)]` (declared as such in `cover/mod.rs`).
use std::path::{Path, PathBuf};

pub(crate) fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("drplay_cache_info_{}_{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("test fixture dir must be creatable");
    dir
}

/// A fresh covers root per test (the `covers/` dir itself is created by
/// the code under test). Tagged with pid so parallel tests never collide.
pub(crate) fn s3_temp_root(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "drplay_s3_covers_{}_{}",
        std::process::id(),
        tag
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("test fixture dir must be creatable");
    dir
}

pub(crate) fn s3_shard_path(root: &Path, raw_id: &str, thumb: bool) -> PathBuf {
    super::path::cover_disk_path(root, raw_id, thumb).expect("valid id must map to a path")
}

/// Creates a directory junction on Windows. Junctions need no admin/Dev
/// Mode (unlike `symlink_dir`) and are still reported as symlinks by
/// `symlink_metadata`, so the symlink-skip tests can run on any Windows CI.
/// Paths are passed unquoted: embedded quotes get mangled by `cmd /c`.
#[cfg(windows)]
pub(crate) fn create_dir_junction(link: &Path, target: &Path) -> bool {
    std::process::Command::new("cmd")
        .arg("/c")
        .arg("mklink")
        .arg("/J")
        .arg(link.as_os_str())
        .arg(target.as_os_str())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
