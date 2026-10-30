use moka::future::Cache;
use bytes::Bytes;

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::sync::oneshot;

// --- Named constants for the in-RAM cover cache (no magic numbers) ---
// Total RAM budget for decoded cover bytes held in the moka cache. The weigher
// counts each entry's byte length, so the cache evicts (LRU + TinyLFU admission)
// once the summed weight passes this cap — preventing unbounded growth / OOM.
const COVER_CACHE_MAX_BYTES: usize = 128 * 1024 * 1024; // 128 MiB
// Entries expire after this idle/write TTL so a stale entry is re-evaluated
// on the next request instead of being served forever.
const COVER_CACHE_TTL_SECS: u64 = 3600; // 1 hour
// Upper bound on how many concurrent requests may queue as waiters for one
// in-flight cover fetch (singleflight per `cache_key`). A burst beyond this
// (e.g. a cover grid re-requesting the same uncached cover many times)
// self-serves instead of pushing another waiter, keeping the per-key waiter
// Vec bounded. 64 is far above any legitimate per-key concurrency while
// costing only a few small heap allocations at the cap.
pub(super) const MAX_WAITERS_PER_KEY: usize = 64;

// Cache key suffix marking the thumbnail (downscaled) vs full variant.
pub(super) fn cover_cache_key(raw_id: &str, thumb: bool) -> String {
    format!("{}_{}", raw_id, if thumb { 't' } else { 'f' })
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

pub(super) type CoverResult = Result<(String, Bytes, &'static str), CoverError>;

pub(super) type InFlightMap = HashMap<String, Vec<oneshot::Sender<CoverResult>>>;

pub(super) static IN_FLIGHT: LazyLock<std::sync::Mutex<InFlightMap>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Recover from poisoning instead of panicking: the map only holds waiter
/// senders, so a mid-operation panic cannot break an invariant. Without the
/// recovery, one panic while the lock was held would make every later cover
/// request panic too, breaking covers until an app restart (same policy as
/// `mpv/ipc.rs`).
pub(super) fn lock_in_flight() -> std::sync::MutexGuard<'static, InFlightMap> {
    IN_FLIGHT.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(super) struct InFlightGuard {
    pub(super) cache_key: String,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        // Recover-policy lock so cleanup still runs when the mutex is
        // poisoned; otherwise the stale entry + its waiters would block this
        // key forever.
        lock_in_flight().remove(&self.cache_key);
    }
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
