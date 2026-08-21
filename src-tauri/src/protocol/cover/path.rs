use std::path::{Path, PathBuf};

use crate::thumbnail::validate_file_id;

use super::error::CoverError;

// --- S3: on-disk cover cache layout (no magic numbers) ---
// Layout: <cache_dir>/covers/{t|f}/{s1}/{s2}/{fileId}.jpg, where s1 = first 2
// chars of fileId and s2 = chars 2-4 (spread-filesystem sharding, cloned from
// the pre-2026-08-03 thumbnail design in git history 98e8206^).
pub(crate) const CACHE_ROOT: &str = "covers";
pub(crate) const THUMB_SUBDIR: &str = "t";
pub(crate) const FULL_SUBDIR: &str = "f";
// Filenames are the validated fileId itself (`[A-Za-z0-9_-]{1,128}` — safe as
// a filename, no hash needed; validates + containment are the traversal
// defense). Files are JPEG because the frontend always POSTs JPEG covers.
const COVER_FILE_EXT: &str = "jpg";

/// Absolute path of a cover on disk. `thumb` picks the `t`/`f` subtree.
/// Returns `None` for ids that fail `validate_file_id` (empty, too long, or
/// non-`[A-Za-z0-9_-]`) — those must never map onto a filesystem path.
/// pub(crate): reused by `seed.rs` (offline import) so imported covers land
/// EXACTLY where the GET handler reads them — one path builder, one truth.
pub(crate) fn cover_disk_path(covers_root: &Path, raw_id: &str, thumb: bool) -> Result<PathBuf, CoverError> {
    validate_file_id(raw_id).map_err(CoverError::BadId)?;
    let subdir = if thumb { THUMB_SUBDIR } else { FULL_SUBDIR };
    let (s1, s2) = shard_pair(raw_id);
    Ok(covers_root
        .join(CACHE_ROOT)
        .join(subdir)
        .join(s1)
        .join(s2)
        .join(format!("{raw_id}.{COVER_FILE_EXT}")))
}

/// `{s1}/{s2}` spread-filesystem pair from the first 4 chars of the id,
/// cloned from the pre-2026-08-03 `thumbnail_path` in git history (98e8206^).
/// Ids shorter than 4 chars fall back to the same `xx` pad the old design
/// used, so every valid id still lands in a well-formed two-level path.
/// pub(crate): the seed importer validates zip cover entries against it.
pub(crate) fn shard_pair(raw_id: &str) -> (&str, &str) {
    let len = raw_id.len();
    let s1 = if len >= 2 { &raw_id[..2] } else { raw_id };
    let s2 = if len >= 4 { &raw_id[2..4] } else { "xx" };
    (s1, s2)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::Path;

    #[test]
    fn s3_build_path_uses_sharded_layout() {
        let root = Path::new("C:\\fake\\covers_root");
        let p = cover_disk_path(root, "AbCdEf123456", true).expect("valid id must map");
        assert_eq!(p, root.join("covers").join("t").join("Ab").join("Cd").join("AbCdEf123456.jpg"));
        let p_full = cover_disk_path(root, "AbCdEf123456", false).expect("valid id must map");
        assert_eq!(p_full, root.join("covers").join("f").join("Ab").join("Cd").join("AbCdEf123456.jpg"));
    }

    #[test]
    fn s3_build_path_short_ids_use_xx_pad() {
        let root = Path::new("C:\\fake\\covers_root");
        let p = cover_disk_path(root, "Ab", true).expect("2-char id must map");
        assert_eq!(p, root.join("covers").join("t").join("Ab").join("xx").join("Ab.jpg"));
        let p_single = cover_disk_path(root, "Z", true).expect("1-char id must map");
        assert_eq!(p_single, root.join("covers").join("t").join("Z").join("xx").join("Z.jpg"));
    }

    #[test]
    fn s3_build_path_rejects_invalid_ids() {
        let root = Path::new("C:\\fake\\covers_root");
        for bad in ["", "..\\evil", "a/b", "a b", "x".repeat(129).as_str(), "héllo"] {
            assert!(
                cover_disk_path(root, bad, true).is_err(),
                "id {bad:?} must be rejected by the path builder"
            );
        }
    }
}
