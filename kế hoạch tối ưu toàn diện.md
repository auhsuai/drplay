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
| 4 | `src/utils/driveUpload.ts` | ✅ done | backoffDelay Retry-After + DRY readDriveErrorBody |
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
| 19 | `src/utils/history.ts` | ✅ done | transaction recordPlay/recordFolderVisit, import type, METADATA_KEY_PREFIX/V_PLACEHOLDER, classify error |
| 20 | `src/utils/downloadPath.ts` | ✅ done | localStorage guard + bỏ return await |
| 21 | `src/utils/pathUtils.ts` | ✅ done | đạt chuẩn, không cần nâng cấp |
| 22 | `src/utils/truncatePath.ts` | ✅ done | đạt chuẩn, không cần nâng cấp |
| 23 | `src/utils/formatBytes.ts` | ✅ done | đạt chuẩn (1024-based cố ý; escalate: Drive hiển thị decimal) |
| 24 | `src/utils/formatTime.ts` | ✅ done | thêm test file (logic đạt chuẩn) |
| 25 | `src/utils/normalizeText.ts` | ✅ done | đạt chuẩn (NFD + đ→d đúng) |
| 26 | `src/utils/color.ts` | ✅ done | BG_ALPHA const + captureError onerror |
| 27 | `src/utils/copyToClipboard.ts` | ✅ done | đạt chuẩn (execCommand giữ làm fallback cuối có lý do) |
| 28 | `src/utils/errorLog.ts` | ✅ done | prune atomic 1 transaction (chống race xoá dư) |
| 29 | `src/utils/logger.ts` | ✅ done | redaction refresh_token/token/upload_id/api_key/Authorization/Bearer-ci + circular safe |
| 28 | `src/utils/sidebarState.ts` | ✅ done | guard localStorage P0 (chống crash App init) |
| 31 | `src/utils/simpleToast.tsx` | ✅ done | gộp DRY showToast + clamp duration + captureError |
| 32 | `src/hooks/useDrive.ts` | ✅ done | mergeWithTimeoutSignal chung + CLEAR_LOCAL_CACHE_CMD |
| 33 | `src/hooks/useDriveExplorer.ts` | ✅ done | driveFetch thay inline-retry (dedup bản backoff thứ 5), import type, useCallback subscribe, bulkUpdate |
| 34 | `src/hooks/usePlayer.ts` | ✅ done | DRIVE_STREAM_PREFIX 1 nguồn, isAbortError duck-typed, playmode key, PLAYER_STOP_EVENT |
| 35 | `src/hooks/player/usePlayerQueue.ts` | ✅ done | SESSION_CLEANUP_KEYS.queueKv, driveItems type-safe, fallbackHead ensureQueueItemId |
| 36 | `src/hooks/player/usePlayerSession.ts` | ✅ done | import prefix chung + isAbortError (đã xử lý cùng usePlayer) |
| 37 | `src/hooks/player/utils.ts` | ✅ done | isAbortError duck-typed helper chung |
| 38 | `src/hooks/useAuth.ts` | ✅ done | CLEAR_*_CMD, setAccessToken single-source, localStorage guards, race guard, handler reset |
| 39 | `src/hooks/useDebouncedLiveQuery.ts` | ✅ done | try/catch querier + deps fix |
| 40 | `src/hooks/useLocateFile.ts` | ✅ done | dedup classifyDriveError + storage guard |
| 41 | `src/hooks/useMenuDelete.ts` | ✅ done | import type DriveItem |
| 42 | `src/hooks/useMenuDownload.ts` | ✅ done | join() cross-platform fix, mergeWithTimeoutSignal, import type |
| 43 | `src/hooks/useMenuPlaylists.ts` | ✅ done | import type Track |
| 44 | `src/hooks/useResponsiveItems.ts` | ✅ done | matchMedia + useSyncExternalStore |
| 45 | `src/hooks/useServiceWorker.ts` | ✅ done | ready-gated post + safePost |
| 46 | `src/hooks/useTauriEvents.ts` | ✅ done | dedup signal merge + classify |
| 47 | `src/hooks/useTheme.ts` | ✅ done | lazy-init no FOUC + type guard |
| 48 | `src/hooks/useAppGlobalEvents.ts` | ✅ done | xoá isFocused dead + storage guard |
| 49 | `src/store/appStore.ts` | ✅ done | đạt chuẩn zustand v5 |
| 50 | `src/store/authStore.ts` | ✅ done | đạt chuẩn (không persist — chủ đích) |
| 51 | `src/store/driveStore.ts` | ✅ done | ROOT_FOLDER_ID const |
| 52 | `src/store/playerStore.ts` | ✅ done | đạt chuẩn zustand v5 |
| 53 | `src/lib/AudioController.ts` | ✅ done | dedup seek helper, classify safePlay, xoá safeAudio/preloadTrack dead |
| 54 | `src/db/db.ts` | ✅ done | đạt chuẩn (2 backlog: PK cross-user, index isFolder no-op) |
| 55 | `src/db/kv.ts` | ✅ done | captureError thay console.warn (giữ rethrow) |
| 56 | `src/workers/proSync.worker.ts` | ✅ done | FOLDER_MIME chung (backoff/pagination giữ — khác biệt thiết kế) |
| 57 | `src/workers/scanner.worker.ts` | ✅ done | đã XOÁ (file mồ côi 0 caller) |
| 58 | `src/workers/workerError.ts` | ✅ done | đạt chuẩn (SENSITIVE_KEYS bổ sung logger — giữ) |

## Lịch sử hoàn thành

| Ngày | File | Upgrade chính | Commit | Tests |
|------|------|---------------|--------|-------|
| | | | | |
