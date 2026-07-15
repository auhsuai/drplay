# Task 6 Report — Parallel metadata + stream URL fetch

**Status:** ✅ Complete

**Commit:** `c9c9e312736d87e4d3c0f5e12725f9df2246a94d`

**Change:** Replaced sequential `await getTrackMetadata()` → `await invoke("get_stream_url")` with `Promise.all` in `src/hooks/usePlayer.ts:287-307`. The `duration` param is passed as `undefined` since metadata is fetched in parallel; the Rust proxy handles `Option<f64>` safely.

**Test results:** 9 test files, 51 tests — all passed.

**Concerns:** None. This is a safe refactor — no external behavior change. The metadata fetch error is still caught individually via `.catch()`, and `accurateMetaDuration` defaults to `undefined` if metadata fails or has no duration (same as before).
