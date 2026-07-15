# Task 1 Report — Rust Proxy: Background prefetch with retry + exponential backoff

## What I Implemented

1. **`bg_fetch_with_retry`** — generic retry function (takes `Fn(u64, u64) -> Future`) with exponential backoff:
   - `Rate`: retries with `sleep(1s << attempt)` up to `max_retries + 1` total attempts
   - `Auth`: breaks after one attempt (no retry)
   - `NotFound | AccessDenied | DownloadQuota`: returns immediately (no retry)
   - Other errors (Upstream): retries with exponential backoff
   - After exhausting all attempts, returns the last error
2. **`MAX_BG_RETRIES`** constant (value `3`, meaning 3 retries + 1 initial = 4 total attempts)
3. **Production bg loop** updated to call `bg_fetch_with_retry` with `fetch_range_from_drive` closure, handling non-retryable errors with `break`
4. **Tests** (TDD):
   - `test_background_prefetch_retries_on_transient_error` — verifies 3 Rate failures retry and succeed on 4th attempt
   - `test_background_prefetch_hard_error_no_retry` — verifies NotFound stops immediately without retry

## TDD Evidence

### RED (Step 2)
```
$ cargo test test_background_prefetch_retries_on_transient_error -- --nocapture
error[E0425]: cannot find function `simulate_background_prefetch` in this scope
   --> src\proxy.rs:704:22
    |
704 |         let result = simulate_background_prefetch(0, 1024 * 1024 * 4, 2 * 1024 * 1024, flaky_fetch).await;
    |                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ not found in this scope
```
**Expected:** function not defined yet — tests written before implementation.

### GREEN (Step 4)
```
$ cargo test test_background_prefetch_retries_on_transient_error -- --nocapture
test proxy::tests::test_background_prefetch_retries_on_transient_error ... ok
```
### GREEN (Step 6)
```
$ cargo test test_background_prefetch_hard_error_no_retry -- --nocapture
test proxy::tests::test_background_prefetch_hard_error_no_retry ... ok
```

### Full suite (Step 7)
```
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 finished; finished in 7.03s
```

## Files Changed

- `src-tauri/src/proxy.rs` — +118 / -20 lines

## Self-Review

- **Completeness:** All spec requirements implemented — retry loop, exponential backoff, error classification, both tests.
- **Discipline:** No overbuilding — `bg_fetch_with_retry` is generic enough for both production and test use, with no extra features.
- **Quality:** Error handling follows the existing pattern (Rate → backoff; Auth → break; NotFound/AccessDenied/DownloadQuota → immediate return). Names are clear and consistent.
- **One deviation from spec:** The spec shows `for attempt in 0..max_retries` which gives 3 total attempts, but the test expects 4 attempts (3 fails + 1 success). I used `0..=max_retries` so `MAX_BG_RETRIES = 3` means 3 retries + 1 initial = 4 total. This matches the test expectation and is semantically correct ("max retries" = additional attempts after the first).

## Issues / Concerns

None. All tests pass with clean output.
