//! Test-only helpers shared by the `playback_runtime` submodules.
//!
//! Gated on `#[cfg(test)]` from `mod.rs`; it never enters a release build.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use futures_util::future::BoxFuture;
use futures_util::stream;

use super::download::{AssetTransport, BoxByteStream, FetchedAsset};
use super::error::FallbackError;

/// Serializes every test that touches the process-wide install slot, because
/// that slot is (by design) global to the whole binary -- not per module. Both
/// `install::tests` and `commands::tests` take this lock.
pub static SLOT_LOCK: Mutex<()> = Mutex::new(());

/// Temp dir scoped by pid + tag, mirroring `src-tauri/src/tests.rs:3-16`.
pub fn temp_scope_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "drplay_playback_runtime_{}_{}",
        std::process::id(),
        tag
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("test fixture dir must be creatable");
    dir
}

/// A byte stream that yields `bytes` in fixed-size chunks.
pub fn chunks_of(bytes: Vec<u8>, chunk_size: usize) -> BoxByteStream {
    assert!(chunk_size > 0, "chunk size must be positive");
    let chunks: Vec<Result<Bytes, FallbackError>> = bytes
        .chunks(chunk_size)
        .map(|c| Ok(Bytes::copy_from_slice(c)))
        .collect();
    Box::pin(stream::iter(chunks))
}

/// A transport that always fails with a fixed error, for mapping tests.
pub struct StubTransport {
    error: Option<FallbackError>,
    body: Option<Vec<u8>>,
    total: Option<u64>,
}

impl StubTransport {
    pub fn failing(error: FallbackError) -> Arc<Self> {
        Arc::new(Self { error: Some(error), body: None, total: None })
    }

    pub fn serving(body: Vec<u8>) -> Arc<Self> {
        let total = Some(body.len() as u64);
        Arc::new(Self { error: None, body: Some(body), total })
    }
}

impl AssetTransport for StubTransport {
    fn fetch<'a>(&'a self, _url: &'a str) -> BoxFuture<'a, Result<FetchedAsset, FallbackError>> {
        let error = self.error.clone();
        let body = self.body.clone();
        let total = self.total;
        Box::pin(async move {
            if let Some(error) = error {
                return Err(error);
            }
            let body = body.unwrap_or_default();
            Ok(FetchedAsset { total, stream: chunks_of(body, 4096) })
        })
    }
}
