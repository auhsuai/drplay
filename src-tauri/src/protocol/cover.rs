
use moka::future::Cache;
use bytes::Bytes;
use tauri::Manager;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock};
use std::time::Duration;
use tokio::sync::oneshot;

use crate::thumbnail::{atomic_write, validate_file_id};

// --- Named constants for the in-RAM cover cache (no magic numbers) ---
// Total RAM budget for decoded cover bytes held in the moka cache. The weigher
// counts each entry's byte length, so the cache evicts (LRU + TinyLFU admission)
// once the summed weight passes this cap — preventing unbounded growth / OOM.
const COVER_CACHE_MAX_BYTES: usize = 128 * 1024 * 1024; // 128 MiB
// Entries expire after this idle/write TTL so a stale entry is re-evaluated
// on the next request instead of being served forever.
const COVER_CACHE_TTL_SECS: u64 = 3600; // 1 hour
// Max size accepted for an incoming POSTed cover payload (legacy local-cover path).
const MAX_COVER_SIZE: usize = 52_428_800;
/// Sentinel etag stored in COVER_CACHE when a track has no cover (NoCover).
/// Checking this in step 0 returns NoCover early without re-inserting the
/// marker on every request.
const COVER_NOCOVER_ETAG: &str = "\"nocover\"";
// Upper bound on how many concurrent requests may queue as waiters for one
// in-flight cover fetch (singleflight per `cache_key`). A burst beyond this
// (e.g. a cover grid re-requesting the same uncached cover many times)
// self-serves instead of pushing another waiter, keeping the per-key waiter
// Vec bounded. 64 is far above any legitimate per-key concurrency while
// costing only a few small heap allocations at the cap.
const MAX_WAITERS_PER_KEY: usize = 64;

// Cache key suffix marking the thumbnail (downscaled) vs full variant.
fn cover_cache_key(raw_id: &str, thumb: bool) -> String {
    format!("{}_{}", raw_id, if thumb { 't' } else { 'f' })
}

// --- S3: on-disk cover cache layout & GC budgets (no magic numbers) ---
// Layout: <cache_dir>/covers/{t|f}/{s1}/{s2}/{fileId}.jpg, where s1 = first 2
// chars of fileId and s2 = chars 2-4 (spread-filesystem sharding, cloned from
// the pre-2026-08-03 thumbnail design in git history 98e8206^).
const CACHE_ROOT: &str = "covers";
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
static COVERS_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Initialized from `lib.rs` `setup` with `<app_cache_dir>/covers`.
pub fn init_covers_root(root: PathBuf) {
    if COVERS_ROOT.set(root).is_err() {
        eprintln!("[protocol] COVERS_ROOT already initialized");
    }
}

/// Absolute path of a cover on disk. `thumb` picks the `t`/`f` subtree.
/// Returns `None` for ids that fail `validate_file_id` (empty, too long, or
/// non-`[A-Za-z0-9_-]`) — those must never map onto a filesystem path.
fn cover_disk_path(covers_root: &Path, raw_id: &str, thumb: bool) -> Result<PathBuf, CoverError> {
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
fn shard_pair(raw_id: &str) -> (&str, &str) {
    let len = raw_id.len();
    let s1 = if len >= 2 { &raw_id[..2] } else { raw_id };
    let s2 = if len >= 4 { &raw_id[2..4] } else { "xx" };
    (s1, s2)
}

/// ETag derived from the file's mtime — zero extra deps, changes whenever the
/// cover is re-written. mtime granularity is coarse (seconds), which is fine:
/// a rewritten cover with the same second still flips content via the moka
/// cache TTL and the 304 gate only short-circuits byte-identical responses.
fn etag_from_mtime(path: &Path) -> String {
    let mtime_secs = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("\"{mtime_secs}\"")
}

// Initialized from `lib.rs` `setup` with a log path under `<app_cache_dir>/.thumbnails/`.
// The cover GET path records each access here; the handler returns HTTP 500 if the
// recorder has not been initialized, so `init_access_recorder` must run at setup.
pub static ACCESS_RECORDER: std::sync::OnceLock<std::sync::Mutex<crate::thumbnail::AccessRecorder>> =
    std::sync::OnceLock::new();

pub fn init_access_recorder(log_path: std::path::PathBuf) {
    let recorder = crate::thumbnail::AccessRecorder::new(log_path);
    if ACCESS_RECORDER.set(std::sync::Mutex::new(recorder)).is_err() {
        eprintln!("[protocol] ACCESS_RECORDER already initialized");
    }
}

// In-RAM, bounded, TTL-expiring cover cache. Keyed by `{music_id}_{t|f}` (t = thumb,
// f = full). The R2 remote backend was removed (2026-08-03), so covers always
// resolve to the NoCover marker; this cache stores that marker to skip
// re-evaluation on every UI paint. Bounded by total BYTES via the weigher and by
// time via TTL — no unbounded growth, no disk writes.
pub static COVER_CACHE: LazyLock<Cache<String, (String, Bytes)>> = LazyLock::new(|| {
    Cache::builder()
        .max_capacity(COVER_CACHE_MAX_BYTES as u64)
        .weigher(|_k, v: &(String, Bytes)| v.1.len() as u32)
        .time_to_live(Duration::from_secs(COVER_CACHE_TTL_SECS))
        .build()
});

type CoverResult = Result<(String, Bytes, &'static str), CoverError>;

static IN_FLIGHT: LazyLock<std::sync::Mutex<HashMap<String, Vec<oneshot::Sender<CoverResult>>>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

struct InFlightGuard {
    cache_key: String,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut in_flight) = IN_FLIGHT.lock() {
            in_flight.remove(&self.cache_key);
        }
    }
}

