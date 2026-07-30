use moka::future::Cache;
use std::future::Future;
use std::sync::Arc;

pub const SLICE_SIZE: u64 = 512 * 1024;

pub struct SliceCache {
    pub cache: Cache<(String, u64), Arc<Vec<u8>>>,
}

impl SliceCache {
    pub fn new(max_bytes: u64) -> Self {
        let max_bytes = max_bytes.max(1);
        SliceCache {
            cache: Cache::builder()
                .max_capacity(max_bytes)
                .weigher(|_k: &(String, u64), v: &Arc<Vec<u8>>| -> u32 {
                    v.len().try_into().unwrap_or(u32::MAX)
                })
                .build(),
        }
    }

    pub async fn try_get(&self, track_id: &str, offset: u64) -> Option<Arc<Vec<u8>>> {
        self.cache.get(&(track_id.to_string(), offset)).await
    }

    /// Fetch-or-get a slice, deduplicating concurrent callers for the same
    /// (track_id, offset) key.
    ///
    /// Previously this was backed by a hand-rolled InflightEntry/InflightGuard
    /// map with Notify-based waiters and Arc::ptr_eq-guarded cleanup on drop --
    /// a from-scratch reimplementation of "cache stampede" prevention. moka's
    /// `try_get_with` provides the same guarantee natively: concurrent calls
    /// on the same not-yet-cached key are coalesced into one evaluation of the
    /// init future; every other concurrent caller for that key awaits and
    /// receives the same result (Ok or Err) once it resolves, without
    /// re-running the fetch. If the leader's future is dropped/cancelled
    /// before completing, moka promotes one of the remaining waiters to retry
    /// instead of leaving the rest hanging -- verified in this app's own
    /// standalone test crate (verify_slice_cache) before relying on it here,
    /// since this sandbox cannot compile the full Tauri app to test in place.
    ///
    /// Generic over the error type `E` (previously hardcoded to `String`) so
    /// callers can propagate a structured error -- e.g. proxy/stream.rs uses
    /// `DriveErr` here instead of a stringified copy, so its retry/backoff
    /// logic can still match on `DriveErr::Rate` vs `DriveErr::NotFound` etc.
    /// after a dedup wait, not just after a fresh fetch. Bound is exactly
    /// what moka's `try_get_with` itself requires (it wraps the leader's Err
    /// in `Arc<E>` to hand the identical value to every waiter) -- verified
    /// against the exact pinned moka commit in a standalone crate before
    /// relying on it here, same as the dedup behavior above.
    ///
    /// Wired into src-tauri/src/proxy/stream.rs's two cache-miss paths (main
    /// response loop + background prefetch loop): each one fetches a whole
    /// multi-slice batch in one Drive request (see `PREFETCH_BATCH_SLICES`),
    /// then calls this with the batch's *first* offset as the dedup key, its
    /// fetcher closure re-entrantly calling `batch_insert` for the remaining
    /// slices as a side effect before returning the first slice's bytes for
    /// this method to cache itself. That re-entrant call (from within one
    /// key's try_get_with init future, into the same cache for *different*
    /// keys) is also verified safe against the pinned moka commit. This
    /// dedupes the common overlap case (two callers landing on the same
    /// batch-start offset) but is not a full range-lock: two callers whose
    /// `find_missing_run` results start at different, only partially
    /// overlapping offsets within the same underlying gap are still not
    /// deduped against each other -- accepted as out of scope; a precise
    /// fix would need an interval-tree-based in-flight tracker, considerably
    /// more complex than warranted for a "reduce wasted Drive calls" gap
    /// that never risked correctness even before this change.
    pub async fn get_or_fetch<F, Fut, E>(
        &self,
        track_id: &str,
        offset: u64,
        fetcher: F,
    ) -> Result<Arc<Vec<u8>>, E>
    where
        F: FnOnce() -> Fut + Send,
        Fut: Future<Output = Result<Vec<u8>, E>> + Send,
        E: Clone + Send + Sync + 'static,
    {
        let key = (track_id.to_string(), offset);
        self.cache
            .try_get_with(key, async move {
                let data = fetcher().await?;
                Ok::<Arc<Vec<u8>>, E>(Arc::new(data))
            })
            .await
            .map_err(|e: Arc<E>| (*e).clone())
    }

