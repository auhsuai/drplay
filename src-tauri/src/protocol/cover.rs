
use moka::future::Cache;
use bytes::Bytes;

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::sync::oneshot;

use r2d2_sqlite::SqliteConnectionManager;

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
/// Checking this in step 0 avoids re-fetching from R2 + SQLite on every mount.
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

fn query_cover_blob(
    pool: &r2d2::Pool<SqliteConnectionManager>,
    file_id: &str,
    thumb: bool,
) -> Result<Option<Vec<u8>>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let has_thumb = *crate::HAS_THUMB.get_or_init(|| {
        conn.prepare("SELECT thumbnail FROM tracks LIMIT 1").is_ok()
    });
    let sql = if thumb && has_thumb {
        "SELECT thumbnail, cover_art FROM tracks WHERE id = ? LIMIT 1"
    } else {
        "SELECT cover_art FROM tracks WHERE id = ? AND cover_art IS NOT NULL LIMIT 1"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query([&file_id]).map_err(|e| e.to_string())?;
    if let Ok(Some(row)) = rows.next() {
        let cover: Vec<u8> = if thumb && has_thumb {
            let t: Vec<u8> = row.get(0).unwrap_or_default();
            if !t.is_empty() { t } else { row.get(1).unwrap_or_default() }
        } else {
            row.get(0).unwrap_or_default()
        };
        if !cover.is_empty() {
            return Ok(Some(cover));
        }
    }
    Ok(None)
}



pub async fn handle_cover_get<R: tauri::Runtime>(
    raw_id: &str,
    thumb: bool,
    pool: Option<&r2d2::Pool<SqliteConnectionManager>>,
    recorder: &std::sync::Mutex<crate::thumbnail::AccessRecorder>,
    app: Option<&tauri::AppHandle<R>>,
) -> Result<(String, Bytes, &'static str), CoverError> {
    let _start = std::time::Instant::now();

    if let Err(e) = validate_file_id(raw_id) {
        eprintln!("[PERF] handle_cover_get {} source=BAD_ID took {:?}", raw_id, _start.elapsed());
        return Err(CoverError::BadId(e));
    }

    let cache_key = cover_cache_key(raw_id, thumb);

    // Step 0: in-RAM cache (bounded, TTL). Hits avoid any R2/DB round trip.
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
    // cache_key, wait on its result instead of issuing a duplicate R2/SQLite call.
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

    // Steps 1-3 wrapped in a labeled block for single cleanup point.
    let result = 'fetch: {
        // Step 2: SQLite blob fallback — only for ids without drive_ prefix (legacy records)
        if let Some(pool) = pool {
            if !raw_id.starts_with(crate::thumbnail::PREFIX) {
                if let Ok(Some(blob)) = query_cover_blob(pool, raw_id, thumb) {
                    let etag = format!("\"{:x}\"", md5::compute(&blob));
                    let bytes = Bytes::from(blob);
                    COVER_CACHE.insert(cache_key.clone(), (etag.clone(), bytes.clone())).await;
                    if let Ok(mut r) = recorder.lock() {
                        r.record(raw_id);
                    }
                    eprintln!("[PERF] handle_cover_get {} source=SQLITE took {:?}", raw_id, _start.elapsed());
                    break 'fetch Ok((etag, bytes, "image/jpeg"));
                }
            }
        }

        // Step 3: No real cover anywhere (no R2 key, no SQLite blob). Emit a repair
        // signal if we can map to a Drive file, then return the music-note placeholder
        // so the UI never shows a black/transparent image. `has_cover` on the JS side
        // stays false, so the app knows there is no real cover.
        if let Some(pool) = pool {
            let drive_file_id_opt = if raw_id.starts_with(crate::thumbnail::PREFIX) {
                Some(raw_id.trim_start_matches(crate::thumbnail::PREFIX).to_string())
            } else {
                get_drive_file_id_for_track(pool, raw_id).ok().flatten()
            };

            if let Some(drive_file_id) = drive_file_id_opt {
                if let Some(app) = app {
                    use tauri::Emitter;
                    let payload = serde_json::json!({
                        "driveFileId": drive_file_id,
                        "dbId": raw_id,
                    });
                    let _ = app.emit("repair-missing-thumbnail", payload);
                }
            }
        }

        // Cache the "no cover" result so subsequent requests skip R2/SQLite.
        COVER_CACHE.insert(cache_key.clone(), (COVER_NOCOVER_ETAG.to_string(), Bytes::new())).await;
        eprintln!("[PERF] handle_cover_get {} source=NOCOVER took {:?}", raw_id, _start.elapsed());
        break 'fetch Err(CoverError::NoCover)
    };

    // Step 4: Notify any concurrent waiters and remove from IN_FLIGHT.
    // Must happen AFTER COVER_CACHE insert (already done per-step above) so that
    // subsequent requests to this key hit the cache instead of joining IN_FLIGHT.
    {
        let mut in_flight = IN_FLIGHT.lock().unwrap();
        if let Some(waiters) = in_flight.remove(&cache_key) {
            match &result {
                Ok((etag, bytes, ct)) => {
                    for tx in waiters {
                        let _ = tx.send(Ok((etag.clone(), bytes.clone(), *ct)));
                    }
                }
                Err(e) => {
                    for tx in waiters {
                        let _ = tx.send(Err(e.clone()));
                    }
                }
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

fn get_drive_file_id_for_track(
    pool: &r2d2::Pool<SqliteConnectionManager>,
    db_id: &str,
) -> Result<Option<String>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let path: Option<String> = conn
        .query_row(
            "SELECT file_path FROM tracks WHERE id = ?",
            [db_id],
            |row| row.get(0),
        )
        .ok();
    Ok(path.and_then(|p| p.strip_prefix("drive://").map(String::from)))
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
            handle_cover_get::<tauri::Wry>(KEY_ID, false, None, &recorder, None).await
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
                    handle_cover_get::<tauri::Wry>(KEY_ID, false, None, recorder.as_ref(), None)
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
