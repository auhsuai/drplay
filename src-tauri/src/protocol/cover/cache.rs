use bytes::Bytes;
use moka::future::Cache;

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::sync::oneshot;

use super::error::CoverError;

// --- Named constants for the in-RAM cover cache (no magic numbers) ---
// Total RAM budget for decoded cover bytes held in the moka cache. The weigher
// counts each entry's byte length, so the cache evicts (LRU + TinyLFU admission)
// once the summed weight passes this cap — preventing unbounded growth / OOM.
pub(crate) const COVER_CACHE_MAX_BYTES: usize = 128 * 1024 * 1024; // 128 MiB
// Entries expire after this idle/write TTL so a stale entry is re-evaluated
// on the next request instead of being served forever.
pub(crate) const COVER_CACHE_TTL_SECS: u64 = 3600; // 1 hour
/// Sentinel etag stored in COVER_CACHE when a track has no cover (NoCover).
/// Checking this in step 0 returns NoCover early without re-inserting the
/// marker on every request.
pub(crate) const COVER_NOCOVER_ETAG: &str = "\"nocover\"";
// Upper bound on how many concurrent requests may queue as waiters for one
// in-flight cover fetch (singleflight per `cache_key`). A burst beyond this
// (e.g. a cover grid re-requesting the same uncached cover many times)
// self-serves instead of pushing another waiter, keeping the per-key waiter
// Vec bounded. 64 is far above any legitimate per-key concurrency while
// costing only a few small heap allocations at the cap.
pub(crate) const MAX_WAITERS_PER_KEY: usize = 64;

// Cache key suffix marking the thumbnail (downscaled) vs full variant.
pub(crate) fn cover_cache_key(raw_id: &str, thumb: bool) -> String {
    format!("{}_{}", raw_id, if thumb { 't' } else { 'f' })
}

// In-RAM, bounded, TTL-expiring cover cache. Keyed by `{music_id}_{t|f}` (t = thumb,
// f = full). The R2 remote backend was removed (2026-08-03), so covers always
// resolve to the NoCover marker; this cache stores that marker to skip
// re-evaluation on every UI paint. Bounded by total BYTES via the weigher and by
// time via TTL — no unbounded growth, no disk writes.
// pub(crate): read/written by the request orchestration in `cover/mod.rs`;
// not part of the external `protocol::cover` API surface.
pub(crate) static COVER_CACHE: LazyLock<Cache<String, (String, Bytes)>> = LazyLock::new(|| {
    Cache::builder()
        .max_capacity(COVER_CACHE_MAX_BYTES as u64)
        .weigher(|_k, v: &(String, Bytes)| v.1.len() as u32)
        .time_to_live(Duration::from_secs(COVER_CACHE_TTL_SECS))
        .build()
});

pub(crate) type CoverResult = Result<(String, Bytes, &'static str), CoverError>;

pub(crate) static IN_FLIGHT: LazyLock<std::sync::Mutex<HashMap<String, Vec<oneshot::Sender<CoverResult>>>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

pub(crate) struct InFlightGuard {
    pub(crate) cache_key: String,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut in_flight) = IN_FLIGHT.lock() {
            in_flight.remove(&self.cache_key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use bytes::Bytes;
    use moka::future::Cache;
    use std::time::Duration;
    use tokio::sync::oneshot;

    use crate::protocol::cover::handle_cover_get;
    use crate::thumbnail::AccessRecorder;

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

        let recorder = std::sync::Mutex::new(AccessRecorder::new(
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
            AccessRecorder::new(std::path::PathBuf::new()),
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
