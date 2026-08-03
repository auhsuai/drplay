
use moka::future::Cache;
use bytes::Bytes;

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
// Entries expire after this idle/write TTL so stale covers are re-fetched from R2.
const COVER_CACHE_TTL_SECS: u64 = 3600; // 1 hour
// Max size accepted for an incoming POSTed cover payload (legacy local-cover path).
const MAX_COVER_SIZE: usize = 52_428_800;
/// Sentinel etag stored in COVER_CACHE when a track has no cover (NoCover).
/// Checking this in step 0 avoids re-fetching from R2 on every mount.
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
// f = full). Source of truth stays in R2 (aws-sdk-s3); this cache only avoids
// re-fetching the same cover bytes on every UI paint. Bounded by total BYTES via the
// weigher and by time via TTL — no unbounded growth, no disk writes.
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

    // Step 0: in-RAM cache (bounded, TTL). Hits avoid any R2 round trip.
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

    // Step 0.5: In-flight dedup — if another task is already fetching this
    // cache_key, wait on its result instead of issuing a duplicate R2 call.
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

    // Step 2: No real cover anywhere — covers live in R2; the SQLite blob
    // backend was removed (2026-08-03), so there is no DB to fall back on.
    // Cache a "no cover" marker so subsequent requests skip the R2 round trip,
    // then return the music-note placeholder so the UI never shows a
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
/// logout / cache-clear (IPC contract: no args); covers re-fetch from R2 on
/// the next request.
#[tauri::command]
pub async fn clear_local_cache(_app: tauri::AppHandle) -> Result<(), String> {
    COVER_CACHE.invalidate_all();
    ETAG_CACHE.invalidate_all();
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
    // Covers now live in R2 (server-side, keyed by cover_url/thumb_url) and are
    // served from the in-RAM cache. We no longer persist cover bytes to disk, so
    // this legacy local-cover write is intentionally a no-op: accepting the
    // payload keeps the protocol contract stable without growing `.thumbnails/`.
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
}
