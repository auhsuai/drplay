# Task 3 Report — Migrate `history.ts` to typed tables

- status: DONE
- commits: 8123f18 (refactor: history -> Dexie recentTracks/playCounts/folderVisits)
- test summary: `npx vitest run src/utils/history` → 8 passed (8/8). `npx tsc --noEmit` clean.
- concerns:
  - Plan's Task 3 body did not include the full replacement code (only a summary). Implemented faithfully against the actual Task 1 schema (`RecentTrackRow {id,track,userEmail,createdAt}`, `PlayCountRow {id,track,count,userEmail}`, `FolderVisitRow {id,name,count,lastVisited,userEmail}`). The brief's alternative `recentTracks {fileId,title,...}` shape does NOT exist in the repo, so it was not used.
  - `migrateHistoryToDexie()` referenced in the brief is NOT present in the committed plan; Task 1's `runStorageMigration()` in `src/db/storage.ts` already covers history migration from idb-keyval. No separate history migration function was added.
  - Schema limitation (from Task 1): `playCounts`/`folderVisits` use PK `id` shared across users, so writes must scope by `userEmail` via `.where('userEmail').equals(email).and(...)`. Reads already filter by `userEmail`. Cross-user row collisions on the same track/folder id are avoided by the userEmail-scoped write path.
  - `RECENT_CAP` kept (1000) and dedup "newest first" behavior preserved; `getHeavyRotation` caps at 10, `getMostVisitedFolders` caps at 4 — matching prior behavior.
  - `getRandomDiscoveries` now reads `db.metadataCache` filtering `entry.data.v >= 9` (per plan), replacing the old idb-keyval `keys()` scan.
  - No test file existed previously; created `src/utils/history.test.ts` using `fake-indexeddb/auto` + real `db`. `idb-keyval` left installed (still used by storage.ts/cache.ts/playlists.ts/favorites.ts per plan).
