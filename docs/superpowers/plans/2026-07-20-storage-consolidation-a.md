# Storage Consolidation — Option A (typed Dexie tables) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `idb-keyval` entirely and model client storage as typed Dexie tables (single source of truth), including a one-time data migration from the old idb-keyval store so existing users keep their playlists/history/session.

**Architecture:** Extend the existing `DrPlayDriveDB` Dexie instance with typed tables: `kv` (simple key/value flags), `playlists`, `recentTracks`, `playCounts`, `folderVisits`, `metadataCache`. `favorites` already lives in Dexie. A startup migration reads the old idb-keyval store (still present on disk for existing users) and copies data into the new tables, then marks done via a localStorage flag. New installs have an empty idb-keyval store so migration is a no-op. After migration + all call-site switches, `idb-keyval` is uninstalled.

**Tech Stack:** Dexie 4 (`src/db/db.ts` singleton), `fake-indexeddb` (dev), React 19 + Vite 7 + Tauri 2.

## Global Constraints
- Error handling: every external call keeps classified try/catch + contextual log + safe fallback (Luật 4). No swallowed `catch(e)`.
- No secrets/tokens in logs.
- `metadata_${fileId}` cache semantics MUST stay identical (LRU list `__drplay_metadata_lru` in localStorage; `CacheEntry {version, data, ts}` shape; v>=9 = fully parsed).
- `favorites` stays on Dexie (already). Do not regress.
- Public function signatures of `history.ts`, `playlists.ts`, `usePlayer` session APIs, `cache.ts` MUST stay the same (callers unchanged) — only the backing store changes.
- `tsc --noEmit` clean and `vitest` green (ignore the known `errorCapture.test.ts` flake) after every task.
- Migration must be idempotent and non-destructive (never delete old data before new data is written + verified).

---

### Task 1: Dexie schema — typed tables + `kv` helper

**Files:**
- Modify: `src/db/db.ts` (add tables, bump to version 4)
- Create: `src/db/kv.ts` (typed `kv` table helper for simple flags)
- Create: `src/db/storage.ts` (migration orchestrator: copy idb-keyval → Dexie once)

**Interfaces produced:**
- `db.kv` table `{key: string, value: any}` primary key `key`
- `db.playlists` table `{id, name, createdAt, tracks, coverImage, userEmail}`
- `db.recentTracks` table `{id, track, userEmail, createdAt}`
- `db.playCounts` table `{id, track, count, userEmail}`
- `db.folderVisits` table `{id, name, count, lastVisited, userEmail}`
- `db.metadataCache` table `{key, entry}` primary key `key` (key = `metadata_${fileId}`)
- `kv.get<T>(key)`, `kv.set(key,value)`, `kv.del(key)` (simple flags)
- `runStorageMigration(): Promise<void>` (idempotent, called once at startup)

- [ ] **Step 1: Write failing test** `src/db/db.test.ts`
```ts
import 'fake-indexeddb/auto';
import { db } from './db';
import { get as kvGet, set as kvSet } from './kv';
import { runStorageMigration } from './storage';

describe('Dexie storage schema', () => {
  it('exposes typed tables and kv helper', async () => {
    await kvSet('drplay_buffer_seconds', 1400);
    expect(await kvGet('drplay_buffer_seconds')).toBe(1400);
    expect(db.playlists).toBeDefined();
    expect(db.recentTracks).toBeDefined();
    expect(db.metadataCache).toBeDefined();
  });
  it('runStorageMigration is idempotent and safe with empty idb', async () => {
    await runStorageMigration();
    await runStorageMigration();
  });
});
```

- [ ] **Step 2: Run test → FAIL** (`npx vitest run src/db/db.test.ts`)
- [ ] **Step 3: Implement**

`src/db/db.ts` — add imports + tables + version 4:
```ts
import Dexie, { Table } from 'dexie';

export interface DriveFile { id: string; name: string; mimeType: string; parentId: string; size?: number; modifiedTime?: string; trashed: boolean; isFolder: boolean; metadata?: any; }
export interface SyncState { key: string; value: any; }
export interface ErrorLogEntry { id: string; ts: number; level: 'error'|'warn'|'info'; source: string; message: string; stack?: string; kind?: string; }

export interface KvRow { key: string; value: any; }
export interface PlaylistRow { id: string; name: string; createdAt: number; tracks: any[]; coverImage?: string; userEmail: string; }
export interface RecentTrackRow { id: string; track: any; userEmail: string; createdAt: number; }
export interface PlayCountRow { id: string; track: any; count: number; userEmail: string; }
export interface FolderVisitRow { id: string; name: string; count: number; lastVisited: number; userEmail: string; }
export interface MetadataCacheRow { key: string; entry: any; }

export class DriveDatabase extends Dexie {
  files!: Table<DriveFile, string>;
  syncState!: Table<SyncState, string>;
  favorites!: Table<any, string>;
  errorLogs!: Table<ErrorLogEntry, string>;
  kv!: Table<KvRow, string>;
  playlists!: Table<PlaylistRow, string>;
  recentTracks!: Table<RecentTrackRow, string>;
  playCounts!: Table<PlayCountRow, string>;
  folderVisits!: Table<FolderVisitRow, string>;
  metadataCache!: Table<MetadataCacheRow, string>;

  constructor() {
    super('DrPlayDriveDB');
    this.version(2).stores({ files: 'id, parentId, name, isFolder', syncState: 'key', favorites: 'id, userEmail' });
    this.version(3).stores({ files: 'id, parentId, name, isFolder', syncState: 'key', favorites: 'id, userEmail', errorLogs: 'id, ts' });
    this.version(4).stores({
      files: 'id, parentId, name, isFolder',
      syncState: 'key',
      favorites: 'id, userEmail',
      errorLogs: 'id, ts',
      kv: 'key',
      playlists: 'id, userEmail',
      recentTracks: 'id, userEmail, createdAt',
      playCounts: 'id, userEmail',
      folderVisits: 'id, userEmail',
      metadataCache: 'key'
    });
  }
}
export const db = new DriveDatabase();
```

