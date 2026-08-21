/// Total byte size of every regular file under `path` (recursive), or 0 when
/// the path does not exist. Pure std — no tauri dependency, unit-testable.
/// Symlink/junction entries are never followed or counted: their target may
/// live outside the tree, and the GC budget must only reflect owned bytes.
/// Recursion depth is bounded in practice: the thumbnail dir holds 1-2 levels.
pub fn directory_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        // `DirEntry::file_type`/`metadata` do NOT traverse symlinks/junctions
        // (unlike `Path::is_dir`, stat semantics), so a link pointing outside
        // is skipped instead of being sized or recursed into. An unreadable
        // entry contributes nothing — same vanish-mid-scan policy as
        // `remove_dir_contents`.
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let entry_path = entry.path();
        if file_type.is_dir() {
            total = total.saturating_add(directory_size(&entry_path));
        } else if let Ok(meta) = entry.metadata() {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

/// Recursively removes every file and subdirectory under `path` while keeping
/// `path` itself. Pure std — no tauri dependency, unit-testable.
///
/// - Path does not exist → `Ok(())` (the cache dir may never have been
///   created).
/// - Path is a regular FILE → the file is removed: the cache location is
///   expected to be a directory, so a file squatting on it is stale state and
///   the next `create_dir_all` recreates the directory.
/// - Symlinks are NEVER followed: `symlink_metadata` (lstat semantics) detects
///   them so an entry pointing outside `path` is only unlinked, never
///   traversed. A symlink AT `path` itself is rejected outright (it could
///   point anywhere; clearing "through" it could wipe an unrelated tree).
/// - An entry that vanishes mid-scan (NotFound) is skipped — concurrent
///   cleanup by another process is not an error worth aborting over.
///
/// Recursion depth is bounded in practice: the thumbnail dir holds 1-2 levels.
pub fn remove_dir_contents(path: &std::path::Path) -> std::io::Result<()> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("refusing to clear through a symlink: {}", path.display()),
        ));
    }
    if meta.is_file() {
        return std::fs::remove_file(path);
    }
    for entry in std::fs::read_dir(path)? {
        let entry_path = entry?.path();
        let entry_meta = match std::fs::symlink_metadata(&entry_path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        if entry_meta.file_type().is_symlink() {
            // Unlink the link itself — never traverse into its target. On
            // Windows a symlink to a DIRECTORY carries the directory attribute,
            // so DeleteFileW (remove_file) is rejected with Access Denied and
            // RemoveDirectoryW (remove_dir) must be used instead; the target is
            // never touched either way. On Unix unlink (remove_file) removes
            // any symlink regardless of target kind.
            #[cfg(not(windows))]
            std::fs::remove_file(&entry_path)?;
            #[cfg(windows)]
            {
                if std::fs::metadata(&entry_path).is_ok_and(|m| m.is_dir()) {
                    std::fs::remove_dir(&entry_path)?;
                } else {
                    std::fs::remove_file(&entry_path)?;
                }
            }
        } else if entry_meta.is_dir() {
            remove_dir_contents(&entry_path)?;
            std::fs::remove_dir(&entry_path)?;
        } else {
            std::fs::remove_file(&entry_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    use crate::protocol::cover::test_util::create_dir_junction;
    use crate::protocol::cover::storage::write_cover_to_disk;
    use crate::protocol::cover::test_util::{s3_temp_root, temp_dir};

    #[test]
    fn directory_size_missing_path_is_zero() {
        let missing = std::env::temp_dir().join("drplay_cache_info_does_not_exist_anything");
        let _ = std::fs::remove_dir_all(&missing);
        assert_eq!(directory_size(&missing), 0, "nonexistent path must report 0");
        assert_eq!(directory_size(std::path::Path::new("Z:\\definitely\\no\\such\\path")), 0);
    }

    #[test]
    fn directory_size_empty_dir_is_zero() {
        let dir = temp_dir("empty");
        assert_eq!(directory_size(&dir), 0, "empty dir must report 0");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn directory_size_sums_files_and_nested_dirs() {
        let dir = temp_dir("nested");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).expect("subdir must be creatable");
        std::fs::write(dir.join("a.bin"), vec![0u8; 100]).expect("file a must be writable");
        std::fs::write(dir.join("b.bin"), vec![0u8; 250]).expect("file b must be writable");
        std::fs::write(sub.join("c.bin"), vec![0u8; 50]).expect("file c must be writable");
        assert_eq!(directory_size(&dir), 400, "must sum all files recursively (100+250+50)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_dir_contents_clears_files_and_subdirs_keeps_dir() {
        let dir = temp_dir("clear");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).expect("subdir must be creatable");
        std::fs::write(dir.join("a.bin"), vec![0u8; 10]).expect("file a must be writable");
        std::fs::write(sub.join("b.bin"), vec![0u8; 20]).expect("file b must be writable");
        remove_dir_contents(&dir).expect("clearing must succeed");
        assert!(dir.is_dir(), "the directory itself must survive");
        assert!(!sub.exists(), "nested subdir must be removed");
        assert_eq!(
            std::fs::read_dir(&dir).expect("cleared dir must be readable").count(),
            0,
            "no entries may remain"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_dir_contents_missing_path_is_ok() {
        let missing = std::env::temp_dir().join(format!(
            "drplay_cache_info_missing_clear_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&missing);
        assert!(remove_dir_contents(&missing).is_ok(), "nonexistent path must be Ok(())");
    }

    #[test]
    fn remove_dir_contents_empty_dir_is_ok() {
        let dir = temp_dir("clear_empty");
        assert!(remove_dir_contents(&dir).is_ok(), "empty dir must be Ok(())");
        assert!(dir.is_dir(), "empty dir must survive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_dir_contents_file_path_removes_the_file() {
        let dir = temp_dir("clear_file");
        let file = dir.join("squatter.bin");
        std::fs::write(&file, vec![0u8; 5]).expect("file must be writable");
        remove_dir_contents(&file).expect("a regular file at the path must be removed");
        assert!(!file.exists(), "file squatting on the cache dir path must be gone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn remove_dir_contents_does_not_follow_dir_symlinks() {
        let target = temp_dir("clear_symlink_target");
        let dir = temp_dir("clear_symlink");
        let link = dir.join("to_target");
        match std::os::windows::fs::symlink_dir(&target, &link) {
            Ok(()) => {
                remove_dir_contents(&dir).expect("clearing must succeed");
                assert!(!link.exists(), "the symlink itself must be removed");
                assert!(
                    std::fs::read_dir(&target).expect("target must be readable").count() == 0,
                    "target dir must exist untouched"
                );
            }
            Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
        }
        let _ = std::fs::remove_dir_all(&target);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(not(windows))]
    #[test]
    fn remove_dir_contents_does_not_follow_dir_symlinks() {
        let target = temp_dir("clear_symlink_target");
        std::fs::write(target.join("keep.bin"), vec![0u8; 7]).expect("target file must be writable");
        let dir = temp_dir("clear_symlink");
        let link = dir.join("to_target");
        match std::os::unix::fs::symlink(&target, &link) {
            Ok(()) => {
                remove_dir_contents(&dir).expect("clearing must succeed");
                assert!(!link.exists(), "the symlink itself must be removed");
                assert!(
                    target.join("keep.bin").exists(),
                    "content behind the symlink must NOT be removed"
                );
            }
            Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
        }
        let _ = std::fs::remove_dir_all(&target);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn directory_size_does_not_count_symlink_target() {
        let outside = temp_dir("dircount_symlink_outside");
        std::fs::write(outside.join("big.bin"), vec![0u8; 10_000]).expect("fixture write");
        let dir = temp_dir("dircount_symlink");
        let link = dir.join("linked");
        if !create_dir_junction(&link, &outside) {
            eprintln!("skipping junction test (mklink unavailable)");
            let _ = std::fs::remove_dir_all(&outside);
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        assert_eq!(
            directory_size(&dir),
            0,
            "symlink/junction target bytes must NOT be counted by directory_size"
        );
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(not(windows))]
    #[test]
    fn directory_size_does_not_count_symlink_target() {
        let outside = temp_dir("dircount_symlink_outside");
        std::fs::write(outside.join("big.bin"), vec![0u8; 10_000]).expect("fixture write");
        let dir = temp_dir("dircount_symlink");
        let link = dir.join("linked.bin");
        match std::os::unix::fs::symlink(&outside.join("big.bin"), &link) {
            Ok(()) => {
                assert_eq!(
                    directory_size(&dir),
                    0,
                    "symlink target bytes must NOT be counted by directory_size"
                );
            }
            Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
        }
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- S3 disk-cache context tests for the pure fs helpers ---

    #[test]
    fn s3_directory_size_reflects_disk_after_post() {
        let root = s3_temp_root("sizeinfo");
        write_cover_to_disk(&root, "file_size_a", true, &vec![0x05u8; 100]).expect("post must succeed");
        write_cover_to_disk(&root, "file_size_b", false, &vec![0x06u8; 250]).expect("post must succeed");
        let size = directory_size(&root);
        assert_eq!(size, 350, "directory_size must sum both variants (100+250)");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn s3_get_cache_info_size_matches_disk() {
        let root = s3_temp_root("cacheinfo");
        write_cover_to_disk(&root, "file_ci", true, &vec![0x07u8; 777]).expect("post must succeed");
        assert_eq!(directory_size(&root.join("covers")), 777, "covers dir must reflect the post");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn s3_clear_removes_contents_keeps_root_dir() {
        let root = s3_temp_root("clear");
        write_cover_to_disk(&root, "file_clr_a", true, b"data-a").expect("post must succeed");
        write_cover_to_disk(&root, "file_clr_b", false, b"data-b").expect("post must succeed");
        let covers_dir = root.join("covers");
        remove_dir_contents(&covers_dir).expect("clearing must succeed");
        assert!(covers_dir.is_dir(), "covers dir itself must survive");
        assert_eq!(
            std::fs::read_dir(&covers_dir).expect("covers dir must be readable").count(),
            0,
            "no cover entries may remain"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
