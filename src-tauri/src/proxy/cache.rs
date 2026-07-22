use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

/// Track metadata held in the bounded cache.
pub struct TrackMeta {
    pub total_size: u64,
    pub content_type: String,
}

pub type CacheStore = moka::future::Cache<String, Arc<Mutex<TrackMeta>>>;

/// Bounded track-metadata cache.
///
/// Root cause (P0-1): the original `cache_store` was an unbounded
/// `Arc<Mutex<HashMap<String, ...>>>` that inserted a fresh `TrackMeta` for
/// every track ever streamed and NEVER evicted. With a ~12 000-track library
/// the native Rust process RSS grew without bound on every play.
///
/// This replaces it with a `moka` bounded cache: `max_capacity` keeps the
/// entry count bounded (LRU + TinyLFU admission), and `time_to_idle` drops
/// entries that have not been touched in a while. The async `moka::future`
/// API is the same one used elsewhere in this codebase (see `slice_cache.rs`).
pub(crate) const TRACK_CACHE_MAX_ENTRIES: u64 = 2000;
const TRACK_CACHE_IDLE_TTL: Duration = Duration::from_secs(30 * 60); // 30 min

pub fn new_cache_store() -> CacheStore {
    moka::future::Cache::builder()
        .max_capacity(TRACK_CACHE_MAX_ENTRIES)
        .time_to_idle(TRACK_CACHE_IDLE_TTL)
        .build()
}