`src/db/kv.ts`:
```ts
import { db } from './db';
export async function get<T = any>(key: string): Promise<T | undefined> {
  const row = await db.kv.get(key);
  return row?.value as T | undefined;
}
export async function set(key: string, value: any): Promise<void> {
  await db.kv.put({ key, value });
}
export async function del(key: string): Promise<void> {
  await db.kv.delete(key);
}
```

`src/db/storage.ts` (migration — uses idb-keyval only to READ old data; this is the LAST place idb-keyval is imported, removed in Task 6):
```ts
import { db } from './db';
import { get as idbGet, keys as idbKeys } from 'idb-keyval';

const MIGRATION_FLAG = 'drplay_storage_migrated_v4';

function userEmail(): string {
  return localStorage.getItem('drplay_current_user_email') || 'default';
}

export async function runStorageMigration(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATION_FLAG)) return;
    const email = userEmail();

    // playlists
    const oldPlaylists = await idbGet<any[]>(emailKey('drplay_playlists'));
    if (oldPlaylists?.length) {
      await db.playlists.bulkPut(oldPlaylists.map(p => ({ ...p, userEmail: email })));
    }
    // recent tracks
    const oldRecent = await idbGet<any[]>(emailKey('drplay_recent_tracks'));
    if (oldRecent?.length) {
      await db.recentTracks.bulkPut(oldRecent.map((t, i) => ({ id: t.id, track: t, userEmail: email, createdAt: Date.now() - i })));
    }
    // play counts
    const oldCounts = await idbGet<Record<string, any>>(emailKey('drplay_play_counts'));
    if (oldCounts) {
      const rows = Object.values(oldCounts).map(e => ({ id: e.track.id, track: e.track, count: e.count, userEmail: email }));
      if (rows.length) await db.playCounts.bulkPut(rows);
    }
    // folder visits
    const oldVisits = await idbGet<Record<string, any>>(emailKey('drplay_folder_visits'));
    if (oldVisits) {
      const rows = Object.values(oldVisits).map(e => ({ id: e.id, name: e.name, count: e.count, lastVisited: e.lastVisited, userEmail: email }));
      if (rows.length) await db.folderVisits.bulkPut(rows);
    }
    // metadata cache entries (metadata_${id})
    const allKeys = await idbKeys();
    const metaKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('metadata_'));
    if (metaKeys.length) {
      const rows = await Promise.all(metaKeys.map(async k => ({ key: k, entry: await idbGet(k) })));
      await db.metadataCache.bulkPut(rows.filter(r => r.entry));
    }
    // session + buffer flags
    const buffer = await idbGet('drplay_buffer_seconds');
    if (buffer !== undefined) await db.kv.put({ key: 'drplay_buffer_seconds', value: buffer });
    const queue = await idbGet('drplay_queue');
    if (queue !== undefined) await db.kv.put({ key: 'drplay_queue', value: queue });
    const playmode = await idbGet('drplay_playmode');
    if (playmode !== undefined) await db.kv.put({ key: 'drplay_playmode', value: playmode });
    const session = await idbGet('drplay_last_session');
    if (session !== undefined) await db.kv.put({ key: 'drplay_last_session', value: session });

    localStorage.setItem(MIGRATION_FLAG, 'true');
  } catch (e) {
    console.error('[storage] migration-failed', e instanceof Error ? e.message : String(e));
  }
}
function emailKey(base: string): string {
  const email = localStorage.getItem('drplay_current_user_email');
  return email ? `${base}_${email}` : base;
}
```

- [ ] **Step 4: Run test → PASS**
- [ ] **Step 5: Commit** `feat(db): typed Dexie storage tables + migration scaffold`

### Task 2: Migrate `metadata.ts` to `db.metadataCache`

**Files:** Modify `src/utils/metadata.ts`, `src/utils/metadata.concurrency.test.ts`

- [ ] **Step 1:** Replace idb-keyval get/set/del with Dexie `db.metadataCache`:
  - `set(key, {version, data, ts})` → `db.metadataCache.put({ key, entry: {version, data, ts} })`
  - `get<CacheEntry>(key)` → `(await db.metadataCache.get(key))?.entry`
  - `del(oldest)` → `db.metadataCache.delete(oldest)`