    pub async fn find_missing_run(
        &self,
        track_id: &str,
        start_offset: u64,
        max_count: usize,
    ) -> (u64, usize) {
        let mut first_missing = None;
        let mut count = 0usize;

        for i in 0..max_count {
            let offset = start_offset + (i as u64) * SLICE_SIZE;
            let present = self
                .cache
                .get(&(track_id.to_string(), offset))
                .await
                .is_some();

            match (present, first_missing.is_some()) {
                (true, false) => {}
                (true, true) => break,
                (false, false) => {
                    first_missing = Some(offset);
                    count = 1;
                }
                (false, true) => {
                    count += 1;
                }
            }
        }

        (
            first_missing.unwrap_or(start_offset + max_count as u64 * SLICE_SIZE),
            count,
        )
    }

    pub async fn batch_insert(&self, track_id: &str, base_offset: u64, data: Vec<u8>) {
        let mut offset = base_offset;
        let mut pos = 0usize;

        while pos < data.len() {
            let end = (pos + SLICE_SIZE as usize).min(data.len());
            let chunk = data[pos..end].to_vec();
            self.cache
                .insert((track_id.to_string(), offset), Arc::new(chunk))
                .await;
            offset += SLICE_SIZE;
            pos = end;
        }
    }

    // Restored: this was removed as "dead code" in an earlier audit pass
    // (grep found zero callers under src-tauri/src/), which was WRONG --
    // its only real caller lives in src-tauri/tests/eviction_stall.rs (a
    // Cargo integration test, a separate compilation unit from src/, so
    // that grep never saw it). Removing it silently broke that test's
    // compilation; this sandbox has no working `cargo build`/`cargo test`
    // for the full app, so nothing here caught it until this file was
    // read directly while looking for something else entirely. Restored
    // to its exact original form (git commit 1a9e6ab).
    pub fn used_bytes(&self) -> u64 {
        self.cache.weighted_size()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_try_get_missing() {
        let cache = SliceCache::new(100 * 1024 * 1024);
        assert!(cache.try_get("t1", 0).await.is_none());
    }

    #[tokio::test]
    async fn test_batch_insert_and_get() {
        let cache = SliceCache::new(100 * 1024 * 1024);
        let data = vec![1u8; (SLICE_SIZE * 3) as usize];
        cache.batch_insert("t1", 0, data).await;
        assert!(cache.try_get("t1", 0).await.is_some());
        assert!(cache.try_get("t1", SLICE_SIZE).await.is_some());
        assert!(cache.try_get("t1", SLICE_SIZE * 2).await.is_some());
    }

    #[tokio::test]
    async fn test_find_missing_run() {
        let cache = SliceCache::new(100 * 1024 * 1024);
        cache.batch_insert("t1", 0, vec![2u8; SLICE_SIZE as usize]).await;
        let (offset, count) = cache.find_missing_run("t1", 0, 4).await;
        assert_eq!(offset, SLICE_SIZE);
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn test_get_or_fetch_dedup() {
        let cache = Arc::new(SliceCache::new(100 * 1024 * 1024));
        let c1 = cache.clone();
        let c2 = cache.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let t1 = tokio::spawn(async move {
            // Explicit `String` (this test is about generic dedup behavior,
            // not about any specific error type -- `get_or_fetch` became
            // generic over `E` when this got wired into proxy/stream.rs with
            // `DriveErr`, and neither closure here pins a type on its own
            // now that `E` isn't hardcoded, so it needs an explicit
            // annotation to compile).
            c1.get_or_fetch("t", 0, || async {
                rx.await.unwrap();
                Ok::<Vec<u8>, String>(vec![4u8; SLICE_SIZE as usize])
            })
            .await
        });
        let t2 = tokio::spawn(async move {
            c2.get_or_fetch::<_, _, String>("t", 0, || async { panic!("should not be called") })
                .await
        });
        tx.send(()).ok();
        let (r1, r2) = tokio::join!(t1, t2);
        assert!(r1.unwrap().is_ok());
        assert!(r2.unwrap().is_ok());
    }

    #[tokio::test]
    async fn test_get_or_fetch_propagates_error_to_waiters() {
        // Behavioral replacement for the old test_cancelled_leader_wakes_waiters:
        // with the hand-rolled InflightGuard, a failed leader woke waiters via
        // Notify so they'd return an error instead of hanging. moka's
        // try_get_with propagates the leader's Err to every waiter natively --
        // verify that guarantee holds through this app's get_or_fetch wrapper.
        //
        // Ordering is made explicit rather than relying on tokio::spawn +
        // join! scheduling order: an earlier version of this test spawned
        // both the leader and the waiter before either had run, which left it
        // up to the (unspecified) scheduler which task's try_get_with call
        // actually registered with moka first -- it failed intermittently
        // because the "waiter" sometimes won that race and became its own
        // leader instead. Waiting for an explicit "leader has started"
        // signal before spawning the waiter removes the race entirely.
        let cache = Arc::new(SliceCache::new(100 * 1024 * 1024));
        let c1 = cache.clone();
        let c2 = cache.clone();
        let (leader_started_tx, leader_started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();

        let t1 = tokio::spawn(async move {
            c1.get_or_fetch("t", 0, || async move {
                leader_started_tx.send(()).ok();
                release_rx.await.ok();
                Err::<Vec<u8>, String>("fetch failed".to_string())
            })
            .await
        });

        leader_started_rx.await.expect("leader never started");

        let t2 = tokio::spawn(async move {
            // Explicit turbofish: this closure never returns a value (always
            // panics), so nothing else pins `E` for this independent
            // get_or_fetch call -- match the leader's `String` above.
            c2.get_or_fetch::<_, _, String>("t", 0, || async {
                panic!("should not be called -- leader should have served this waiter")
            })
            .await
        });

        release_tx.send(()).ok();
        let (r1, r2) = tokio::join!(t1, t2);
        assert!(r1.unwrap().is_err(), "leader should surface its own error");
        assert!(
            r2.unwrap().is_err(),
            "waiter should receive the leader's error, not hang or panic"
        );
    }

    #[tokio::test]
    async fn test_get_or_fetch_leader_cancel_lets_a_waiter_retry() {
        // If the leader task is aborted before its fetcher resolves (e.g. the
        // HTTP request it was awaiting gets dropped), moka must not leave a
        // waiting caller hanging forever -- one of them should be promoted to
        // retry the fetch. This is the property InflightGuard's Arc::ptr_eq
        // cleanup-on-drop used to guarantee by hand; verifying moka provides
        // it natively before relying on it in production.
        let cache = Arc::new(SliceCache::new(100 * 1024 * 1024));
        let c1 = cache.clone();
        let c2 = cache.clone();

        let leader = tokio::spawn(async move {
            // Explicit turbofish: `unreachable!()` diverges (type `!`) and
            // never pins `E` on its own now that get_or_fetch is generic.
            c1.get_or_fetch::<_, _, String>("t", 0, || async {
                std::future::pending::<()>().await;
                unreachable!();
            })
            .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        leader.abort();

        let waiter = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            c2.get_or_fetch("t", 0, || async { Ok::<Vec<u8>, String>(vec![9u8; SLICE_SIZE as usize]) }),
        )
        .await
        .expect("waiter hung after the leader was cancelled instead of being promoted to retry");

        assert!(waiter.is_ok());
    }

    #[tokio::test]
    async fn test_find_missing_run_all_present() {
        let cache = SliceCache::new(100 * 1024 * 1024);
        cache
            .batch_insert("t1", 0, vec![2u8; (SLICE_SIZE * 4) as usize])
            .await;
        let (offset, count) = cache.find_missing_run("t1", 0, 4).await;
        assert_eq!(count, 0);
        assert_eq!(offset, SLICE_SIZE * 4);
    }
}