pub async fn handle_cover_get(
    raw_id: &str,
    thumb: bool,
    recorder: &std::sync::Mutex<crate::thumbnail::AccessRecorder>,
) -> Result<(String, Bytes, &'static str), CoverError> {
    let _start = std::time::Instant::now();

    if let Err(e) = validate_file_id(raw_id) {
        eprintln!("[PERF] handle_cover_get {} source=BAD_ID took {:?}", raw_id, _start.elapsed());
        return Err(CoverError::BadId(e));
    }

    let cache_key = cover_cache_key(raw_id, thumb);

    // Step 0: in-RAM cache (bounded, TTL). A hit short-circuits the NoCover
    // path below without re-inserting the marker.
    if let Some(hit) = COVER_CACHE.get(&cache_key).await {
        if hit.0 == COVER_NOCOVER_ETAG {
            eprintln!("[PERF] handle_cover_get {} source=NOCOVER_CACHE took {:?}", raw_id, _start.elapsed());
            return Err(CoverError::NoCover);
        }
        if let Ok(mut r) = recorder.lock() {
            r.record(raw_id);
        }
        eprintln!("[PERF] handle_cover_get {} source=CACHE_HIT took {:?}", raw_id, _start.elapsed());
        return Ok((hit.0, hit.1, "image/jpeg"));
    }

    // Step 0.5: In-flight dedup — if another task is already handling this
    // cache_key, wait on its result instead of duplicating the work.
    // The MutexGuard is scoped to NOT span the .await point (it is !Send).
    let subscribe_rx = {
        let mut in_flight = IN_FLIGHT.lock().unwrap();
        if let Some(waiters) = in_flight.get_mut(&cache_key) {
            if waiters.len() < MAX_WAITERS_PER_KEY {
                let (tx, rx) = oneshot::channel();
                waiters.push(tx);
                Some(rx)
            } else {
                // Waiter cap reached: self-serve instead of growing the waiter
                // Vec without bound. A duplicate fetch is cheaper than unbounded
                // memory held by waiters; both paths yield identical bytes.
                eprintln!(
                    "[PERF] handle_cover_get {} source=IN_FLIGHT_WAITER_CAP \
                     ({} waiters, cap {}) — self-serving instead of waiting",
                    raw_id, waiters.len(), MAX_WAITERS_PER_KEY
                );
                None
            }
        } else {
            in_flight.insert(cache_key.clone(), Vec::new());
            None
        }
    };

    if let Some(rx) = subscribe_rx {
        match rx.await {
            Ok(result) => return result,
            Err(_) => {
                eprintln!("[PERF] handle_cover_get {} source=IN_FLIGHT_RETRY", raw_id);
                // Re-assert leadership for future waiters without clobbering a
                // concurrent retry's fresh entry (remove+insert would).
                let mut in_flight = IN_FLIGHT.lock().unwrap();
                in_flight.entry(cache_key.clone()).or_default();
            }
        }
    }

    // Drop guard ensures IN_FLIGHT cleanup even on panic/cancellation.
    let _guard = InFlightGuard { cache_key: cache_key.clone() };

    // Step 2: disk-backed cover lookup. A hit re-warms the moka cache (which
    // also re-arms the TTL) and serves the file's mtime ETag; a clean miss
    // caches the NoCover marker so the frontend stops asking; transient IO
    // failures (permission etc.) are logged and returned as 500 WITHOUT
    // caching, so the next request retries instead of being stuck.
    let disk_result = match COVERS_ROOT.get() {
        Some(covers_root) => read_cover_from_disk(covers_root, raw_id, thumb),
        None => Err(CoverError::DiskRead("covers root not initialized".into())),
    };
    let result: CoverResult = match disk_result {
        Ok((etag, bytes)) => {
            COVER_CACHE
                .insert(cache_key.clone(), (etag.clone(), bytes.clone()))
                .await;
            eprintln!("[PERF] handle_cover_get {} source=DISK_HIT took {:?}", raw_id, _start.elapsed());
            Ok((etag, bytes, "image/jpeg"))
        }
        Err(CoverError::NoCover) => {
            COVER_CACHE
                .insert(cache_key.clone(), (COVER_NOCOVER_ETAG.to_string(), Bytes::new()))
                .await;
            eprintln!("[PERF] handle_cover_get {} source=NOCOVER took {:?}", raw_id, _start.elapsed());
            Err(CoverError::NoCover)
        }
        Err(e) => {
            eprintln!("[PERF] handle_cover_get {} source=DISK_ERROR took {:?}", raw_id, _start.elapsed());
            Err(e)
        }
    };

    // Step 3: Notify any concurrent waiters and remove from IN_FLIGHT.
    // Must happen AFTER the COVER_CACHE insert so that subsequent requests to
    // this key hit the cache instead of joining IN_FLIGHT.
    {
        let mut in_flight = IN_FLIGHT.lock().unwrap();
        if let Some(waiters) = in_flight.remove(&cache_key) {
            for tx in waiters {
                let _ = tx.send(result.clone());
            }
        }
    }

    result
}

