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
| 11 | `src/utils/safeAudio.ts` | ✅ done | đã XOÁ (dead code — AudioController B1 thay thế, đợt 2) |
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
| 30 | `src/utils/sidebarState.ts` | ✅ done | guard localStorage P0 (chống crash App init) |
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
| 49 | `src/store/appStore.ts` | ✅ done | đã XOÁ (dead code — 0 caller, đợt 3) |
| 50 | `src/store/authStore.ts` | ✅ done | đạt chuẩn (không persist — chủ đích) |
| 51 | `src/store/driveStore.ts` | ✅ done | ROOT_FOLDER_ID const |
| 52 | `src/store/playerStore.ts` | ✅ done | đạt chuẩn zustand v5 |
| 53 | `src/lib/AudioController.ts` | ✅ done | dedup seek helper, classify safePlay, xoá safeAudio/preloadTrack dead |
| 54 | `src/db/db.ts` | ✅ done | PK compound [userEmail+id] v7+v8 (đã fix cross-user overwrite), index isFolder no-op ghi nhận |
| 55 | `src/db/kv.ts` | ✅ done | captureError thay console.warn (giữ rethrow) |
| 56 | `src/workers/proSync.worker.ts` | ✅ done | FOLDER_MIME chung (backoff/pagination giữ — khác biệt thiết kế) |
| 57 | `src/workers/scanner.worker.ts` | ✅ done | đã XOÁ (file mồ côi 0 caller) |
| 58 | `src/workers/workerError.ts` | ✅ done | đạt chuẩn (SENSITIVE_KEYS bổ sung logger — giữ) |

## Lịch sử hoàn thành

### Đợt 1 — Modernize 58 file src (closed-loop-code-modernize)
23 commits: `114be5c` → `a507f46` (02/08/2026). Test 710 → 802. Chi tiết từng file ở bảng trên.

### Đợt 2 — Backlog quan trọng (5 commits: `121a1f3` → `0053933`)
| Task | Loại | Kết quả |
|------|------|---------|
| PK collision cross-user | bugfix | Schema v7: PK 4 bảng → compound `[userEmail+id]` (migration copy + v8 drop). 5 regression + 2 biến thể PASS |
| SongCard formatSize | bugfix | Dùng `formatBytes` chuẩn thay hàm tự viết sai ("0 MB"/"0.5 MB") |
| storageKeys.ts | refactor | USER_EMAIL_KEY + getCurrentUserEmail() (guard) — thay 4 module |
| driveConstants.ts | refactor | ROOT_FOLDER_ID + MY_DRIVE_TAB — thay 12 module |
| i18n + App.tsx | modernize | Guard crash-init (module-scope + lazy init), logout cleanup, LANGUAGE_KEY + supportedLngs, i18next → dependencies |

### Đợt 3 — Backlog còn lại (6 commits: `2561dda` → `d4fb20a`)
| Task | Loại | Kết quả |
|------|------|---------|
| useDrive 8 điểm localStorage | bugfix | Guard (6 read + 2 write) + nav keys vào storageKeys.ts |
| DriveItem/BreadcrumbItem → types.ts | refactor | 10 file import chuyển khỏi App.tsx |
| FolderSelectionScreen + MoreMenu | bugfix | Guard storage + ROOT_FOLDER_ID chung |
| logger redaction | bugfix | Redact `dbId=`/`driveFileId=`/`fileId=`/`folder=` (pattern cũ bỏ lọt "Id=") |
| activeTab → TabKey union | refactor | 11 file — giá trị lạ bị TS bắt |
| sessionGuard test + xoá appStore | test | 3 test + 1 race test apiClient + xoá dead code |

**Test suite hiện tại: 69 files / 829 tests PASS. Build xanh.**

## BACKLOG PHIÊN SAU (còn lại — sắp theo ưu tiên)

### Việc nhỏ còn sót (đều không phải bug, làm khi rảnh)
1. **Track re-export ở App.tsx** (28 site import `Track` từ '../App') — chuyển dần sang `import type { Track } from '../types'` khi đụng từng file. Không phải bug, chỉ vệ sinh type.
2. **README.md stale** — còn nhắc `scanner.worker` + `safeAudio` (2 file đã xoá). Cập nhật doc.
3. **useDrive hydration test** — hook phức tạp không có test trực tiếp (giá trị thấp so công sức — làm nếu có thời gian).
4. **index `isFolder` no-op** (db.ts) — Dexie bỏ qua index boolean; không xoá vì phí rebuild store.

### Nếu muốn làm sâu hơn (đợt sau)
5. **Login/Logout flow E2E** — dùng playwright test thật: đăng nhập → play nhạc → logout → login user khác → verify lịch sử/yêu thích tách biệt (xác nhận fix PK collision end-to-end).
6. **WebView2/Tauri runtime check** — build desktop thật, kiểm tra: migration v7 chạy mượt trên DB cũ, localStorage guards hoạt động, theme init không FOUC.
7. **Drive quota decimal vs binary** (formatBytes) — hiện 1024-based ("13.97 GB") nhưng Google UI hiển thị decimal ("15 GB") — quyết định sản phẩm xem có đổi không.

### LƯU Ý QUY TRÌNH cho phiên sau
- Mỗi task: chọn đúng skill (bugfix / refactor / modernize) → dispatch subagent → review → verify thật → **push GitHub** → ghi `codebase-memory` → cập nhật file md này.
- ⚠️ **TUYỆT ĐỐI không dùng PowerShell Set-Content/Get-Content với file md tiếng Việt** — đã làm hỏng encoding 1 lần (mojibake). Chỉ dùng edit/write tool.
- Test: `npx vitest run` (full) + `npm run build` — phải xanh trước khi push.
- `codebase-memory` project name: `drplay`.
