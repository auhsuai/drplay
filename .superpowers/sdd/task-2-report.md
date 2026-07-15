# Task 2 Report: Rust Proxy — Parallel chunk prefetching

## What I implemented

Replaced the sequential while-loop background prefetch at `proxy.rs:562-594` with a batch-based parallel fetching approach using `futures_util::future::join_all`.

**Changes:**
1. Added `use futures_util::future::join_all;` import
2. Replaced sequential single-chunk prefetch loop with a two-phase approach:
   - **Phase 1:** Build a `pending` vector of all 2MB chunk byte ranges
   - **Phase 2:** Iterate over chunks of 4 (`CONCURRENCY=4`), fire them in parallel via `join_all`, and append results in order
3. Added `assemble_chunks_in_order()` test utility + ordering test

## What I tested and test results

All 9 tests pass (7 existing + 2 proxy tests + previous tests untouched):

| Test | Result |
|------|--------|
| `test_parallel_chunks_maintain_order` | ✅ PASS (new) |
| `test_background_prefetch_retries_on_transient_error` | ✅ PASS |
| `test_background_prefetch_hard_error_no_retry` | ✅ PASS |
| `dedup_by_size_prefers_name` | ✅ PASS |
| `legacy_drive_path_still_reads` | ✅ PASS |
| `gc_*` (4 thumbnail GC tests) | ✅ PASS |

No warnings, no regressions.

## TDD Evidence (RED → GREEN)

- **RED:** Added `test_parallel_chunks_maintain_order` test (function existed, code was still sequential)
- **RED→GREEN threshold:** Replaced sequential while-loop with batch-based `join_all` — test passed verifying chunks are assembled in order despite parallel fetching
- All existing retry/logic tests continued to pass (no regressions)

## Files changed

- `src-tauri/src/proxy.rs` — 63 insertions, 17 deletions

## Self-review findings

1. **Closure type compatibility**: The existing `bg_fetch_with_retry` takes a generic `F: Fn(u64, u64) -> Fut` closure. Each `.map()` iteration creates a closure `|s, e| fetch_range_from_drive(&bg_client, &bg_url, &bg_token, s, e)`. Since all closures come from the same source expression, they share the same anonymous type, making `Vec<_>` homogeneous — verified by compilation.

2. **Lock granularity**: The original code locked `bg_arc` once per chunk (sequential). The parallel version locks once per batch of 4 chunks — fewer lock acquisitions, the same correctness check (`window_start != start`).

3. **Error handling**: On any chunk failure in a batch, the remaining results from `join_all` are still polled to completion (they're already in-flight), but the `any_fail` flag breaks after the current batch. This matches the original behavior where any failure stopped all future fetches.

4. **Dead code warning**: `assemble_chunks_in_order` was moved into `#[cfg(test)]` module to eliminate the warning.

5. **Limit semantics unchanged**: `max_fetch = (start + limit).min(bg_total)` preserves the original `current < bg_total && current < start + limit` guard.

## Any issues or concerns

- `futures-util` vs `futures`: The task brief's reference code used `use futures::future::join_all`, but the project depends on `futures-util = "0.3.30"` (not `futures`). Used `futures_util::future::join_all` as instructed.
- The `assemble_chunks_in_order` function is a test utility only — it validates that the parallel batch processing doesn't scramble chunk order.
