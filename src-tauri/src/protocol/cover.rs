
use moka::future::Cache;
use bytes::Bytes;
use tauri::Manager;

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::sync::oneshot;

use crate::thumbnail::validate_file_id;

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

pub static ETAG_CACHE: LazyLock<Cache<String, (String, Bytes)>> = LazyLock::new(|| {
    Cache::builder()
        .max_capacity(50 * 1024 * 1024)
        .weigher(|_k, v: &(String, Bytes)| v.1.len() as u32)
        .build()
});

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

    // Step 2: No real cover anywhere — the R2 remote backend was removed
    // alongside the SQLite blob backend (2026-08-03), so there is no source
    // left to fetch from. Cache a "no cover" marker so subsequent requests skip
    // this step, then return the music-note placeholder so the UI never shows a
    // black/transparent image. `has_cover` on the JS side stays false, so the
    // app knows there is no real cover.
    COVER_CACHE.insert(cache_key.clone(), (COVER_NOCOVER_ETAG.to_string(), Bytes::new())).await;
    eprintln!("[PERF] handle_cover_get {} source=NOCOVER took {:?}", raw_id, _start.elapsed());
    let result: CoverResult = Err(CoverError::NoCover);

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
}

/// Invalidates every in-RAM cover/etag cache entry. Called by the frontend on
/// logout / cache-clear (IPC contract: no args); covers re-resolve to the
/// NoCover marker on the next request.
#[tauri::command]
pub async fn clear_local_cache(_app: tauri::AppHandle) -> Result<(), String> {
    COVER_CACHE.invalidate_all();
    ETAG_CACHE.invalidate_all();
    Ok(())
}

/// Snapshot of what the cache manager dialog shows: current in-RAM weight of
/// the two moka caches plus the on-disk size of the thumbnail dir.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CacheInfo {
    pub cover_cache_bytes: u64,
    pub etag_cache_bytes: u64,
    pub thumbnail_dir_bytes: u64,
}

/// Returns current cache usage. `weighted_size()` is a moka estimate that can
/// lag concurrent inserts/removals, so pending maintenance tasks are drained
/// first (see moka docs for `entry_count`/`weighted_size`). On-disk thumbnail
/// size is computed from `<app_cache_dir>/.thumbnails` (same path the access
/// recorder log lives under — see `lib.rs` `setup`).
#[tauri::command]
pub async fn get_cache_info(app: tauri::AppHandle) -> CacheInfo {
    COVER_CACHE.run_pending_tasks().await;
    ETAG_CACHE.run_pending_tasks().await;
    let thumbnail_dir_bytes = match app.path().app_cache_dir() {
        Ok(cache_dir) => directory_size(&cache_dir.join(".thumbnails")),
        Err(_) => 0,
    };
    CacheInfo {
        cover_cache_bytes: COVER_CACHE.weighted_size(),
        etag_cache_bytes: ETAG_CACHE.weighted_size(),
        thumbnail_dir_bytes,
    }
}

/// Empties `<app_cache_dir>/.thumbnails` (same path `get_cache_info` measures
/// and the access-recorder log lives under), keeping the directory itself.
/// `remove_dir_contents` never follows symlinks and treats a missing dir as a
/// no-op, so this is safe to call even if the cache was never created.
#[tauri::command]
pub async fn clear_thumbnail_dir(app: tauri::AppHandle) -> Result<(), String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("clear_thumbnail_dir: failed to resolve app cache dir: {e}"))?;
    let thumbnails_dir = cache_dir.join(".thumbnails");
    remove_dir_contents(&thumbnails_dir).map_err(|e| {
        format!(
            "clear_thumbnail_dir: failed to clear {}: {e}",
            thumbnails_dir.display()
        )
    })
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
                if std::fs::metadata(&entry_path).map_or(false, |m| m.is_dir()) {
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

pub fn handle_cover_post(
    raw_id: &str,
    _thumb: bool,
    body: &[u8],
) -> Result<(), String> {
    validate_file_id(raw_id)?;
    if body.is_empty() {
        return Err("empty payload".into());
    }
    if body.len() > MAX_COVER_SIZE {
        return Err("payload too large".into());
    }
    // Covers always resolve to the NoCover placeholder (the R2 remote backend
    // was removed 2026-08-03), so there is no cover payload to persist. We no
    // longer write cover bytes to disk, so this legacy local-cover write is
    // intentionally a no-op: accepting the payload keeps the protocol contract
    // stable without growing `.thumbnails/`.
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
}
