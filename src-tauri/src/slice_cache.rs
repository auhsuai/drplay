use moka::future::Cache;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use tokio::sync::{Notify, RwLock};

pub const SLICE_SIZE: u64 = 512 * 1024;

pub struct InflightEntry {
    pub notify: Arc<Notify>,
    pub data: RwLock<Option<Vec<u8>>>,
}

pub struct SliceCache {
    pub cache: Cache<(String, u64), Arc<Vec<u8>>>,
    pub inflight: Arc<RwLock<HashMap<(String, u64), Arc<InflightEntry>>>>,
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
            inflight: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn try_get(&self, track_id: &str, offset: u64) -> Option<Arc<Vec<u8>>> {
        self.cache.get(&(track_id.to_string(), offset)).await
    }

    pub async fn get_or_fetch<F, Fut>(
        &self,
        track_id: &str,
        offset: u64,
        fetcher: F,
    ) -> Result<Arc<Vec<u8>>, String>
    where
        F: FnOnce() -> Fut + Send,
        Fut: Future<Output = Result<Vec<u8>, String>> + Send,
    {
        let key = (track_id.to_string(), offset);

        if let Some(data) = self.cache.get(&key).await {
            return Ok(data);
        }

        let entry;
        {
            let mut inflight = self.inflight.write().await;
            if let Some(existing) = inflight.get(&key) {
                let entry = existing.clone();
                drop(inflight);
                let notified = entry.notify.notified();
                notified.await;
                let data = entry.data.read().await;
                return data
                    .clone()
                    .map(Arc::new)
                    .ok_or_else(|| "fetch failed".to_string());
            }
            entry = Arc::new(InflightEntry {
                notify: Arc::new(Notify::new()),
                data: RwLock::new(None),
            });
            inflight.insert(key.clone(), entry.clone());
        }

        let _guard = InflightGuard { inflight: self.inflight.clone(), key: key.clone(), entry: entry.clone() };

        let result = fetcher().await;

        match result {
            Ok(data) => {
                let data_arc = Arc::new(data.clone());
                if !data.is_empty() {
                    self.cache.insert(key.clone(), data_arc.clone()).await;
                }
                let mut entry_data = entry.data.write().await;
                *entry_data = Some(data);
                entry.notify.notify_waiters();
                let mut inflight = self.inflight.write().await;
                inflight.remove(&key);
                Ok(data_arc)
            }
            Err(e) => {
                entry.notify.notify_waiters();
                let mut inflight = self.inflight.write().await;
                inflight.remove(&key);
                Err(e)
            }
        }
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

struct InflightGuard {
    inflight: Arc<RwLock<HashMap<(String, u64), Arc<InflightEntry>>>>,
    key: (String, u64),
    // Identity token for this guard's own map entry (mirrors proxy.rs's
    // CancelGuard). Without this, a newer request for the same key that
    // inserted its OWN fresh entry between this guard being created and it
    // dropping could have its entry wrongly removed by this (stale) guard —
    // stranding whatever is waiting on the newer entry's `notify`. Checked
    // via `Arc::ptr_eq` rather than the key alone so we only ever remove
    // exactly the entry this guard was created for.
    entry: Arc<InflightEntry>,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        // Fast path: best-effort synchronous removal.
        if let Ok(mut guard) = self.inflight.try_write() {
            if guard.get(&self.key).map(|e| Arc::ptr_eq(e, &self.entry)).unwrap_or(false) {
                guard.remove(&self.key);
            }
            return;
        }
        // Contention fallback: spawn an async task to remove the entry.
        // This ensures inflight entries never leak even under concurrent
        // write-lock contention, fixing the root cause where try_write()
        // silently fails and leaves waiters hung forever.
        let inflight = self.inflight.clone();
        let key = self.key.clone();
        let entry = self.entry.clone();
        tokio::spawn(async move {
            let mut guards = inflight.write().await;
            if guards.get(&key).map(|e| Arc::ptr_eq(e, &entry)).unwrap_or(false) {
                guards.remove(&key);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn test_inflight_guard_does_not_leak_on_concurrent_lock() {
        let cache = Arc::new(SliceCache::new(100 * 1024 * 1024));
        let key = ("leak-test".to_string(), 0u64);

        // Insert entry into inflight
        let entry = Arc::new(InflightEntry {
            notify: Arc::new(Notify::new()),
            data: RwLock::new(None),
        });
        {
            let mut inflight = cache.inflight.write().await;
            inflight.insert(key.clone(), entry.clone());
        }

        let cache_clone = cache.clone();
        let (lock_held_tx, lock_held_rx) = tokio::sync::oneshot::channel::<()>();

        // Task that holds the write lock on inflight while guard::drop runs
        let lock_handle = tokio::spawn(async move {
            let _lock = cache_clone.inflight.write().await;
            let _ = lock_held_tx.send(());
            tokio::time::sleep(Duration::from_millis(100)).await;
            drop(_lock);
        });

        // Wait for lock to be acquired by the other task
        lock_held_rx.await.unwrap();

        // Drop InflightGuard while another task holds the write lock.
        // BUG: try_write() silently fails → entry leaks.
        // FIX: fallback spawn removes the entry after the lock is released.
        {
            let guard = InflightGuard {
                inflight: cache.inflight.clone(),
                key: key.clone(),
                entry: entry.clone(),
            };
            drop(guard);
        }

        lock_handle.await.unwrap();

        // Verify entry was removed
        let inflight = cache.inflight.read().await;
        assert!(
            inflight.is_empty(),
            "inflight entry leaked after InflightGuard::drop"
        );
    }

    #[tokio::test]
    async fn test_stale_inflight_guard_does_not_remove_newer_entry() {
        // Identity-check hardening (mirrors proxy.rs's CancelGuard): a guard
        // built for an OLD entry must not remove a NEWER entry that has since
        // taken over the same key, even though the map key matches.
        let cache = Arc::new(SliceCache::new(100 * 1024 * 1024));
        let key = ("stale-test".to_string(), 0u64);

        let old_entry = Arc::new(InflightEntry {
            notify: Arc::new(Notify::new()),
            data: RwLock::new(None),
        });
        let stale_guard = InflightGuard {
            inflight: cache.inflight.clone(),
            key: key.clone(),
            entry: old_entry.clone(),
        };

        // A newer request for the same key replaces the map entry (as
        // get_or_fetch's insert would) — `old_entry`/`stale_guard` no longer
        // reflect what's actually stored.
        let new_entry = Arc::new(InflightEntry {
            notify: Arc::new(Notify::new()),
            data: RwLock::new(None),
        });
        {
            let mut inflight = cache.inflight.write().await;
            inflight.insert(key.clone(), new_entry.clone());
        }

        // Dropping the stale guard must NOT remove the newer entry.
        drop(stale_guard);

        let inflight = cache.inflight.read().await;
        let current = inflight.get(&key);
        assert!(
            current.is_some() && Arc::ptr_eq(current.unwrap(), &new_entry),
            "stale InflightGuard removed a newer entry for the same key"
        );
    }

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
            c1.get_or_fetch("t", 0, || async {
                rx.await.unwrap();
                Ok(vec![4u8; SLICE_SIZE as usize])
            })
            .await
        });
        let t2 = tokio::spawn(async move {
            c2.get_or_fetch("t", 0, || async { panic!("should not be called") })
                .await
        });
        tx.send(()).ok();
        let (r1, r2) = tokio::join!(t1, t2);
        assert!(r1.unwrap().is_ok());
        assert!(r2.unwrap().is_ok());
    }
}
