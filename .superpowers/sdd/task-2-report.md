# Task 2 Report — Migrate `metadata.ts` to `db.metadataCache`

- status: DONE
- commits: `0f0fc17` refactor: metadata cache -> Dexie metadataCache table
- test summary: `npx vitest run src/utils/metadata` → 2 files, 7 passed. `npx tsc --noEmit` clean.
- concerns: None. `updateTrackDuration` previously called `set(key, entry)` with a full CacheEntry; now uniformly routed through `putCacheEntry`/`getCacheEntry` helpers, preserving the `{version,data,ts}` wrapper shape. `idb-keyval` left installed (still used by `src/db/storage.ts` until Task 6). Concurrency test mock retargeted to `../db/db` with an in-memory Map-backed `metadataCache` stub.
