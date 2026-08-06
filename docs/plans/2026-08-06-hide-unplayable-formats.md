# Hide Non-Playable Formats + Fix Recently-Added Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task.

**Goal:** (1) Hide all audio formats Chromium/WebView2 cannot decode (wma/aiff/alac/ape/dsf/dff/wv/tak) from the library — browsing, search, recently-added — including cleanup of already-synced rows; (2) fix the "Recently Added" section refreshing on every single file-upload event (fires once per completed file → list jumps).

**Architecture:** Playable-extension list becomes the single source of truth in `audioQuery.ts` (all sync queries + `isAudioFile` become extension-based); a one-time cleanup pass in the proSync worker deletes stale non-playable rows (folders never touched); HomeTab delta-refresh gets a trailing debounce.

**Tech Stack:** Existing — Dexie, proSync worker, Drive API query language, React.

## Global Constraints

- **NGHIÊM CẤM tự nghĩ ra cơ chế** (standing user requirement): research-first — cite sources (MDN, lodash debounce docs for the debounce pattern, Chromium codec support for the playable list). Report every deviation.
- TDD (bugfix) / guard tests; TypeScript strict; named constants; captureError; ≤100-line functions; lint/tsc clean; English "why" comments.
- Baseline: 89 files / 1187 tests pass (commit 93ec18f).
- Playable formats (Chromium/WebView2 decodable): `.mp3 .flac .wav .ogg .m4a .aac .opus` — NON-playable to hide: `.wma .aiff .alac .ape .dsf .dff .wv .tak`.
- Folders MUST never be deleted by cleanup (db.files holds folder rows).
- Playlists/recents (stored Track objects already played) are OUT of scope — hiding applies to library browsing/search/recently-added/folder sync.

---

### Task 1: Playable-only extensions + stale row cleanup (behavior change)

**Files:**
- Modify: `src/utils/audioQuery.ts` (rename AUDIO_EXTENSIONS → PLAYABLE_AUDIO_EXTENSIONS, 7 entries; buildExtCondition/buildAudioCondition extension-only; hasAudioExtension/isAudioFile playable-only)
- Modify: `src/utils/audioQuery.test.ts` (fixtures + `.tak` now false)
- Modify: `src/workers/proSync.worker.ts` — cleanup pass at end of full sync (delete rows: not folder AND no playable extension), delta/change events already use isAudioFile (auto-fixed)
- Modify: `src/workers/proSync.worker.test.ts`
- Check: `src/utils/driveApi.test.ts` (query assertions — update if they assert the old clause)
- Verify: `src/hooks/useDriveExplorer.ts` uses getFolderAudioQuery (auto-fixed — no change)

**Behavior contract:**
- KEEP: folders sync (query must still include folder mime), all other browse/search/pagination flows unchanged
- KEEP: files with playable extension + generic octet-stream mime still sync (octetStreamVariant path)
- CHANGED: wma/aiff/alac/ape/dsf/dff/wv/tak never sync, never in search, never in Recently Added
- CHANGED: already-synced non-playable rows deleted once by the full-sync cleanup pass
- Edge: file "song" (no extension) with audio/mpeg mime → NOT synced anymore (extension-only discriminator) — deliberate, document
- Edge: cleanup must run only on full-sync completion, must skip folders, must not delete rows mid-sync

---

### Task 2: Recently-Added refresh debounce (bugfix)

**Files:**
- Modify: `src/ui/HomeTab/HomeTab.tsx` — handleDeltaRefresh: trailing debounce (~1s constant DEBOUNCE) collapsing burst events (drive-files-changed fires once per completed upload; pro-sync-complete also debounced)
- Modify: `src/ui/HomeTab/HomeTab.test.tsx` — burst test (N events → 1 fetch), single-event test still 1 fetch (with debounce), unmount cancels pending debounce timer

**Behavior contract:**
- Single event → exactly 1 refetch (after debounce)
- Burst of N events within window → exactly 1 refetch
- Token change / initial mount → immediate load (NOT debounced)
- Unmount → pending debounce cancelled (no fetch after unmount)
- recently-added fetch itself (getRecentlyAddedAudioFiles) unchanged

---

## Self-Review
- Task 1 covers "ẩn phần không phát được" (sync + search + recently added + cleanup); Task 2 covers "cập nhật tào lao" (debounce).
- Both tasks change behavior deliberately — documented in report "Behavior change" sections.
- Residual: playlists/recents containing previously-added unplayable tracks still playable-attempted (Task B from earlier commit skips them fast) — out of scope, reported.
