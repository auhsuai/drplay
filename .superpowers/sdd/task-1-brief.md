### Task 1: Rust Proxy — Background prefetch with retry + exponential backoff

**Files:**
- Modify: `src-tauri/src/proxy.rs:560-588`
- Test: inline in `src-tauri/src/proxy.rs`

**Interfaces:**
- Consumes: `fetch_range_from_drive()`, `DriveErr` enum (Rate, Auth, NotFound, AccessDenied, DownloadQuota, Upstream)
- Produces: Background prefetch loop with retry that continues on transient errors instead of silent break

- [ ] **Step 1: Write failing test for retry behavior**

Create a test helper that simulates a flaky `fetch_range_from_drive` and asserts the background loop retries instead of breaking:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_background_prefetch_retries_on_transient_error() {
        let attempts = Arc::new(AtomicU32::new(0));
        let max_ok_after = 3u32;
        let flaky_fetch = move |start, end| {
            let a = attempts.clone();
            async move {
                let n = a.fetch_add(1, Ordering::SeqCst);
                if n < max_ok_after {
                    Err(DriveErr::Rate)
                } else {
                    Ok(vec![0u8; (end - start + 1) as usize])
                }
            }
        };
        // Simulate background loop with retry logic
        let result = simulate_background_prefetch(0, 1024 * 1024 * 4, 2 * 1024 * 1024, flaky_fetch).await;
        assert!(result.is_ok());
        assert_eq!(attempts.load(Ordering::SeqCst), 4); // 3 fails + 1 success
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test test_background_prefetch_retries_on_transient_error -- --nocapture`
Expected: FAIL — function `simulate_background_prefetch` not defined

- [ ] **Step 3: Implement retry in background prefetch**

Replace the single `if let Ok(data) = fetch_range_from_drive(...)` at `proxy.rs:567` with a retry loop:

```rust
// Inside the spawned background task (proxy.rs:562-589):
const MAX_BG_RETRIES: u32 = 3;

async fn bg_fetch_with_retry(
    client: &Client, url: &str, token: &str,
    current: u64, next_end: u64, max_retries: u32,
) -> Result<Vec<u8>, DriveErr> {
    let mut last_err = DriveErr::Upstream;
    for attempt in 0..max_retries {
        match fetch_range_from_drive(client, url, token, current, next_end).await {
            Ok(data) => return Ok(data),
            Err(DriveErr::Rate) => {
                tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                last_err = DriveErr::Rate;
            }
            Err(DriveErr::Auth) => {
                last_err = DriveErr::Auth;
                break;
            }
            Err(e @ (DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota)) => {
                return Err(e);
            }
            Err(e) => {
                tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                last_err = e;
            }
        }
    }
    Err(last_err)
}
```

Replace the while-loop body at `proxy.rs:567`:

```rust
let data = match bg_fetch_with_retry(&bg_client, &bg_url, &bg_token, current, next_end, MAX_BG_RETRIES).await {
    Ok(d) => d,
    Err(DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota) => break,
    Err(_) => {
        break;
    }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test test_background_prefetch_retries_on_transient_error -- --nocapture`
Expected: PASS

- [ ] **Step 5: Add test for hard error does not retry**

```rust
#[tokio::test]
async fn test_background_prefetch_hard_error_no_retry() {
    let attempts = Arc::new(AtomicU32::new(0));
    let hard_fetch = move |_, _| {
        let a = attempts.clone();
        async move {
            a.fetch_add(1, Ordering::SeqCst);
            Err(DriveErr::NotFound)
        }
    };
    let result = simulate_background_prefetch(0, 1024 * 1024 * 4, 2 * 1024 * 1024, hard_fetch).await;
    assert!(result.is_err());
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}
```

- [ ] **Step 6: Run hard error test**

Run: `cd src-tauri && cargo test test_background_prefetch_hard_error_no_retry -- --nocapture`
Expected: PASS

- [ ] **Step 7: Run full Rust test suite**

Run: `cd src-tauri && cargo test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/proxy.rs
git commit -m "fix(proxy): add retry with exponential backoff to background prefetch"
```
