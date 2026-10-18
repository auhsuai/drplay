use bytes::Bytes;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use crate::thumbnail::{atomic_write, validate_file_id};

use super::cache::CoverError;

// Max size accepted for an incoming POSTed cover payload (legacy local-cover path).
pub(super) const MAX_COVER_SIZE: usize = 52_428_800;
/// Sentinel etag stored in COVER_CACHE when a track has no cover (NoCover).
/// Checking this in step 0 returns NoCover early without re-inserting the
/// marker on every request.
pub(super) const COVER_NOCOVER_ETAG: &str = "\"nocover\"";

// --- S3: on-disk cover cache layout & GC budgets (no magic numbers) ---
// Layout: <cache_dir>/covers/{t|f}/{s1}/{s2}/{fileId}.jpg, where s1 = first 2
// chars of fileId and s2 = chars 2-4 (spread-filesystem sharding, cloned from
// the pre-2026-08-03 thumbnail design in git history 98e8206^).
pub(super) const CACHE_ROOT: &str = "covers";
const THUMB_SUBDIR: &str = "t";
const FULL_SUBDIR: &str = "f";
// Filenames are the validated fileId itself (`[A-Za-z0-9_-]{1,128}` — safe as
// a filename, no hash needed; validates + containment are the traversal
// defense). Files are JPEG because the frontend always POSTs JPEG covers.
const COVER_FILE_EXT: &str = "jpg";
// Disk budgets enforced by the background GC, per variant subtree.
const THUMB_BUDGET_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB
const FULL_BUDGET_BYTES: u64 = 1024 * 1024 * 1024; // 1 GiB
// Background GC cadence (seconds). Runs once at setup, then every interval.
const GC_INTERVAL_SECS: u64 = 30 * 60;

/// Root of the on-disk cover cache, resolved at `setup` time from
/// `<app_cache_dir>/covers`. The GET/POST handlers resolve it lazily; if the
/// app was never set up the handler returns a 500 rather than guessing a path.
pub(super) static COVERS_ROOT: OnceLock<PathBuf> = OnceLock::new();

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

// --- S3: disk persistence layer (stubs — implemented below in this slice) ---

/// Persists cover bytes for `raw_id`/`thumb` under `covers_root` using the
/// existing atomic temp+rename write. Returns the mtime-derived ETag.
pub(super) fn write_cover_to_disk(
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
pub(super) fn read_cover_from_disk(
    covers_root: &Path,
    raw_id: &str,
    thumb: bool,
) -> Result<(String, Bytes), CoverError> {
    let path = cover_disk_path(covers_root, raw_id, thumb)?;
    // Only NotFound means NoCover, not an escape: canonicalize() fails on
    // missing paths, so the containment check must come AFTER the existence
    // probes (a missing file can never "escape" anywhere). Any other IO error
    // (permission, reparse loop, transient sharing violation) surfaces as
    // DiskRead so the caller can log + retry instead of caching NoCover.
    let canon_root = std::fs::canonicalize(covers_root).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => CoverError::NoCover,
        _ => CoverError::DiskRead(format!(
            "covers root canonicalize failed for {}: {e}",
            covers_root.display()
        )),
    })?;
    let canon_path = std::fs::canonicalize(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => CoverError::NoCover,
        _ => CoverError::DiskRead(format!(
            "cover canonicalize failed for {}: {e}",
            path.display()
        )),
    })?;
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
pub(super) fn is_within_covers_root(canon_path: &Path, canon_root: &Path) -> bool {
    canon_path.starts_with(canon_root)
}

/// Enforces the per-variant disk budgets and removes corrupt (size-0) files.
/// Runs on a background thread — it must never fail the app: every deletion
/// error (sharing violation on Windows for open files, permissions, races)
/// is logged and skipped.
pub(super) fn gc_covers(covers_root: &Path) -> Result<(), String> {
    gc_covers_with_budgets(covers_root, THUMB_BUDGET_BYTES, FULL_BUDGET_BYTES)
}

/// Testable core of `gc_covers`: budgets are parameters so tests can drive
/// over-budget eviction without allocating 512 MiB.
pub(super) fn gc_covers_with_budgets(
    covers_root: &Path,
    thumb_budget: u64,
    full_budget: u64,
) -> Result<(), String> {
    for (subdir, budget) in [
        (THUMB_SUBDIR, thumb_budget),
        (FULL_SUBDIR, full_budget),
    ] {
        let dir = covers_root.join(CACHE_ROOT).join(subdir);
        // symlink_metadata (lstat) instead of `Path::is_dir()`: the latter
        // follows reparse points, and walking through a link squatting on a
        // shard dir would evict/prune files OUTSIDE the covers tree. Same
        // "never follow symlinks" invariant as `directory_size`.
        let Ok(dir_meta) = std::fs::symlink_metadata(&dir) else {
            continue;
        };
        if dir_meta.file_type().is_symlink() || !dir_meta.is_dir() {
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
pub(super) fn collect_cover_files(dir: &Path, out: &mut Vec<(PathBuf, u64, u64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // `DirEntry::file_type` never follows the link (lstat semantics), so
        // a directory link is skipped instead of being counted or recursed.
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() {
            continue;
        }
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
        // `Path::is_dir` follows reparse points; only real directories may be
        // traversed/pruned (never a link's target).
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
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
