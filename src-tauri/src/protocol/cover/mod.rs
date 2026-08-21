use bytes::Bytes;
use tauri::Manager;
use tokio::sync::oneshot;

use crate::thumbnail::{validate_file_id, AccessRecorder};

mod cache;
mod error;
mod fs_util;
mod gc;
mod path;
mod storage;
#[cfg(test)]
mod test_util;

// --- Public API re-exports (unchanged from the monolithic cover.rs) ---
// External consumers resolve these through `protocol::cover::*`:
// - lib.rs:       clear_local_cache / clear_thumbnail_dir / get_cache_info
//                 (tauri commands) + init_covers_root / spawn_covers_gc (setup)
// - protocol/mod.rs: handle_cover_get / handle_cover_post / CoverError /
//                 init_access_recorder / ACCESS_RECORDER (drplay:// handlers)
// - seed.rs:      covers_root / cover_disk_path / shard_pair (offline import)
pub use error::CoverError;
pub use fs_util::{directory_size, remove_dir_contents};
pub use gc::spawn_covers_gc;
pub use storage::init_covers_root;
pub(crate) use path::{cover_disk_path, shard_pair};
pub(crate) use storage::covers_root;

// --- Internal cross-module plumbing (not part of the external API surface) ---
use cache::{
    cover_cache_key, COVER_CACHE, COVER_NOCOVER_ETAG, CoverResult, IN_FLIGHT, InFlightGuard,
    MAX_WAITERS_PER_KEY,
};
use gc::gc_covers;
use path::CACHE_ROOT;
use storage::{read_cover_from_disk, write_cover_to_disk, COVERS_ROOT};

// Max size accepted for an incoming POSTed cover payload (legacy local-cover path).
const MAX_COVER_SIZE: usize = 52_428_800;

// Initialized from `lib.rs` `setup` with a log path under `<app_cache_dir>/.thumbnails/`.
// The cover GET path records each access here; the handler returns HTTP 500 if the
// recorder has not been initialized, so `init_access_recorder` must run at setup.
pub static ACCESS_RECORDER: std::sync::OnceLock<std::sync::Mutex<AccessRecorder>> =
    std::sync::OnceLock::new();

pub fn init_access_recorder(log_path: std::path::PathBuf) {
    let recorder = AccessRecorder::new(log_path);
    if ACCESS_RECORDER.set(std::sync::Mutex::new(recorder)).is_err() {
        eprintln!("[protocol] ACCESS_RECORDER already initialized");
    }
}

pub async fn handle_cover_get(
    raw_id: &str,
    thumb: bool,
    recorder: &std::sync::Mutex<AccessRecorder>,
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
            // Disk-served covers count as accesses too (same as CACHE_HIT):
            // keeps the recency access log complete for ids whose covers are
            // not yet in RAM. Guard is dropped before the .await below
            // (std::sync::MutexGuard is !Send and must not span await points).
            if let Ok(mut r) = recorder.lock() {
                r.record(raw_id);
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::test_util::s3_temp_root;

    #[tokio::test]
    async fn disk_served_cover_is_recorded_in_access_log() {
        let root = s3_temp_root("recorder_disk");
        let id = "file_recorder";
        write_cover_to_disk(&root, id, true, b"cover-bytes").expect("post must succeed");
        if COVERS_ROOT.get().is_none() {
            init_covers_root(root.clone());
        }
        let log_path = root.join("access_log.json");
        let recorder =
            std::sync::Mutex::new(crate::thumbnail::AccessRecorder::new(log_path.clone()));

        COVER_CACHE.invalidate_all();
        IN_FLIGHT.lock().unwrap().clear();

        let result = handle_cover_get(id, true, &recorder).await;
        assert!(result.is_ok(), "disk hit must succeed: {result:?}");

        // Force the recorder past its flush threshold (500 entries) so the log
        // file lands on disk, then assert the disk-served id is in it.
        {
            let mut r = recorder.lock().unwrap();
            for _ in 0..500 {
                r.record("__flush_force__");
            }
        }

        let data = std::fs::read_to_string(&log_path).expect("flushed access log must exist");
        let map: std::collections::HashMap<String, u64> =
            serde_json::from_str(&data).expect("access log must be valid JSON");
        // AccessRecorder::record() normalizes ids (drive_ prefix) before they
        // reach the log, so the assertion must use the normalized key too.
        let recorded_key = crate::thumbnail::normalize_id(id);
        assert!(
            map.contains_key(recorded_key.as_str()),
            "a cover served from disk must be recorded in the access log; log={map:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
