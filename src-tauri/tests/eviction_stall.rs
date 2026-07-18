//! Regression test for moka eviction-stall (zombie node) bug.
//!
//! Issue moka-rs/moka #590: under LRU policy + key reuse + concurrent writers,
//! eviction can stall permanently (a "zombie node" blocks LRU eviction) so the
//! cache never evicts and RAM grows unbounded. The fix lives on moka `main`
//! (PR #592) and is not yet published to crates.io.
//!
//! This test reproduces the conditions: one set of tasks repeatedly re-inserts
//! a small set of REUSED keys while another set inserts UNIQUE keys, with many
//! concurrent writers, exactly as described in #590. After ~30s of churn the
//! weighted byte usage of the cache must stay within `max_bytes`.
//!
//! On buggy moka (<= 0.12.x) `used_bytes()` exceeds `max_bytes` dramatically
//! (stall) -> test FAILS. On fixed `main` it stays bounded -> test PASSES.
//!
//! Marked `#[ignore]` because it is a ~30s stress test; run with:
//!   cargo test --test eviction_stall -- --ignored --nocapture

use std::sync::Arc;
use std::time::Duration;

use tauri_app_lib::slice_cache::SliceCache;

const MAX_BYTES: u64 = 5 * 1024 * 1024; // 5 MiB
const VALUE_LEN: usize = 512 * 1024; // one slice
const RUNTIME_SECS: u64 = 30;
const REUSED_WRITERS: usize = 8;
const UNIQUE_WRITERS: usize = 8;
const REUSED_KEYS: usize = 16;

#[tokio::test]
#[ignore]
async fn eviction_stall_regression() {
    let cache = Arc::new(SliceCache::new(MAX_BYTES));

    let start = std::time::Instant::now();
    let mut handles = Vec::new();

    // Group A: writers that repeatedly re-insert a small set of REUSED keys.
    for w in 0..REUSED_WRITERS {
        let cache = cache.clone();
        handles.push(tokio::spawn(async move {
            let mut i = 0u64;
            while start.elapsed() < Duration::from_secs(RUNTIME_SECS) {
                let key = (w % REUSED_KEYS) as u64;
                let track = format!("reused-{w}");
                cache
                    .batch_insert(&track, key * VALUE_LEN as u64, vec![1u8; VALUE_LEN])
                    .await;
                i += 1;
            }
            i
        }));
    }

    // Group B: writers that insert UNIQUE keys (forcing eviction pressure).
    for w in 0..UNIQUE_WRITERS {
        let cache = cache.clone();
        handles.push(tokio::spawn(async move {
            let mut i = 0u64;
            while start.elapsed() < Duration::from_secs(RUNTIME_SECS) {
                let track = format!("uniq-{w}-{i}");
                cache.batch_insert(&track, 0, vec![2u8; VALUE_LEN]).await;
                i += 1;
            }
            i
        }));
    }

    for h in handles {
        let _ = h.await;
    }

    // Let pending eviction tasks drain.
    cache.cache.run_pending_tasks().await;

    let used = cache.used_bytes();
    let entries = cache.cache.entry_count();
    println!(
        "eviction_stall_regression: used_bytes={used} max_bytes={MAX_BYTES} entries={entries}"
    );

    assert!(
        used <= MAX_BYTES,
        "eviction stalled: cache used {used} bytes, exceeding max_bytes {MAX_BYTES} \
         (zombie-node eviction stall bug not fixed in resolved moka version)"
    );
}
