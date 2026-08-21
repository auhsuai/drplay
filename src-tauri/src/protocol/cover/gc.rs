use std::path::{Path, PathBuf};
use std::time::Duration;

use super::path::{CACHE_ROOT, FULL_SUBDIR, THUMB_SUBDIR};

// Disk budgets enforced by the background GC, per variant subtree.
const THUMB_BUDGET_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB
const FULL_BUDGET_BYTES: u64 = 1024 * 1024 * 1024; // 1 GiB
// Background GC cadence (seconds). Runs once at setup, then every interval.
const GC_INTERVAL_SECS: u64 = 30 * 60;

/// Enforces the per-variant disk budgets and removes corrupt (size-0) files.
/// Runs on a background thread — it must never fail the app: every deletion
/// error (sharing violation on Windows for open files, permissions, races)
/// is logged and skipped.
/// pub(crate): also invoked by `clear_thumbnail_dir` in `cover/mod.rs`.
pub(crate) fn gc_covers(covers_root: &Path) -> Result<(), String> {
    gc_covers_with_budgets(covers_root, THUMB_BUDGET_BYTES, FULL_BUDGET_BYTES)
}

/// Testable core of `gc_covers`: budgets are parameters so tests can drive
/// over-budget eviction without allocating 512 MiB.
pub(crate) fn gc_covers_with_budgets(
    covers_root: &Path,
    thumb_budget: u64,
    full_budget: u64,
) -> Result<(), String> {
    for (subdir, budget) in [
        (THUMB_SUBDIR, thumb_budget),
        (FULL_SUBDIR, full_budget),
    ] {
        let dir = covers_root.join(CACHE_ROOT).join(subdir);
        if !dir.is_dir() {
            continue;
        }
        // Covers live 2 shard levels deep ({s1}/{s2}), so the walk must
        // recurse (bounded: fixed 2-level shard layout).
        let mut entries: Vec<(PathBuf, u64, u64)> = Vec::new(); // (path, size, mtime)
        collect_cover_files(&dir, &mut entries);
        entries.sort_by_key(|(_, _, mtime)| *mtime);
        let total: u64 = entries.iter().map(|(_, size, _)| size).sum();
        if total > budget {
            let mut to_free = total - budget;
            for (path, size, _) in entries {
                if to_free == 0 {
                    break;
                }
                if let Err(e) = std::fs::remove_file(&path) {
                    eprintln!("[gc_covers] {} not removable (in use?): {e}", path.display());
                    continue;
                }
                to_free = to_free.saturating_sub(size);
            }
        }
        prune_empty_subdirs(&dir);
    }
    Ok(())
}

/// Recursively collects regular cover files (skipping directories) under
/// `dir`; 0-byte corrupt files are deleted inline, everything else is
/// reported as `(path, size, mtime_secs)` for the budget pass.
fn collect_cover_files(dir: &Path, out: &mut Vec<(PathBuf, u64, u64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect_cover_files(&path, out);
            continue;
        }
        if meta.len() == 0 {
            if let Err(e) = std::fs::remove_file(&path) {
                eprintln!("[gc_covers] corrupt file {} not removable: {e}", path.display());
            }
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push((path, meta.len(), mtime));
    }
}

/// Removes now-empty shard directories under `dir` (bottom-up). Only
/// directories are ever passed to `remove_dir`; files are left untouched
/// (corrupt/oversize handling already happened in `gc_covers`). Missing dirs
/// are fine; any removal error is logged and skipped — a dir that is not
/// empty yet simply stays for the next GC pass.
fn prune_empty_subdirs(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            prune_empty_subdirs(&path);
            match std::fs::remove_dir(&path) {
                Ok(()) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound
                            | std::io::ErrorKind::DirectoryNotEmpty
                    ) => {}
                Err(e) => eprintln!("[gc_covers] dir {} not removable: {e}", path.display()),
            }
        }
    }
}