#[derive(Debug, Clone)]
pub enum CoverError {
    BadId(String),
    NoCover,
    /// Disk read failed (permission, missing root init, corrupt state) — maps
    /// to HTTP 500 in mod.rs; the message is only for logs, never the response.
    DiskRead(String),
    /// Disk write failed (permission, disk full) — maps to HTTP 500.
    DiskWrite(String),
}

/// Invalidates every in-RAM cover cache entry. Called by the frontend on
/// logout / cache-clear (IPC contract: no args); covers re-resolve to the
/// NoCover marker on the next request.
#[tauri::command]
pub async fn clear_local_cache(_app: tauri::AppHandle) -> Result<(), String> {
    COVER_CACHE.invalidate_all();
    Ok(())
}

/// Snapshot of what the cache manager dialog shows: current in-RAM weight of
/// the cover cache plus the on-disk size of the thumbnail dir.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CacheInfo {
    pub cover_cache_bytes: u64,
    pub thumbnail_dir_bytes: u64,
}

/// Returns current cache usage. `weighted_size()` is a moka estimate that can
/// lag concurrent inserts/removals, so pending maintenance tasks are drained
/// first (see moka docs for `entry_count`/`weighted_size`). On-disk cover
/// size is computed from `<app_cache_dir>/covers` (the S3 disk cache root —
/// the same directory the GC polices).
#[tauri::command]
pub async fn get_cache_info(app: tauri::AppHandle) -> CacheInfo {
    COVER_CACHE.run_pending_tasks().await;
    let covers_dir_bytes = match app.path().app_cache_dir() {
        Ok(cache_dir) => directory_size(&cache_dir.join(CACHE_ROOT)),
        Err(_) => 0,
    };
    CacheInfo {
        cover_cache_bytes: COVER_CACHE.weighted_size(),
        thumbnail_dir_bytes: covers_dir_bytes,
    }
}

