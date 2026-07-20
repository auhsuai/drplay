# Modernization Audit Plan

## Stack versions (installed)
- **React** 19.1.0 — ref-as-prop, no forwardRef needed
- **Tailwind CSS** 4.3.1 — CSS-first config, no `tailwind.config.js`
- **TypeScript** 5.8.3 — `catch (e: unknown)` best practice
- **Vite** 7.x — `@ts-expect-error` on `process.env`
- **Dexie** 4.4.4 — `EntityTable<T, PK>` pattern, no deprecated APIs

## Summary
- Total source files: 97
- Files with outdated logic found: ~12
- Files clean (no change needed): ~85

---

## File Checklist

### Config files
- [x] `vite.config.ts` — clean.
- [x] `postcss.config.js` — clean.
- [x] `vitest.config.ts` — clean.
- [x] `tsconfig.json` — clean.
- [x] `tailwind.config.js` — **DELETED** (dead v3 config, unused in v4).

### CSS
- [x] `src/App.css` — already uses `@import "tailwindcss"` and `@custom-variant dark` (v4). Will add `@theme` block from tailwind.config.js.
- [x] `src/index.css` — clean (just toast utility styles).

### Core DB layer
- [x] `src/db/db.ts` — replaced 4 `any` → `unknown` (metadata, SyncState.value, KvRow.value, MetadataCacheRow.entry)
- [x] `src/db/kv.ts` — `value: any` → `value: unknown`

### Utils (leaf modules, process first)
- [x] `src/utils/apiClient.ts` — `catch (err: any)` → unknown (lines 134, 178)
- [x] `src/utils/safeAudio.ts` — `catch (err: any)` → unknown (line 18)
- [x] `src/utils/driveApi.ts` — clean (config: any intentionally kept as Record<string,unknown> would change return types)
- [x] `src/utils/metadata.ts` — clean.
- [x] `src/utils/favorites.ts` — clean.
- [x] `src/utils/history.ts` — clean.
- [x] `src/utils/logger.ts` — clean.
- [x] `src/utils/safeAudio.ts` — clean.
- [x] `src/utils/downloadPath.ts` — clean.
- [x] `src/utils/normalizeText.ts` — clean.
- [x] `src/utils/audioQuery.ts` — clean.
- [x] `src/utils/cache.ts` — clean.
- [x] `src/utils/color.ts` — clean.
- [x] `src/utils/copyToClipboard.ts` — clean.
- [x] `src/utils/errorLog.ts` — clean.
- [x] `src/utils/folderFetchGuard.ts` — clean.
- [x] `src/utils/formatTime.ts` — clean.
- [x] `src/utils/nextTrackPrefetcher.ts` — clean.
- [x] `src/utils/playlists.ts` — clean.
- [x] `src/utils/proSyncManager.ts` — clean.
- [x] `src/utils/sessionGuard.ts` — clean.
- [x] `src/utils/simpleToast.tsx` — clean.
- [x] `src/utils/streamPrefetcher.ts` — clean.
- [x] `src/utils/apiClient.test.ts` — clean.
- [x] `src/utils/color.test.ts` — clean.
- [x] `src/utils/driveApi.test.ts` — clean.
- [x] `src/utils/errorLog.test.ts` — clean.
- [x] `src/utils/history.test.ts` — test files can use `any` (test ergonomics), leave as-is.
- [x] `src/utils/logger.test.ts` — clean.
- [x] `src/utils/metadata.test.ts` — clean.
- [x] `src/utils/metadata.concurrency.test.ts` — clean.
- [x] `src/utils/nextTrackPrefetcher.test.ts` — clean.
- [x] `src/utils/normalizeText.test.ts` — clean.
- [x] `src/utils/playlists.test.ts` — clean.
- [x] `src/utils/safeAudio.test.ts` — clean.
- [x] `src/utils/streamError.test.ts` — clean.

### Hooks
- [x] `src/hooks/useAuth.ts` — `catch (err: any)` → unknown (line 207)
- [x] `src/hooks/useDrive.ts` — clean.
- [x] `src/hooks/usePlayer.ts` — clean.
- [x] `src/hooks/useTheme.ts` — clean.

### UI Components
- [x] `src/ui/ErrorBoundary.tsx` — clean.
- [x] `src/ui/errorCapture.test.ts` — test mock `any` is acceptable.
- [x] `src/ui/FolderSelection/FolderSelectionScreen.tsx` — `catch (e: any)` → unknown (line 71)
- [x] `src/ui/PlayerBar/usePlaybackControl.ts` — `catch (err: any)` → unknown (line 161)
- [x] All other UI files — clean.
- [x] `src/App.tsx` — `e: any` in handleLocateFile intentionally left (Tauri event payload, can't type)
- [x] `src/main.tsx` — clean.

### Workers
- [x] `src/workers/workerError.ts` — clean.
- [x] `src/workers/proSync.worker.ts` — clean.
- [x] `src/workers/scanner.worker.ts` — clean.

### DB / kv
- [x] `src/db/db.test.ts` — clean.

### i18n / data
- [x] `src/i18n.ts` — clean.
- [x] `src/locales/en/translation.json` — clean.
- [x] `src/locales/vi/translation.json` — clean.
- [x] `src/data/greetings.json` — clean.

---

## Order of execution (leaf → entry → config)

1. **Config cleanup**: `tailwind.config.js` → delete; `App.css` → add `@theme` block
2. **Core types**: `db/db.ts` types, `db/kv.ts`
3. **Utility modules**: `apiClient.ts`, `driveApi.ts`
4. **Hooks**: `useAuth.ts`, `FolderSelectionScreen.tsx`, `usePlaybackControl.ts`
5. **Final verify**: full `tsc` + `vitest` + `vite build`
