# Task 5: Frontend — Metadata request deduplication — Report

**Status:** ✅ Complete

## Commits
- `8c01cc8` — `perf(metadata): deduplicate concurrent in-flight metadata requests`

## Changes

### `src/utils/metadata.ts`
1. Added `inflightMetadata` map and `INFLIGHT_TIMEOUT` constant (after `CACHE_VERSION`)
2. Renamed existing `getTrackMetadata` → `getTrackMetadataImpl` (internal, no export)
3. Created new `getTrackMetadata` wrapper that:
   - Checks memory cache first (fast path), bypassed when `forceNetwork=true`
   - Checks in-flight dedup, bypassed when `forceNetwork=true`
   - Delegates to `getTrackMetadataImpl`
   - Includes timeout-based cleanup (30s) to prevent stale promise leaks
   - Includes identity guard on cleanup to avoid race with replacement promises

### `src/utils/metadata.test.ts`
Added `getTrackMetadata dedup` describe block with test:
- **should deduplicate concurrent requests for same fileId** — verifies that 2 concurrent calls with same `fileId` result in only 1 network fetch

## Test Summary
- **4/4 tests pass** (3 existing + 1 new)
- Zero unhandled rejection warnings
- TypeScript: only pre-existing errors (not in changed files)

## Concerns
- None. The implementation preserves full backward compatibility (all existing callers use the same signature with all 6 params).
