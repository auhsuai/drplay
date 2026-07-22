use axum::extract::FromRef;
use reqwest::Client;
use serde::Deserialize;
use std::sync::Arc;

use super::cache::CacheStore;

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
}

impl FromRef<AppState> for CacheStore {
    fn from_ref(input: &AppState) -> Self {
        input.cache_store.clone()
    }
}