- [ ] **Step 2:** Update `metadata.concurrency.test.ts` mock: from `'idb-keyval'` to mock `'../db/db'` (stub `db.metadataCache` with in-memory Map). Keep test assertions.
- [ ] **Step 3:** Run `npx vitest run src/utils/metadata` → PASS
- [ ] **Step 4:** Commit `refactor: metadata cache → Dexie metadataCache table`

### Task 3: Migrate `history.ts` to typed tables

**Files:** Modify `src/utils/history.ts`

Rewrite storage to use `db.recentTracks`, `db.playCounts`, `db.folderVisits` while keeping exported function signatures identical (`recordPlay`, `getRecentlyPlayed`, `getHeavyRotation`, `getRandomDiscoveries`, `recordFolderVisit`, `getMostVisitedFolders`). Keep `getUserKey`/email logic replaced by `userEmail` column filtering.

- [ ] **Step 1:** Write/extend test `src/utils/history.test.ts` covering recordPlay/getRecentlyPlayed/getHeavyRotation/getRandomDiscoveries/getMostVisitedFolders using fake-indexeddb.
- [ ] **Step 2:** Implement: store recent as `db.recentTracks`, counts as `db.playCounts`, visits as `db.folderVisits`, filter by `userEmail`. `getRandomDiscoveries` reads from `db.metadataCache` (where entry.data.v >= 9) instead of idb-keyval `keys()`.
- [ ] **Step 3:** Run `npx vitest run src/utils/history` → PASS
- [ ] **Step 4:** Commit `refactor: history → Dexie recentTracks/playCounts/folderVisits`

### Task 4: Migrate `playlists.ts` to `db.playlists`

**Files:** Modify `src/utils/playlists.ts`

Keep exported signatures (`getPlaylists`, `createPlaylist`, `deletePlaylist`, `updatePlaylist`, `addTrackToPlaylist`, `removeTrackFromPlaylist`, `getPlaylistById`). Replace idb-keyval array get/set with `db.playlists` queries filtered by `userEmail`.

- [ ] **Step 1:** Write/extend `src/utils/playlists.test.ts` (CRUD + dispatchEvent).
- [ ] **Step 2:** Implement against `db.playlists`.
- [ ] **Step 3:** Run `npx vitest run src/utils/playlists` → PASS
- [ ] **Step 4:** Commit `refactor: playlists → Dexie playlists table`

### Task 5: Migrate `cache.ts`, `usePlayer.ts`, `useAudioEngine.ts`, `scanner.worker.ts`, `App.tsx`

**Files:** Modify those 5 files

- [ ] **Step 1:** `cache.ts`: replace idb-keyval `keys()/delMany()` (metadata_ enumeration) with `db.metadataCache.where('key').startsWith('metadata_').delete()` + keep `invoke("clear_local_cache")` + `clearAllMetadataCache()` + localStorage LRU removal.
- [ ] **Step 2:** `usePlayer.ts`: replace idb-keyval `get/set` (drplay_buffer_seconds, drplay_queue, drplay_playmode, drplay_last_session) with `kv.get/kv.set` from `../db/kv`. Keep all logic.
- [ ] **Step 3:** `useAudioEngine.ts`: `idbSet('drplay_last_session', ...)` → `kv.set`.
- [ ] **Step 4:** `scanner.worker.ts`: `get` from idb-keyval → read `db.metadataCache` via a small helper (worker can import Dexie). Replace `get(cacheKey)` with `(await db.metadataCache.get(cacheKey))?.entry`.
- [ ] **Step 5:** `App.tsx`: `import('idb-keyval')` → `import('../db/kv')` for `del('drplay_last_session')`; also call `runStorageMigration()` once at app bootstrap (before first use).
- [ ] **Step 6:** Run full `npx vitest run` → 104/105 PASS (flake ignored). `tsc` clean.
- [ ] **Step 7:** Commit `refactor: route cache/player/worker/app through Dexie`

### Task 6: Remove `idb-keyval` + dead migration paths

**Files:** Modify `package.json`, `src/db/storage.ts`, `src/utils/favorites.ts`

- [ ] **Step 1:** Remove `import ... from 'idb-keyval'` from `src/db/storage.ts` and delete the file (migration fully applied for active users; new users have empty store). If you prefer a safety net, keep `storage.ts` but delete the idb-keyval import + reading logic, leaving only a no-op guarded by the flag.
- [ ] **Step 2:** `favorites.ts`: remove the now-impossible idb-keyval migration (`getOldUserKey`, `migrateOldFavorites`, `migrationDone`, await calls). Keep `db.favorites` logic.
- [ ] **Step 3:** `npm uninstall idb-keyval`. Grep `src` for `idb-keyval` → 0 matches.
- [ ] **Step 4:** `npx tsc --noEmit` clean; `npx vitest run` green.
- [ ] **Step 5:** Commit `chore: remove idb-keyval + dead migrations`

### Final: Whole-branch review
- [ ] Dispatch code-reviewer on `git merge-base main HEAD..HEAD` diff. Fix Critical/Important findings. Then `finishing-a-development-branch`.
