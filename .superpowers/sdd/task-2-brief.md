### Task 2: Rust Proxy — Parallel chunk prefetching

**Files:**
- Modify: `src-tauri/src/proxy.rs:552-591` (background prefetch loop)

**Interfaces:**
- Consumes: `bg_fetch_with_retry()` from Task 1, `buffer_size_limit()`
- Produces: Concurrent 2MB chunk fetches (concurrency=4) instead of sequential

- [ ] **Step 1: Write test for parallel chunk ordering**

```rust
#[tokio::test]
async fn test_parallel_chunks_maintain_order() {
    let chunks = vec![
        (0, 1999, vec![1u8; 2000]),
        (2000, 3999, vec![2u8; 2000]),
        (4000, 5999, vec![3u8; 2000]),
    ];
    let buffer = assemble_chunks_in_order(&chunks);
    assert_eq!(buffer.len(), 6000);
    assert_eq!(buffer[0], 1);
    assert_eq!(buffer[2000], 2);
    assert_eq!(buffer[4000], 3);
}
```

- [ ] **Step 2: Run test**

Run: `cd src-tauri && cargo test test_parallel_chunks_maintain_order -- --nocapture`
Expected: FAIL — function `assemble_chunks_in_order` not defined

- [ ] **Step 3: Implement parallel chunk fetching**

Replace the sequential while-loop at `proxy.rs:562-589` with batch-based parallel fetching using `join_all`:

```rust
use futures::future::join_all;

const CONCURRENCY: usize = 4;
let task = tokio::spawn(async move {
    let limit = buffer_size_limit();
    let max_fetch = (start + limit).min(bg_total);
    let mut pending: Vec<(u64, u64)> = Vec::new();
    let mut current = background_start;

    while current < max_fetch {
        let chunk_end = (current + 2 * 1024 * 1024 - 1).min(max_fetch.saturating_sub(1));
        pending.push((current, chunk_end));
        current = chunk_end + 1;
    }

    for batch in pending.chunks(CONCURRENCY) {
        let futures: Vec<_> = batch
            .iter()
            .map(|&(cs, ce)| bg_fetch_with_retry(&bg_client, &bg_url, &bg_token, cs, ce, MAX_BG_RETRIES))
            .collect();
        let results = join_all(futures).await;

        let mut tc = bg_arc.lock().await;
        if tc.window_start != start {
            break;
        }

        let mut any_fail = false;
        for result in results {
            match result {
                Ok(data) => {
                    tc.buffer.extend_from_slice(&data);
                }
                Err(e) => {
                    any_fail = true;
                    eprintln!("[proxy] bg-prefetch-chunk-fail: {:?}", e);
                    break;
                }
            }
        }

        if let Some(app) = crate::APP_HANDLE.get() {
            let _ = app.emit("buffer-status", BufferState {
                track_id: track_id_bg.clone(),
                buffer_start_byte: tc.window_start,
                buffer_end_byte: tc.window_start + tc.buffer.len() as u64,
                total_size_byte: bg_total,
            });
        }

        if any_fail {
            break;
        }
    }
});
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test`
Expected: All tests pass (including new parallel chunk test)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/proxy.rs
git commit -m "perf(proxy): parallel 2MB chunk prefetching (concurrency=4)"
```
