use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

use axum::extract::FromRef;
use reqwest::Client;
use serde::Deserialize;

use super::cache::CacheStore;
use crate::slice_cache::SliceCache;

#[derive(serde::Serialize, Clone)]
pub struct BufferState {
    pub track_id: String,
    pub buffer_start_byte: u64,
    pub buffer_end_byte: u64,
    pub total_size_byte: u64,
}

#[derive(Deserialize)]
pub struct StreamQuery {
    pub id: String,
    pub exp: u64,
    pub sig: String,
    pub ext: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub client: Client,
    pub cache_store: CacheStore,
    // Previously `crate::GLOBAL_SLICE_CACHE`/`crate::GLOBAL_BUFFER_SECONDS`
    // (LazyLock/OnceLock statics reached via ambient `crate::` paths from
    // both the Tauri command layer and this Axum server). AUDIT.md 5.2/7.1:
    // "no official bridge between tauri::State and Axum State" for values
    // that must be *mutable* and shared across both -- folding them into
    // this already-Axum-injected AppState (instead of inventing a second,
    // parallel state mechanism) and also handing the same Arcs to Tauri via
    // `.manage()` in lib.rs's `run()` is the fix audit's own research cited.
    // `PROXY_SECRET`/`PROXY_PORT`/`GLOBAL_STREAM_TOKEN` etc. are deliberately
    // NOT part of this: audit specifically calls out write-once values
    // (secret, port) as fine to leave as statics, and the stream
    // token/rate-limit/prefetch-concurrency statics weren't in its named
    // improvement list either -- this stays scoped to exactly what was
    // flagged, not a wholesale rewrite of every global in the proxy.
    pub slice_cache: Arc<SliceCache>,
    pub buffer_seconds: Arc<AtomicUsize>,
}

impl FromRef<AppState> for CacheStore {
    fn from_ref(input: &AppState) -> Self {
        input.cache_store.clone()
    }
}