/// Empties `<app_cache_dir>/covers` (the S3 disk cover cache) and invalidates
/// the in-RAM moka caches, keeping the covers directory itself.
/// `remove_dir_contents` never follows symlinks and treats a missing dir as a
/// no-op, so this is safe to call even if the cache was never created.
#[tauri::command]
pub async fn clear_thumbnail_dir(app: tauri::AppHandle) -> Result<(), String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("clear_thumbnail_dir: failed to resolve app cache dir: {e}"))?;
    let covers_dir = cache_dir.join(CACHE_ROOT);
    // Best-effort GC first (pays down size while clearing), then wipe.
    let _ = gc_covers(&covers_dir);
    remove_dir_contents(&covers_dir).map_err(|e| {
        format!(
            "clear_thumbnail_dir: failed to clear {}: {e}",
            covers_dir.display()
        )
    })?;
    COVER_CACHE.invalidate_all();
    Ok(())
}

/// Total byte size of every regular file under `path` (recursive), or 0 when
/// the path does not exist. Pure std — no tauri dependency, unit-testable.
/// Recursion depth is bounded in practice: the thumbnail dir holds 1-2 levels.
pub fn directory_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.is_dir() {
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
fn write_cover_to_disk(
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
fn read_cover_from_disk(
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

/// Enforces the per-variant disk budgets and removes corrupt (size-0) files.
/// Runs on a background thread — it must never fail the app: every deletion
/// error (sharing violation on Windows for open files, permissions, races)
/// is logged and skipped.
fn gc_covers(covers_root: &Path) -> Result<(), String> {
    gc_covers_with_budgets(covers_root, THUMB_BUDGET_BYTES, FULL_BUDGET_BYTES)
}

/// Testable core of `gc_covers`: budgets are parameters so tests can drive
/// over-budget eviction without allocating 512 MiB.
fn gc_covers_with_budgets(
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

pub async fn handle_cover_post(
    raw_id: &str,
    thumb: bool,
    body: &[u8],
) -> Result<(), CoverError> {
    // Same validation gate the legacy handler enforced: bad id, empty body or
    // an oversized payload are client errors (HTTP 400 in mod.rs), never
    // written to disk.
    validate_file_id(raw_id).map_err(CoverError::BadId)?;
    if body.is_empty() {
        return Err(CoverError::BadId("empty payload".into()));
    }
    if body.len() > MAX_COVER_SIZE {
        return Err(CoverError::BadId("payload too large".into()));
    }
    let covers_root = COVERS_ROOT
        .get()
        .ok_or_else(|| CoverError::DiskWrite("covers root not initialized".into()))?;
    let etag = write_cover_to_disk(covers_root, raw_id, thumb, body)?;
    COVER_CACHE
        .insert(cover_cache_key(raw_id, thumb), (etag, Bytes::copy_from_slice(body)))
        .await;
    Ok(())
}



#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cover_cache_stores_and_fetches_by_key() {
        let cache: Cache<String, (String, Bytes)> = Cache::builder()
            .max_capacity(1_000)
            .weigher(|_k: &String, v: &(String, Bytes)| v.1.len() as u32)
            .time_to_live(Duration::from_secs(60))
            .build();

        let key = cover_cache_key("abc123", true);
        assert!(cache.get(&key).await.is_none(), "fresh cache must miss");

        let payload = Bytes::from(vec![1u8, 2, 3, 4, 5]);
        cache.insert(key.clone(), ("\"etag\"".to_string(), payload.clone())).await;
        let got = cache.get(&key).await;
        assert!(got.is_some(), "inserted entry must be fetchable");
        assert_eq!(got.unwrap().1, payload);

        // Different thumb/full variant is a separate key.
        assert!(cache.get(&cover_cache_key("abc123", false)).await.is_none());
    }

    #[tokio::test]
    async fn cover_cache_evicts_under_byte_capacity() {
        // Tiny capacity forces eviction once summed weights exceed the cap.
        let cache: Cache<String, (String, Bytes)> = Cache::builder()
            .max_capacity(10) // 10 bytes total
            .weigher(|_k: &String, v: &(String, Bytes)| v.1.len() as u32)
            .build();

        // Insert two 8-byte entries (16 bytes > 10 capacity).
        cache.insert("a".to_string(), ("e".to_string(), Bytes::from(vec![0u8; 8]))).await;
        cache.insert("b".to_string(), ("e".to_string(), Bytes::from(vec![1u8; 8]))).await;

        // Drain maintenance tasks so eviction is applied.
        cache.run_pending_tasks().await;

        // At most one 8-byte entry can remain under a 10-byte cap.
        let a = cache.get(&"a".to_string()).await;
        let b = cache.get(&"b".to_string()).await;
        let present = a.is_some() as u32 + b.is_some() as u32;
        assert!(present <= 1, "byte cap must evict down to <=1 entry, got {}", present);
    }

    #[tokio::test]
    async fn waiters_capped_when_vec_at_cap() {
        const KEY_ID: &str = "cap_test";
        let key = cover_cache_key(KEY_ID, false);
        COVER_CACHE.invalidate(&key).await;
        IN_FLIGHT.lock().unwrap().remove(&key);

        // Simulate a leader that is still fetching: a waiter Vec already at
        // the cap, holding live senders so the Vec stays alive.
        IN_FLIGHT.lock().unwrap().insert(
            key.clone(),
            (0..MAX_WAITERS_PER_KEY).map(|_| oneshot::channel().0).collect(),
        );

        let recorder = std::sync::Mutex::new(crate::thumbnail::AccessRecorder::new(
            std::path::PathBuf::new(),
        ));
        let task = tokio::spawn(async move {
            handle_cover_get(KEY_ID, false, &recorder).await
        });

        // Poll: on the old unbounded code the request pushes a (cap+1)-th
        // waiter and blocks forever; on the capped code it self-serves and the
        // Vec is drained without ever exceeding the cap.
        let mut observed = 0usize;
        let mut beyond_cap = false;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let len = IN_FLIGHT.lock().unwrap().get(&key).map_or(0, Vec::len);
            observed = observed.max(len);
            if len > MAX_WAITERS_PER_KEY {
                beyond_cap = true;
                break;
            }
            if task.is_finished() {
                break;
            }
        }

        assert!(
            !beyond_cap,
            "waiter Vec for one cache_key grew to {observed}, exceeding cap {MAX_WAITERS_PER_KEY} \
             (unbounded IN_FLIGHT waiters bug)"
        );

        // Cleanup: drop the fake leader's entry so any still-waiting request is
        // woken (its oneshot sender is dropped -> Err -> retry -> self-serve).
        IN_FLIGHT.lock().unwrap().remove(&key);
        let finished = tokio::time::timeout(Duration::from_secs(5), task).await;
        assert!(finished.is_ok(), "request must not hang after the leader dies");
    }

    #[tokio::test]
    async fn concurrent_requests_do_not_pile_up_waiters() {
        const KEY_ID: &str = "burst_test";
        let key = cover_cache_key(KEY_ID, false);
        COVER_CACHE.invalidate(&key).await;
        IN_FLIGHT.lock().unwrap().remove(&key);

        // Fake in-flight leader: an empty waiter Vec that no real fetch ever
        // resolves, so every request either waits (up to the cap) or self-serves.
        IN_FLIGHT.lock().unwrap().insert(key.clone(), Vec::new());

        let recorder = std::sync::Arc::new(std::sync::Mutex::new(
            crate::thumbnail::AccessRecorder::new(std::path::PathBuf::new()),
        ));
        let handles: Vec<_> = (0..256usize)
            .map(|_| {
                let recorder = std::sync::Arc::clone(&recorder);
                tokio::spawn(async move {
                    handle_cover_get(KEY_ID, false, recorder.as_ref())
                        .await
                })
            })
            .collect();

        // Wait for the burst to settle (all tasks reach the subscribe step;
        // waiters then either resolve or self-serve) and track the peak count.
        let mut max_len = 0usize;
        let mut last = usize::MAX;
        let mut stable = 0;
        for _ in 0..250 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let len = IN_FLIGHT.lock().unwrap().get(&key).map_or(0, Vec::len);
            max_len = max_len.max(len);
            if len == last {
                stable += 1;
            } else {
                stable = 0;
            }
            last = len;
            if stable >= 3 {
                break;
            }
        }

        assert!(
            max_len <= MAX_WAITERS_PER_KEY,
            "concurrent burst piled up {max_len} waiters for one key (cap {MAX_WAITERS_PER_KEY}) \
             — unbounded IN_FLIGHT waiters bug"
        );

        // Drop the fake leader so any still-waiting tasks wake up and finish.
        IN_FLIGHT.lock().unwrap().remove(&key);
        for h in handles {
            let _ = tokio::time::timeout(Duration::from_secs(5), h).await;
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("drplay_cache_info_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test fixture dir must be creatable");
        dir
    }

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

    #[tokio::test]
    async fn weighted_size_reports_zero_when_cache_empty() {
        let cache: Cache<String, (String, Bytes)> = Cache::builder()
            .max_capacity(10_000)
            .weigher(|_k: &String, v: &(String, Bytes)| v.1.len() as u32)
            .build();
        cache.run_pending_tasks().await;
        assert_eq!(cache.weighted_size(), 0, "empty cache must report 0 bytes");
        assert_eq!(cache.entry_count(), 0, "empty cache must report 0 entries");
    }

    #[tokio::test]
    async fn weighted_size_tracks_inserted_bytes() {
        let cache: Cache<String, (String, Bytes)> = Cache::builder()
            .max_capacity(10_000)
            .weigher(|_k: &String, v: &(String, Bytes)| v.1.len() as u32)
            .build();
        cache.insert("a".to_string(), ("\"e\"".to_string(), Bytes::from(vec![0u8; 64]))).await;
        cache.insert("b".to_string(), ("\"e\"".to_string(), Bytes::from(vec![0u8; 36]))).await;
        cache.run_pending_tasks().await;
        assert_eq!(cache.weighted_size(), 100, "weighted_size must equal summed weigher weights (64+36)");
        cache.invalidate_all();
        cache.run_pending_tasks().await;
        assert_eq!(cache.weighted_size(), 0, "invalidate_all must drain weight to 0");
    }

    // ========================= S3 disk cache tests =========================

    /// A fresh covers root per test (the `covers/` dir itself is created by
    /// the code under test). Tagged with pid so parallel tests never collide.
    fn s3_temp_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "drplay_s3_covers_{}_{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test fixture dir must be creatable");
        dir
    }

    fn s3_shard_path(root: &std::path::Path, raw_id: &str, thumb: bool) -> std::path::PathBuf {
        super::cover_disk_path(root, raw_id, thumb).expect("valid id must map to a path")
    }

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
    fn s3_build_path_uses_sharded_layout() {
        let root = std::path::Path::new("C:\\fake\\covers_root");
        let p = cover_disk_path(root, "AbCdEf123456", true).expect("valid id must map");
        assert_eq!(p, root.join("covers").join("t").join("Ab").join("Cd").join("AbCdEf123456.jpg"));
        let p_full = cover_disk_path(root, "AbCdEf123456", false).expect("valid id must map");
        assert_eq!(p_full, root.join("covers").join("f").join("Ab").join("Cd").join("AbCdEf123456.jpg"));
    }

    #[test]
    fn s3_build_path_short_ids_use_xx_pad() {
        let root = std::path::Path::new("C:\\fake\\covers_root");
        let p = cover_disk_path(root, "Ab", true).expect("2-char id must map");
        assert_eq!(p, root.join("covers").join("t").join("Ab").join("xx").join("Ab.jpg"));
        let p_single = cover_disk_path(root, "Z", true).expect("1-char id must map");
        assert_eq!(p_single, root.join("covers").join("t").join("Z").join("xx").join("Z.jpg"));
    }

    #[test]
    fn s3_build_path_rejects_invalid_ids() {
        let root = std::path::Path::new("C:\\fake\\covers_root");
        for bad in ["", "..\\evil", "a/b", "a b", "x".repeat(129).as_str(), "héllo"] {
            assert!(
                cover_disk_path(root, bad, true).is_err(),
                "id {bad:?} must be rejected by the path builder"
            );
        }
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
            write_cover_to_disk(&root, &id, true, &vec![i as u8; 100]).expect("post must succeed");
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
        write_cover_to_disk(&root, id, true, &vec![0x04u8; 64]).expect("post must succeed");
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

    #[test]
    fn s3_get_cache_info_size_matches_disk() {
        let root = s3_temp_root("cacheinfo");
        write_cover_to_disk(&root, "file_ci", true, &vec![0x07u8; 777]).expect("post must succeed");
        assert_eq!(directory_size(&root.join("covers")), 777, "covers dir must reflect the post");
        let _ = std::fs::remove_dir_all(&root);
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
}
