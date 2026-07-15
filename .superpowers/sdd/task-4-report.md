# Task 4 Report: Frontend — Next-track audio data prefetch

## What I implemented

1. **`src/utils/nextTrackPrefetcher.ts`** (new) — Module that warms the Rust proxy cache by issuing a Range request for the first 512KB of the next track's stream URL. Features:
   - `prefetchNextTrackAudio(streamUrl)`: issues `fetch` with `Range: bytes=0-524287`, dedup via `Set<string>`, max 3 concurrent with LRU-eviction, 15s abort timeout
   - `clearNextTrackPrefetches()`: aborts all in-flight fetches and clears state

2. **`src/utils/nextTrackPrefetcher.test.ts`** (new) — 2 tests:
   - Verifies correct Range header and AbortSignal on fetch
   - Verifies second call with same URL is no-op (dedup works)

3. **`src/hooks/usePlayer.ts`** (modified) — Integrated prefetch in two paths:
   - **Prefetched path** (line 253): finds next track in `contextQueue`, uses `getPrefetchedStreamUrl(nextTrack.id)` for existing prefetched URL, otherwise invokes `get_stream_url`
   - **Normal path** (line 312): same pattern, always invokes `get_stream_url`
   - Added imports for `prefetchNextTrackAudio` and `clearNextTrackPrefetches`

4. **`src/ui/MainContent/MainContent.tsx`** (modified) — Added `clearNextTrackPrefetches()` call alongside `clearPrefetchedStreams()` on folder change

## What I tested and test results

- `npx vitest run src/utils/nextTrackPrefetcher.test.ts` → **PASS** (2/2)
- `npx vitest run` → **PASS** (50 tests across 9 files, all pass)

## TDD Evidence (RED → GREEN)

**RED:** `npx vitest run src/utils/nextTrackPrefetcher.test.ts` — FAIL (module not found, both tests fail)
**GREEN:** Same command after creating implementation — PASS (2/2)

Initial failure used `require()` in the second test (from brief), which doesn't work in ESM mode (`"type": "module"`). Fixed to use top-level `import` and replaced placeholder `expect(true).toBe(true)` with meaningful `expect(mockFetch).toHaveBeenCalledTimes(1)`.

## Files changed

| File | Action |
|------|--------|
| `src/utils/nextTrackPrefetcher.ts` | Created (96 lines) |
| `src/utils/nextTrackPrefetcher.test.ts` | Created (39 lines) |
| `src/hooks/usePlayer.ts` | Modified (+48 lines) |
| `src/ui/MainContent/MainContent.tsx` | Modified (+2 lines) |

## Self-review findings

- Dedup via `Set<string>` prevents redundant fetches for the same track
- `MAX_CONCURRENT=3` with eviction bounds memory/resource usage
- 15s abort timeout prevents hung requests from leaking
- `.catch(() => {})` silently swallows errors (intentional: best-effort prefetch)
- Errored/finished fetches clean up from both `warmingTracks` and `abortControllers`
- Edge case: last track in queue → no prefetch (correct — nothing follows)
- Edge case: empty/absent contextQueue → gracefully skipped (correct)
- Concern: `clearNextTrackPrefetches` is only called on folder change in MainContent, not on logout. Acceptable since the 15s timeout handles cleanup and the abort controllers are scoped to the session.

## Issues or concerns

None. Implementation follows the brief exactly (with minor ESM adaptation for the test file).
