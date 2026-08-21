use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use bytes::Bytes;

use crate::thumbnail::atomic_write;

use super::error::CoverError;
use super::path::cover_disk_path;

/// Root of the on-disk cover cache, resolved at `setup` time from
/// `<app_cache_dir>/covers`. The GET/POST handlers resolve it lazily; if the
/// app was never set up the handler returns a 500 rather than guessing a path.
/// pub(crate): read directly by the request orchestration in `cover/mod.rs`.
pub(crate) static COVERS_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Initialized from `lib.rs` `setup` with `<app_cache_dir>/covers`.
pub fn init_covers_root(root: PathBuf) {
    if COVERS_ROOT.set(root).is_err() {
        eprintln!("[protocol] COVERS_ROOT already initialized");
    }
}

/// Read access to the initialized covers root for sibling modules (seed.rs).
/// Returns `None` when setup never ran — callers map that to a 500-style error.
pub(crate) fn covers_root() -> Option<&'static PathBuf> {
    COVERS_ROOT.get()
}

/// ETag derived from the file's full-precision mtime (secs+nanos since epoch).
/// Zero extra deps; changes whenever the cover is re-written, including
/// rewrites inside the same wall-clock second. Sub-second precision matters:
/// truncating to seconds made two same-second overwrites share an ETag, so
/// the If-None-Match gate answered 304 with stale bytes. All supported
/// filesystems carry sub-second mtimes (NTFS stores 100ns FILETIME units,
/// ext4/f2fs keep nanosecond inode fields); if metadata is unavailable the
/// value falls back to `"0"`. The string stays opaque — consumers only
/// compare it verbatim (ETag header / If-None-Match), never parse it.
fn etag_from_mtime(path: &Path) -> String {
    let mtime_nanos = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("\"{mtime_nanos}\"")
}

/// Persists cover bytes for `raw_id`/`thumb` under `covers_root` using the
/// existing atomic temp+rename write. Returns the mtime-derived ETag.
pub(crate) fn write_cover_to_disk(
    covers_root: &Path,
    raw_id: &str,
    thumb: bool,
    bytes: &[u8],
) -> Result<String, CoverError> {
    let path = cover_disk_path(covers_root, raw_id, thumb)?;
    atomic_write(&path, bytes).map_err(CoverError::DiskWrite)?;
    Ok(etag_from_mtime(&path))
}

/// Reads a cover from disk. `NotFound` maps to `NoCover` (the frontend treats
/// it as "no cover, don't fetch again"); any other IO failure maps to
/// `DiskRead` (HTTP 500) with the error message kept for logs only.
pub(crate) fn read_cover_from_disk(
    covers_root: &Path,
    raw_id: &str,
    thumb: bool,
) -> Result<(String, Bytes), CoverError> {
    let path = cover_disk_path(covers_root, raw_id, thumb)?;
    // Root or file missing → NoCover, not an escape: canonicalize() fails on
    // missing paths, so the containment check must come AFTER the existence
    // probes (a missing file can never "escape" anywhere).
    let Ok(canon_root) = std::fs::canonicalize(covers_root) else {
        return Err(CoverError::NoCover);
    };
    let Ok(canon_path) = std::fs::canonicalize(&path) else {
        return Err(CoverError::NoCover);
    };
    if !is_within_covers_root(&canon_path, &canon_root) {
        return Err(CoverError::DiskRead(format!(
            "cover path escapes cache root: {}",
            path.display()
        )));
    }
    let data = match std::fs::read(&path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(CoverError::NoCover),
        Err(e) => {
            return Err(CoverError::DiskRead(format!(
                "failed to read cover {}: {e}",
                path.display()
            )))
        }
    };
    if data.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Err(CoverError::NoCover);
    }
    Ok((etag_from_mtime(&path), Bytes::from(data)))
}

