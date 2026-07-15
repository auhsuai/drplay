### Task 3: Rust Proxy — Release lock during initial synchronous fetch

**Files:**
- Modify: `src-tauri/src/proxy.rs` (TrackCache struct, cache miss path at lines 39-48, 455-541)

**Interfaces:**
- Consumes: `TrackCache` struct, `cache_store` global, `respond_from_cache()` helper
- Produces: Lock-free network I/O — `TrackCache.fetching` flag allows concurrent requests to short-circuit

- [ ] **Step 1: Add `fetching` field to TrackCache**

Add `fetching: bool` to the `TrackCache` struct. Since this field is read/written outside the per-track Mutex, use `AtomicBool` instead of a nested `Mutex<bool>`:

```rust
use std::sync::atomic::{AtomicBool, Ordering};

struct TrackCache {
    buffer: Vec<u8>,
    window_start: u64,
    fetch_task: Option<JoinHandle<()>>,
    total_size: u64,
    content_type: String,
    accessed_at: u64,
    fetching: AtomicBool,
}
```

Initialize to `AtomicBool::new(false)` in the `or_insert_with` closure at the cache entry creation point.

- [ ] **Step 2: Extract `respond_from_cache` helper**

The cache-hit response logic (currently proxy.rs:459-487) needs to be callable from both the normal cache-hit path and the spin-wait path:

```rust
fn respond_from_cache(buffer: &[u8], window_start: u64, start: u64, end: u64, total_size: u64, content_type: &str) -> Response {
    let offset = (start - window_start) as usize;
    let mut read_end = (end.saturating_sub(window_start) + 1) as usize;
    read_end = read_end.min(buffer.len());
    let mut chunk_size = read_end.saturating_sub(offset);
    let max_chunk = 2 * 1024 * 1024;
    if chunk_size > max_chunk {
        chunk_size = max_chunk;
        read_end = offset + chunk_size;
    }
    let chunk = buffer[offset..read_end].to_vec();
    let real_end = start + chunk.len() as u64 - 1;

    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, real_end, total_size))
        .header(header::CONTENT_LENGTH, chunk.len().to_string())
        .body(axum::body::Body::from(chunk))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build body").into_response())
}
```

- [ ] **Step 3: Restructure cache miss to release lock**

Replace the existing cache miss path (after `} else {` at line 488) with:

```rust
} else {
    // Check if another thread is already fetching for this position
    if track_cache.fetching.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        // Another request is fetching — wait briefly then check cache
        drop(track_cache);
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            let tc = track_cache_arc.lock().await;
            let window_end = tc.window_start + tc.buffer.len() as u64;
            if start >= tc.window_start && start < window_end {
                return respond_from_cache(&tc.buffer, tc.window_start, start, end, total_size, &tc.content_type);
            }
            drop(tc);
        }
        // Timeout — proceed to fetch ourselves (stale flag or very slow I/O)
    }

    // We own the fetching flag — safe to proceed
    // Drop per-track lock so metadata requests don't block
    drop(track_cache);

    // Abort existing fetch task
    // ... existing logic ...

    // Fetch 2MB synchronously (NO lock held)
    // ... existing fetch logic in proxy.rs:499-531 ...

    // Re-acquire per-track lock to update buffer
    let mut tc = track_cache_arc.lock().await;
    tc.window_start = start;
    tc.buffer = chunk.clone();
    tc.fetching.store(false, Ordering::Release);
    drop(tc);

    // Spawn background prefetch (same as existing code)
    // ... background spawn logic ...
}
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass — no new tests needed since this doesn't change behavior, only lock granularity

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/proxy.rs
git commit -m "perf(proxy): release per-track lock during synchronous fetch"
```
