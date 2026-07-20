# Task 5 Report — Migrate remaining call sites + run migration at boot

## status
DONE

## commits
- `f369454` refactor: route cache/player/worker/app through Dexie

## test summary
- `npx tsc --noEmit` → clean (exit 0)
- `npx vitest run src/utils/cache src/hooks/usePlayer src/db` → 2/2 pass (only `src/db/db.test.ts` exists; no cache/usePlayer test files in repo)
- `npx vitest run` (full) → 23 files, 123/123 tests pass (errorCapture flake did not trigger this run)

## files touched (idb-keyval status after change)
- `src/utils/cache.ts` — MIGRATED. `keys()/delMany()` enumeration replaced with `db.metadataCache.where('key').startsWith('metadata_').delete()`. Kept LRU localStorage removal + `invoke('clear_local_cache')` + `clearAllMetadataCache()` in `finally`. No longer imports idb-keyval.
- `src/hooks/usePlayer.ts` — MIGRATED. `import { get, set as idbSet } from 'idb-keyval'` → `from '../db/kv'`. Key names unchanged (drplay_buffer_seconds, drplay_queue, drplay_playmode, drplay_last_session). Public API unchanged. No longer imports idb-keyval.
- `src/ui/PlayerBar/useAudioEngine.ts` — MIGRATED. `set as idbSet` now from `../../db/kv`. drplay_last_session write path unchanged. No longer imports idb-keyval.
- `src/workers/scanner.worker.ts` — MIGRATED. `get(cacheKey)` from idb-keyval → `db.metadataCache.get(cacheKey)` then `row?.entry`. Dexie imports fine in worker context (tsc clean, no bundling change needed). Behavior (skip if data.v >= 9) preserved. No longer imports idb-keyval.
- `src/App.tsx` — MIGRATED. Logout `import('idb-keyval').then(({del})=>del(...))` → `kvDel('drplay_last_session')`. Added `runStorageMigration()` bootstrap effect (module-level `storageMigrationStarted` guard + StrictMode-safe + idempotent flag inside; wrapped in `.catch` so failure never blocks render). Only remaining `idb-keyval` mentions are code comments, not imports.

## migration wiring verified
- `runStorageMigration` imported in App.tsx from `./db/storage` and invoked once in a `useEffect([])` at startup, guarded so it runs a single time and its rejection is caught/logged (does not crash bootstrap).
- storage.ts (Task 1) sets `localStorage['drplay_storage_migrated_v4']` and copies idb-keyval data into Dexie tables on first run; subsequent runs early-return on the flag.

## concerns
- No unit tests exist for `cache.ts`, `usePlayer.ts`, `useAudioEngine.ts`, or `scanner.worker.ts` — coverage of these migrations relies on tsc + the existing full suite (which exercises db/kv/metadata). Behavior-level verification of the boot migration path is not automated.
- `src/db/storage.ts` and `src/utils/favorites.ts` STILL import idb-keyval — intentional per plan (storage.ts is the migration reader; favorites.ts dead migration path is Task 6). idb-keyval npm dependency intentionally NOT removed (Task 6).
- errorCapture.test.ts is a known flake; it passed this run but may fail intermittently on reruns.