/// Defense in depth: the fileId is already charset-safe, but the read path
/// still refuses any path that does not canonically live under the covers
/// root (symlink/TOCTOU guard). Takes ALREADY-canonicalized paths so the
/// caller controls the missing-file semantics; a symlink pointing outside
/// resolves to the real target and is rejected.
fn is_within_covers_root(canon_path: &Path, canon_root: &Path) -> bool {
    canon_path.starts_with(canon_root)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration;

    use crate::protocol::cover::test_util::{s3_shard_path, s3_temp_root};

    #[test]
    fn s3_roundtrip_post_then_get_returns_exact_bytes() {
        let root = s3_temp_root("roundtrip");
        let id = "file_abc123";
        let payload: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        let etag = write_cover_to_disk(&root, id, true, &payload).expect("post must succeed");
        let (got_etag, got) = read_cover_from_disk(&root, id, true).expect("get must succeed");
        assert_eq!(got.to_vec(), payload, "bytes must roundtrip exactly");
        assert_eq!(got_etag, etag, "etag must be stable across read");
        assert!(etag.starts_with('"') && etag.ends_with('"'), "etag must be quoted");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn s3_roundtrip_full_variant_uses_f_subtree() {
        let root = s3_temp_root("roundtrip_full");
        let id = "file_xyz789";
        let payload = vec![0xABu8; 2048];
        write_cover_to_disk(&root, id, false, &payload).expect("full post must succeed");
        let (_, got) = read_cover_from_disk(&root, id, false).expect("full get must succeed");
        assert_eq!(got.to_vec(), payload);
        assert!(
            s3_shard_path(&root, id, false).starts_with(root.join("covers").join("f")),
            "full variant must live under covers/f"
        );
        assert!(
            !s3_shard_path(&root, id, true).exists(),
            "thumb variant must not be created by a full post"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn s3_second_post_same_id_overwrites() {
        let root = s3_temp_root("overwrite");
        let id = "file_overwrite";
        write_cover_to_disk(&root, id, true, b"first-payload").expect("first post must succeed");
        write_cover_to_disk(&root, id, true, b"second-payload").expect("second post must succeed");
        let (_, got) = read_cover_from_disk(&root, id, true).expect("get must succeed");
        assert_eq!(
            got.to_vec(),
            b"second-payload",
            "atomic_write must replace the previous cover (std::fs::rename \
             MOVEFILE_REPLACE_EXISTING on Windows — verified by this test)"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn s3_get_missing_file_is_nocover() {
        let root = s3_temp_root("missing");
        let err = read_cover_from_disk(&root, "file_never_posted", true).unwrap_err();
        assert!(
            matches!(err, CoverError::NoCover),
            "missing cover must map to NoCover, got {err:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn s3_get_missing_root_dir_is_nocover() {
        let root = std::env::temp_dir().join(format!(
            "drplay_s3_covers_never_created_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let err = read_cover_from_disk(&root, "file_any", true).unwrap_err();
        assert!(
            matches!(err, CoverError::NoCover),
            "missing covers root must map to NoCover, got {err:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn s3_containment_rejects_path_outside_root() {
        let root = s3_temp_root("containment");
        let outside = std::env::temp_dir().join(format!(
            "drplay_s3_outside_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).expect("outside fixture dir must be creatable");
        let outside_file = outside.join("secret.jpg");
        std::fs::write(&outside_file, b"secret").expect("outside file must be writable");
        let canon_outside = std::fs::canonicalize(&outside_file).expect("outside file must canonicalize");
        let canon_root = std::fs::canonicalize(&root).expect("root must canonicalize");
        assert!(
            !is_within_covers_root(&canon_outside, &canon_root),
            "path outside covers root must be refused"
        );
        // The direct builder must never produce a path outside root for any
        // valid id — traversal is blocked at validate_file_id.
        let crafted = cover_disk_path(&root, "..", true);
        assert!(crafted.is_err(), "'..' must fail validation before path building");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(windows)]
    #[test]
    fn s3_containment_rejects_symlink_escape() {
        let root = s3_temp_root("symlink_escape");
        let outside = std::env::temp_dir().join(format!(
            "drplay_s3_symlink_target_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).expect("outside fixture dir must be creatable");
        let outside_file = outside.join("secret.jpg");
        std::fs::write(&outside_file, b"TOP-SECRET").expect("outside file must be writable");
        // Plant a symlink at exactly the path a real cover would occupy,
        // pointing outside the root.
        let link = s3_shard_path(&root, "file_symlink", true);
        std::fs::create_dir_all(link.parent().expect("shard dir")).expect("shard dirs");
        match std::os::windows::fs::symlink_file(&outside_file, &link) {
            Ok(()) => {
                let err = read_cover_from_disk(&root, "file_symlink", true).unwrap_err();
                assert!(
                    matches!(err, CoverError::DiskRead(_)),
                    "symlink escaping the root must be refused, got {err:?}"
                );
            }
            Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
        }
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(not(windows))]
    #[test]
    fn s3_containment_rejects_symlink_escape() {
        let root = s3_temp_root("symlink_escape");
        let outside = std::env::temp_dir().join(format!(
            "drplay_s3_symlink_target_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).expect("outside fixture dir must be creatable");
        let outside_file = outside.join("secret.jpg");
        std::fs::write(&outside_file, b"TOP-SECRET").expect("outside file must be writable");
        let link = s3_shard_path(&root, "file_symlink", true);
        std::fs::create_dir_all(link.parent().expect("shard dir")).expect("shard dirs");
        match std::os::unix::fs::symlink(&outside_file, &link) {
            Ok(()) => {
                let err = read_cover_from_disk(&root, "file_symlink", true).unwrap_err();
                assert!(
                    matches!(err, CoverError::DiskRead(_)),
                    "symlink escaping the root must be refused, got {err:?}"
                );
            }
            Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
        }
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn s3_etag_changes_when_cover_rewritten() {
        let root = s3_temp_root("etag");
        let id = "file_etag";
        let etag1 = write_cover_to_disk(&root, id, true, b"v1").expect("post must succeed");
        std::thread::sleep(Duration::from_millis(1100)); // mtime granularity is seconds
        let etag2 = write_cover_to_disk(&root, id, true, b"v2").expect("post must succeed");
        assert_ne!(etag1, etag2, "rewritten cover must get a fresh etag");
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- REGRESSION TESTS (RED on old code) ---

    #[test]
    fn s3_etag_changes_on_subsecond_rewrite() {
        let root = s3_temp_root("etag_subsec");
        let id = "file_etag_sub";
        let etag1 = write_cover_to_disk(&root, id, true, b"v1").expect("post must succeed");
        std::thread::sleep(Duration::from_millis(50));
        let etag2 = write_cover_to_disk(&root, id, true, b"v2").expect("post must succeed");
        assert_ne!(
            etag1, etag2,
            "sub-second rewrite must yield a distinct etag, or a stale 304 is served \
             (browser keeps old bytes for changed content)"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
