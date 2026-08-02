# KẾ HOẠCH TỐI ƯU TOÀN DIỆN — drplay

Modernize từng file theo skill `closed-loop-code-modernize` (chuẩn 2026).
Mỗi file: Audit → Cross-verify → Upgrade (TDD) → Review → Verify → **Push GitHub** → ghi memory.

## Quy trình mỗi file

- [x] Baseline: 59 test files / 710 tests PASS (02/08/2026)
- [ ] Từng file (bảng dưới)

## Danh sách file & trạng thái

| # | File | Status | Ghi chú |
|---|------|--------|---------|
| 1 | `src/utils/driveApi.ts` | ✅ done | timeoutMs forwarded, dead code xoá, DRY assertDriveOk + buildConfigSearchUrl |
| 2 | `src/utils/apiClient.ts` | ✅ done | invoke refresh_google_token bọc timeout 15s (Tauri #8351) |
| 3 | `src/utils/diskFs.ts` | ✅ done | đạt chuẩn 2026, không cần nâng cấp (raw invoke = guest-js 2.5.1, verified) |
| 4 | `src/utils/driveUpload.ts` | ⬜ pending | |
| 5 | `src/utils/uploadManager.ts` | ✅ done | backoffDelay/sleep chung, xoá dead attempt, type CustomEvent |
| 6 | `src/utils/drivePagination.ts` | ✅ done | json() malformed guard, classify lỗi thay SyntaxError thô |
| 7 | `src/utils/cache.ts` | ✅ done | guard removeItem SecurityError, log đúng ngữ cảnh, hằng số chung metadata.ts |
| 8 | `src/utils/metadata.ts` | ✅ done | Array.isArray guard, generation guard chống re-populate, CACHE_VERSION validate, comment, timer cleanup |
| 9 | `src/utils/audioQuery.ts` | ✅ done | DRY helpers + as const + test contract chốt chuỗi output |
| 10 | `src/utils/bufferedRange.ts` | ✅ done | Number.isFinite consistency |
| 11 | `src/utils/safeAudio.ts` | ✅ done | dead code production (chỉ test import) — chờ quyết định chung với AudioController |
| 12 | `src/utils/streamPrefetcher.ts` | ✅ done | bỏ machinery async chết, xoá export chết, comment đúng + test LRU |
| 13 | `src/utils/nextTrackPrefetcher.ts` | ✅ done | AbortSignal.any thay dual-map, hằng số range, classify theo DOMException.name |
| 14 | `src/utils/sessionCleanup.ts` | ✅ done | guard localStorage SecurityError + xoá .bak rác |
| 15 | `src/utils/sessionGuard.ts` | ✅ done | đạt chuẩn 2026, không cần nâng cấp (counter generation-token chuẩn) |
| 16 | `src/utils/proSyncManager.ts` | ✅ done | onerror/onmessageerror worker, typed unions, test import constants |
| 17 | `src/utils/playlists.ts` | ✅ done | transaction chống lost update, import type chuẩn, destructure classify |
| 18 | `src/utils/favorites.ts` | ✅ done | transaction addFavorite, log isFavorite, import type chuẩn |
| 19 | `src/utils/history.ts` | ⬜ pending | |
| 20 | `src/utils/downloadPath.ts` | ⬜ pending | |
| 21 | `src/utils/pathUtils.ts` | ⬜ pending | |
| 22 | `src/utils/truncatePath.ts` | ⬜ pending | |
| 23 | `src/utils/formatBytes.ts` | ⬜ pending | |
| 24 | `src/utils/formatTime.ts` | ⬜ pending | |
| 25 | `src/utils/normalizeText.ts` | ⬜ pending | |
| 26 | `src/utils/color.ts` | ⬜ pending | |
| 27 | `src/utils/copyToClipboard.ts` | ⬜ pending | |
| 28 | `src/utils/errorLog.ts` | ⬜ pending | |
| 29 | `src/utils/logger.ts` | ⬜ pending | |
| 30 | `src/utils/sidebarState.ts` | ⬜ pending | |
| 31 | `src/utils/simpleToast.tsx` | ⬜ pending | |
| 32 | `src/hooks/useDrive.ts` | ⬜ pending | |
| 33 | `src/hooks/useDriveExplorer.ts` | ⬜ pending | |
| 34 | `src/hooks/usePlayer.ts` | ⬜ pending | |
| 35 | `src/hooks/player/usePlayerQueue.ts` | ⬜ pending | |
| 36 | `src/hooks/player/usePlayerSession.ts` | ⬜ pending | |
| 37 | `src/hooks/player/utils.ts` | ⬜ pending | |
| 38 | `src/hooks/useAuth.ts` | ⬜ pending | |
| 39 | `src/hooks/useDebouncedLiveQuery.ts` | ⬜ pending | |
| 40 | `src/hooks/useLocateFile.ts` | ⬜ pending | |
| 41 | `src/hooks/useMenuDelete.ts` | ⬜ pending | |
| 42 | `src/hooks/useMenuDownload.ts` | ⬜ pending | |
| 43 | `src/hooks/useMenuPlaylists.ts` | ⬜ pending | |
| 44 | `src/hooks/useResponsiveItems.ts` | ⬜ pending | |
| 45 | `src/hooks/useServiceWorker.ts` | ⬜ pending | |
| 46 | `src/hooks/useTauriEvents.ts` | ⬜ pending | |
| 47 | `src/hooks/useTheme.ts` | ⬜ pending | |
| 48 | `src/hooks/useAppGlobalEvents.ts` | ⬜ pending | |
| 49 | `src/store/appStore.ts` | ⬜ pending | |
| 50 | `src/store/authStore.ts` | ⬜ pending | |
| 51 | `src/store/driveStore.ts` | ⬜ pending | |
| 52 | `src/store/playerStore.ts` | ⬜ pending | |
| 53 | `src/lib/AudioController.ts` | ⬜ pending | |
| 54 | `src/db/db.ts` | ⬜ pending | |
| 55 | `src/db/kv.ts` | ⬜ pending | |
| 56 | `src/workers/proSync.worker.ts` | ⬜ pending | |
| 57 | `src/workers/scanner.worker.ts` | ⬜ pending | |
| 58 | `src/workers/workerError.ts` | ⬜ pending | |

## Lịch sử hoàn thành

| Ngày | File | Upgrade chính | Commit | Tests |
|------|------|---------------|--------|-------|
| | | | | |
