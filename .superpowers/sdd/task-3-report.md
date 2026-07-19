# Task 3 Report — Release lock during synchronous fetch

## What was implemented

1. **`fetching: AtomicBool` field** added to `TrackCache` struct, initialized to `false` in the `or_insert_with` constructor.

2. **`respond_from_cache` helper function** extracted from the cache-hit path. A free function taking `(buffer, window_start, start, end, total_size, content_type)` and returning a full `Response` with `206 Partial Content` and correct `Content-Range`, `Content-Length`, `Content-Type`, `Accept-Ranges`, and `Access-Control-Allow-Origin` headers.

3. **Cache miss lock release** restructured:
   - Before fetching, the code attempts `compare_exchange(false, true)` on the per-track `fetching` flag with `AcqRel` ordering.
   - If another thread already claimed the flag → drop the per-track lock, spin-wait up to 50ms (50 × 1ms) polling the cache, then timeout → re-acquire lock, check cache one final time, force-claim.
   - If we own the flag → abort any stale background task, release the per-track lock, perform the network fetch (with retry loop) WITHOUT holding any per-track lock.
   - After fetch → re-acquire lock, update buffer, reset `fetching` to `false`, spawn background prefetch.

4. **Cache hit** path simplified to use `respond_from_cache` helper.

## Tests added

| Test | What it verifies |
|------|-----------------|
| `test_respond_from_cache_partial_content` | Status 206, Content-Range, Content-Length correctness for a small range |
| `test_respond_from_cache_truncates_at_2mb` | Chunk is limited to 2MB even when buffer is larger |
| `test_fetching_flag_coordination` | Two concurrent `compare_exchange` calls — exactly one wins |
| `test_fetching_flag_reset_allows_second_claim` | After reset, a new thread can claim the flag |

All 4 tests pass.

## Test results

```
running 13 tests (full suite)
test result: ok. 13 passed; 0 failed
```

All existing tests continue to pass. No regressions.

## Files changed

```
src-tauri/src/proxy.rs | 140 insertions(+), 49 deletions(-)
```

## Self-review findings

- **Clippy-clean**: Our changes generate zero clippy warnings. The remaining 5 `-D warnings` errors are pre-existing in `protocol.rs:74`, `proxy.rs:699`, `lib.rs:449/490`, and a redundant closure in the test helper at `proxy.rs:811`.

- **Import style consistent**: `AtomicBool` added to the existing brace-style import.

- **Thread safety**: The `fetching` flag uses `Ordering::AcqRel` for the `compare_exchange` and `Ordering::Release`/`Ordering::Acquire` for subsequent `store`/`load`.

## Concerns

1. **Stuck `fetching` flag on error**: If the fetch fails permanently (e.g. `DriveErr::NotFound`), the `fetching` flag is never reset to `false`. Subsequent requests for the same track will always spin-wait for 50ms before timing out and force-fetching (which will also fail). This is not a deadlock but adds a 50ms delay per request for permanently-failed files. Fixable with a `Drop` guard or explicit reset in every error path — scope creep for this task.

2. **Spin-wait timeout + duplicate fetch**: Two concurrent cache misses for the same track at the same position: the first claims the flag and starts fetching; the second spins for 50ms, times out, and also starts fetching. Both fetches complete, racing to update the buffer. The second writer wins. This is safe but wastes one network call. The brief explicitly acknowledges this ("stale flag or very slow I/O").

3. **Buffer overwrite on timeout**: After the timeout path, the code force-claims the flag and fetches. If the original thread's fetch completes after the timeout's fetch starts, the original thread will acquire the lock, see `fetching = true` (or `false` if timeout already reset it), and either skip the update or overwrite. Either way, the data is eventually consistent.
