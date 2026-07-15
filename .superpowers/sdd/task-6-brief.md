### Task 6: Frontend — Parallel metadata + stream URL fetch

**Files:**
- Modify: `src/hooks/usePlayer.ts` (lines 287-298, the "normal path" in `handlePlayTrack`)

**Interfaces:**
- Consumes: `getTrackMetadata()`, `invoke("get_stream_url")`, `getValidToken()`, `isIntentStale()`
- Produces: Parallel execution of metadata fetch and stream URL fetch (currently sequential)

- [ ] **Step 1: Understand the current code**

Read `src/hooks/usePlayer.ts` lines 277-309. The current sequential pattern:

```typescript
try {
  const metadata = await getTrackMetadata(targetTrack.id, freshToken, targetTrack.size, targetTrack.originalName);
  if (isIntentStale(myId)) return;
  if (metadata.duration) {
     accurateMetaDuration = metadata.duration;
  }
} catch (e) {
  console.warn(`[usePlayer] bitrate-buffer-fail`, classifyPlayerError(e));
}

const ext = targetTrack.originalName?.split('.').pop()?.toLowerCase();
let streamUrl = await invoke<string>("get_stream_url", { fileId: targetTrack.id, duration: accurateMetaDuration, bufferSeconds, ext });
```

The issue: `getTrackMetadata` runs first (may hit network), then `get_stream_url` runs. On an uncached track, this is 2 sequential round-trips.

- [ ] **Step 2: Write test to verify parallel behavior is safe**

No test needed for this change (it's a refactor of existing code that doesn't change external behavior). Skip to step 3.

- [ ] **Step 3: Implement parallel fetch**

Replace lines 287-298 with:

```typescript
// Parallel: fetch metadata AND stream URL concurrently
const [metadata, streamUrl] = await Promise.all([
  getTrackMetadata(targetTrack.id, freshToken, targetTrack.size, targetTrack.originalName)
    .then(m => m)
    .catch(e => {
      console.warn(`[usePlayer] bitrate-buffer-fail`, classifyPlayerError(e));
      return null;
    }),
  (async () => {
    const ext = targetTrack.originalName?.split('.').pop()?.toLowerCase();
    return invoke<string>("get_stream_url", {
      fileId: targetTrack.id,
      duration: undefined,  // We don't have metadata yet; proxy uses default
      bufferSeconds,
      ext,
    });
  })(),
]);

if (isIntentStale(myId)) return;

const accurateMetaDuration = metadata?.duration ?? undefined;
```

The key change: `duration` is now `undefined` in the stream URL request (we get it from metadata in parallel). The Rust proxy already handles this correctly since `duration` is `Option<f64>`.

- [ ] **Step 4: Run frontend tests**

Run: `npx vitest run`
Expected: All tests pass (the change is internal — no behavior difference for existing callers)

- [ ] **Step 5: Commit**

```bash
git add src/hooks/usePlayer.ts
git commit -m "perf(player): parallel metadata and stream URL fetch"
```