/// Background GC: runs immediately once, then every `GC_INTERVAL_SECS`.
/// Detached thread — the process exit kills it; errors never propagate.
pub fn spawn_covers_gc(covers_root: PathBuf) {
    std::thread::spawn(move || loop {
        if let Err(e) = gc_covers(&covers_root) {
            eprintln!("[gc_covers] background run failed: {e}");
        }
        std::thread::sleep(Duration::from_secs(GC_INTERVAL_SECS));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration;

    #[cfg(windows)]
    use crate::protocol::cover::test_util::create_dir_junction;
    use crate::protocol::cover::test_util::{s3_shard_path, s3_temp_root};
    use super::super::storage::{read_cover_from_disk, write_cover_to_disk};

    #[test]
    fn s3_gc_deletes_size_zero_corrupt_files() {
        let root = s3_temp_root("gc_zero");
        let id = "file_corrupt";
        let path = s3_shard_path(&root, id, true);
        std::fs::create_dir_all(path.parent().expect("shard dir")).expect("shard dirs");
        std::fs::write(&path, b"").expect("0-byte file must be writable");
        gc_covers(&root).expect("gc must succeed");
        assert!(!path.exists(), "0-byte corrupt cover must be deleted");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn s3_gc_keeps_files_under_budget() {
        let root = s3_temp_root("gc_keep");
        let id = "file_keep";
        write_cover_to_disk(&root, id, true, &vec![0x01u8; 512]).expect("post must succeed");
        gc_covers(&root).expect("gc must succeed");
        let (_, got) = read_cover_from_disk(&root, id, true).expect("cover must survive");
        assert_eq!(got.len(), 512, "under-budget covers must survive gc");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn s3_gc_enforces_budget_across_deep_dirs() {
        let root = s3_temp_root("gc_budget");
        // 8 covers × 100 B = 800 B total in the t subtree, 2 levels deep
        // ({s1}/{s2}) — GC must descend and evict oldest-first until the
        // 250 B budget is satisfied (≤ 3 files remain).
        for i in 0..8u32 {
            let id = format!("file_b{i:02}");
            write_cover_to_disk(&root, &id, true, &[i as u8; 100]).expect("post must succeed");
            std::thread::sleep(Duration::from_millis(15)); // distinct mtimes
        }
        gc_covers_with_budgets(&root, 250, u64::MAX).expect("gc must succeed");
        let mut sizes: Vec<(PathBuf, u64, u64)> = Vec::new();
        collect_cover_files(&root.join("covers").join("t"), &mut sizes);
        let total: u64 = sizes.iter().map(|(_, s, _)| s).sum();
        assert!(total <= 250, "thumb budget must be enforced, total was {total}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn s3_gc_removes_empty_shard_dirs() {
        let root = s3_temp_root("gc_dirs");
        let id = "file_dirprune";
        write_cover_to_disk(&root, id, true, &[0x04u8; 64]).expect("post must succeed");
        let path = s3_shard_path(&root, id, true);
        std::fs::remove_file(&path).expect("fixture file must be removable");
        gc_covers(&root).expect("gc must succeed");
        let shard_dir = path.parent().expect("shard dir");
        assert!(
            !shard_dir.exists(),
            "empty shard dir must be pruned after gc"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn gc_collect_skips_symlinked_cover_files() {
        let root = s3_temp_root("gc_symlink");
        let outside = std::env::temp_dir().join(format!(
            "drplay_s3_gc_symlink_target_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).expect("outside dir");
        std::fs::write(outside.join("huge.bin"), vec![0u8; 1_000_000]).expect("fixture write");
        let junction = root.join("covers").join("t").join("zz").join("jj");
        std::fs::create_dir_all(junction.parent().expect("shard dir")).expect("shard dirs");
        if !create_dir_junction(&junction, &outside) {
            eprintln!("skipping junction test (mklink unavailable)");
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }
        let mut entries: Vec<(std::path::PathBuf, u64, u64)> = Vec::new();
        collect_cover_files(&root.join("covers").join("t"), &mut entries);
        assert!(
            entries.is_empty(),
            "symlinked cover dir must not be collected/sized by GC: {entries:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(not(windows))]
    #[test]
    fn gc_collect_skips_symlinked_cover_files() {
        let root = s3_temp_root("gc_symlink");
        let outside = std::env::temp_dir().join(format!(
            "drplay_s3_gc_symlink_target_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).expect("outside dir");
        std::fs::write(outside.join("huge.bin"), vec![0u8; 1_000_000]).expect("fixture write");
        let path = s3_shard_path(&root, "file_symlink", true);
        std::fs::create_dir_all(path.parent().expect("shard dir")).expect("shard dirs");
        match std::os::unix::fs::symlink(&outside.join("huge.bin"), &path) {
            Ok(()) => {
                let mut entries: Vec<(std::path::PathBuf, u64, u64)> = Vec::new();
                collect_cover_files(&root.join("covers").join("t"), &mut entries);
                assert!(
                    entries.is_empty(),
                    "symlinked cover must not be collected/sized by GC: {entries:?}"
                );
            }
            Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
        }
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
