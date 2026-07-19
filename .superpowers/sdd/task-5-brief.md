### Task 5: Frontend — Metadata request deduplication

**Files:**
- Modify: `src/utils/metadata.ts`
- Test: `src/utils/metadata.test.ts`

**Interfaces:**
- Consumes: existing `getTrackMetadata()` function
- Produces: In-flight promise dedup — if 2 callers request same `fileId` concurrently, only 1 network call is made

- [ ] **Step 1: Write test for dedup**

Add to `src/utils/metadata.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('getTrackMetadata dedup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('should deduplicate concurrent requests for same fileId', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-range', 'bytes 0-0/1000']]),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
    // Replace global fetch
    const origFetch = global.fetch;
    global.fetch = mockFetch;

    try {
      const { getTrackMetadata } = await import('./metadata');
      
      // Start two concurrent requests for the same fileId
      const p1 = getTrackMetadata('dedup-test-id', 'test-token', 1000, 'test.mp3');
      const p2 = getTrackMetadata('dedup-test-id', 'test-token', 1000, 'test.mp3');

      await Promise.all([p1, p2]);

      // Should only have made 1 network call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = origFetch;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/metadata.test.ts`
Expected: FAIL (some tests pass, but the new dedup test fails with >1 calls)

- [ ] **Step 3: Implement dedup in metadata.ts**

Read the full `src/utils/metadata.ts` first to understand the current structure. Then:

1. Add a module-level `inflightMetadata` map near the top of the file (after imports):

```typescript
const inflightMetadata = new Map<string, Promise<MetadataResult>>();
const INFLIGHT_TIMEOUT = 30_000;
```

2. Rename the existing `getTrackMetadata` function to `async function getTrackMetadataImpl(...)`.

3. Create a new `getTrackMetadata` wrapper that checks `inflightMetadata`:

```typescript
export async function getTrackMetadata(
  fileId: string,
  token: string,
  fileSize?: number,
  originalName?: string,
): Promise<MetadataResult> {
  // Check memory cache first (fast path)
  const cached = metadataCache[fileId];
  if (cached && cached.v >= 9) return cached.data;

  // Check in-flight dedup
  const existing = inflightMetadata.get(fileId);
  if (existing) return existing;

  // Start new fetch
  const promise = getTrackMetadataImpl(fileId, token, fileSize, originalName)
    .finally(() => {
      inflightMetadata.delete(fileId);
    });

  inflightMetadata.set(fileId, promise);
  return promise;
}
```

4. Make sure timeout protection is in place (the `INFLIGHT_TIMEOUT` constant is available but the `.finally` cleanup handles the normal case).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/utils/metadata.test.ts`
Expected: ALL tests pass (including new dedup test)

- [ ] **Step 5: Commit**

```bash
git add src/utils/metadata.ts src/utils/metadata.test.ts
git commit -m "perf(metadata): deduplicate concurrent in-flight metadata requests"
```
