# Modernize Log

Theo dõi các file đã được hiện đại hóa (skill: closed-loop-code-modernize).
Mỗi batch = 1 nhóm file liên quan, mỗi file = 1 dispatch riêng (TDD).

## Batch 3 — Core network/async utils (2026-08-09)

| # | File | Pattern cũ → mới | Nguồn tra cứu | Trạng thái |
|---|------|------------------|---------------|------------|
| 1 | `src/utils/apiClient.ts` | | | chờ audit |
| 2 | `src/utils/driveHttp.ts` | | | chờ audit |
| 3 | `src/utils/asyncLimit.ts` | | | chờ audit |
| 4 | `src/utils/streamPrefetcher.ts` | | | chờ audit |
| 5 | `src/utils/resumableSession.ts` | | | chờ audit |
| 6 | `src/utils/driveApi.ts` | | | chờ audit |

## Batch 4 — Store + Workers (2026-08-09)

| # | File | Pattern cũ → mới | Nguồn tra cứu | Trạng thái |
|---|------|------------------|---------------|------------|
| 1 | `src/store/playerStore.ts` | | | chờ audit |
| 2 | `src/store/driveStore.ts` | | | chờ audit |
| 3 | `src/store/authStore.ts` | | | chờ audit |
| 4 | `src/search/searchEngine.ts` | | | chờ audit |
| 5 | `src/search/search.worker.ts` | | | chờ audit |
| 6 | `src/workers/proSync.worker.ts` | | | chờ audit |

## Batch 7 — Backlog fix + UI core sweep (2026-08-09)

| # | File | Kết luận | Ghi chú |
|---|------|----------|---------|
| 1 | `src/ui/Settings/SettingsTab.tsx` | 🔧 **FIX** | backlog: `.then(setDownloadPath)` không catch → downloadDir() reject = unhandled rejection. Thêm catch → captureError warn. TDD: RED (Unhandled Rejection "invoke failed") → GREEN 13/13. Commit `d6d9596` |
| 2 | `src/ui/MainContent/MainContent.tsx` | ✅ giữ nguyên | effects cleanup đủ, setTimeout cancellation, useEventListener |
| 3 | `src/ui/PlayerBar/*` + `SeekBar.tsx` | ✅ giữ nguyên | pointer capture + removeEventListener đầy đủ, comment why |
| 4 | `src/ui/NowPlaying/*` + hooks | ✅ giữ nguyên | không pattern cũ |
| 5 | `src/ui/Sidebar/*` | ✅ giữ nguyên | (StorageQuotaCard audit batch 5) |

## Batch 6 — Workers + lib core sweep (2026-08-09, tuần tự từng file)

| # | File | Kết luận | Ghi chú |
|---|------|----------|---------|
| 1 | `src/workers/syncRunner.ts` | ✅ giữ nguyên | async/await toàn bộ, catch phân loại phase, retry bounded + refreshTokenAndRetry, 410→reset full sync |
| 2 | `src/lib/AudioController.ts` | ✅ giữ nguyên | changeToken monotonic guard chống stale retry, WeakMap listener retention, safePlay phân loại lỗi |
| 3 | `src/utils/metadata/fetchPipeline.ts` | ✅ giữ nguyên | async/await + typed catch + AbortSignal injection + retry tokenizer |
| 4 | `src/utils/upload/*` + uploadManager | ✅ giữ nguyên | Promise.all @ queue.ts:251 = batch 2 DB write độc lập (must-await-all đúng); retry bounded 308-resume |
| 5 | `src/db/db.ts` + `kv.ts` | ✅ giữ nguyên | runOp wrapper: typed catch + rethrow + log ngữ cảnh |
| 6 | `src/workers/driveFetch.ts` + `tokenRefresh.ts` | ✅ giữ nguyên | AbortSignal.timeout, clone body rate-limit check, Retry-After parse, timeout 15s bounded |

## Batch 5 — Per-file sweep (2026-08-09, tuần tự từng file)

| # | File | Kết luận | Ghi chú |
|---|------|----------|---------|
| 1 | `src/hooks/useMenuPlaylists.ts` | ✅ giữ nguyên | .then→async/await chỉ ~2-3% ngắn hơn (< threshold); render-time state adjust đúng React 19; catch typed |
| 2 | `src/ui/Sidebar/StorageQuotaCard.tsx` | ✅ giữ nguyên | .then+cancelled ~2-3%; render-time adjust chuẩn; `as number` có guard trước |
| 3 | `src/ui/Sidebar/PlaylistSection.tsx` | ✅ giữ nguyên | .then+cancelled ×2 (dup nhưng <2 lần → không đạt DRY threshold); async/await ~3% |
| 4 | `src/ui/HomeTab/HomeTab.tsx` | ✅ giữ nguyên | generation guards (đã fix race 43e3555); debounce trailing chuẩn lodash; lazy useState greeting |
| 5 | `src/ui/Settings/SettingsTab.tsx` | ✅ giữ nguyên | .then(setDownloadPath) 1 dòng void; ⚠️ backlog: reject không catch → unhandled (xác minh contract) |
| 6 | `src/ui/Settings/components/CacheManagerModal.tsx` | ✅ giữ nguyên | .then+cancelled, catch fallback zeroed sizes, Escape guard chuẩn |

## Batch 4 — Store + Workers (2026-08-09)

Kết luận audit: 6/6 file chuẩn 2026; **1 fix race thật** được APPROVE. Audit: `docs/audit_batch4_store_workers.md`.

| # | File | Kết luận | Ghi chú |
|---|------|----------|---------|
| 1 | `src/store/playerStore.ts` | ✅ giữ nguyên | zustand 5.0.14 đúng v5 API (named import create, useShallow consumers, không deprecated v4); không persist có chủ đích |
| 2 | `src/store/driveStore.ts` | ✅ giữ nguyên | đã chuẩn v5; nav persist ở useNavStatePersistence (dexie, có chủ đích) |
| 3 | `src/store/authStore.ts` | ✅ giữ nguyên | 0 log token (grep xác nhận); không persist đúng |
| 4 | `src/search/searchEngine.ts` | ✅ giữ nguyên | minisearch 7.2.0 — mọi API đúng v7 (searchOptions constructor-level, boost, storeFields, fuzzy 0.2) |
| 5 | `src/search/search.worker.ts` | 🔧 **FIX race** | invalidate mid-rebuild bị nuốt (stale=false vô điều kiện) → generation guard; test #10 RED→GREEN; commit `8b18820` |
| 6 | `src/workers/proSync.worker.ts` | ✅ giữ nguyên | glue mỏng không catch ĐÚNG (syncRunner.ts có try/catch + retry giới hạn + refreshTokenAndRetry) |

## Backlog (Batch 4 — cross-file findings)

| Hạng mục | Chi tiết |
|----------|----------|
| Worker glue style | search.worker `self.onmessage` vs proSync.worker `addEventListener` — cosmetic, không đạt threshold |
| Updater-function action | playerStore ×4 + driveStore ×1 — ~8% ngắn hơn, không đạt threshold |

## Batch 3 — Core network/async utils (2026-08-09)

Kết luận audit: **6/6 file đã chuẩn 2026 — 0 upgrade đạt threshold**. Audit: `docs/audit_batch3_network_utils.md`.

| # | File | Kết luận | Ghi chú |
|---|------|----------|---------|
| 1 | `src/utils/apiClient.ts` | ✅ giữ nguyên | `withTimeout` GIỮ (đính chính batch 1: withResolvers ≈ 0% ngắn hơn — `.then` two-arg bắt buộc chống unhandled rejection); single-flight shared promise đúng, không race |
| 2 | `src/utils/driveHttp.ts` | ✅ giữ nguyên | retry loop bounded MAX_RETRIES=4 + backoff/jitter/Retry-After; AbortSignal.any guard đúng MDN |
| 3 | `src/utils/asyncLimit.ts` | ✅ giữ nguyên | semaphore FIFO, try/finally release, có test; p-limit không đáng (behavior khác, dep mới) |
| 4 | `src/utils/streamPrefetcher.ts` | ✅ giữ nguyên | Map LRU chuẩn ES, không có async chain để upgrade |
| 5 | `src/utils/resumableSession.ts` | ✅ giữ nguyên | KHÔNG có persistence (logic thuần, spec sai); idempotent upload đúng Google docs |
| 6 | `src/utils/driveApi.ts` | ✅ giữ nguyên | chỉ 35 dòng barrel re-export (spec sai); pattern thật nằm driveHttp/driveFiles/driveConfig/driveQuota — đã audit |

## Backlog (Batch 3 — cross-file findings)

| Hạng mục | Chi tiết | Skill đề xuất |
|----------|----------|---------------|
| `sleep` duplicate ×2 | driveHttp.ts:23 + asyncLimit.ts:72 (cùng signature) | refactor nhỏ |
| Merge signal+timeout logic trùng ×4 | apiClient.ts:501-505, driveHttp.ts:34-36, driveRangeTokenizer.ts:149-151, nextTrackPrefetcher.ts:47-49 (không guard — không nhất quán) | cần module thứ 3 (driveHttp→apiClient circular) |
| `catch (err)` không annotate ×2 | style-only | nối backlog batch 1 |

## Backlog xử lý (2026-08-09) — 3 tasks refactor

| # | Task | Chi tiết | Commit | Trạng thái |
|---|------|----------|--------|------------|
| 1 | Xoá dead prop `token` LikedSongs | 2 file −2 dòng: interface + caller | `c7119bb` | ✅ xong |
| 2 | Extract `useClickOutside` (DRY ×5) | Hook mới `src/hooks/useClickOutside.ts` (savedCallback React 19) + 5 caller, +41/−78; test mới 5 case | `8e89d9e` | ✅ xong |
| 3 | Bump react-easy-crop 6.0.2→6.2.3 | Fix CJS types #663 + debounce #653; không breaking change | `11ff398` | ✅ xong |

Verify cuối: full suite **1492/1492 PASS** + build xanh (26s).

## Batch 2 — UI screens (2026-08-09)

Kết luận audit: **6/6 file đã đạt chuẩn 2026 — 0 upgrade được duyệt** (không pattern nào đạt threshold ≥20% ngắn hơn / deprecated / perf / type-safe). Audit đầy đủ: `docs/audit_batch2_ui_screens.md`.

| # | File | Kết luận | Ghi chú |
|---|------|----------|---------|
| 1 | `src/ui/Settings/TrashScreen.tsx` | ✅ giữ nguyên | 5× catch typed-unknown + captureError context; outside-click chuẩn; bulk ops đã allSettled (36dd123) |
| 2 | `src/ui/LikedSongs/LikedSongs.tsx` | ✅ giữ nguyên | ⚠️ **dead prop `token`** (interface:20, destructure:24 bỏ, caller TabContentRouter:161 vẫn truyền) → backlog |
| 3 | `src/ui/components/ImageCropperModal.tsx` | ✅ giữ nguyên | react-easy-crop v6 đúng docs 100% (context7); backlog: bump 6.0.2→6.2.3 |
| 4 | `src/ui/components/MoreMenu/useMenuMove.ts` | ✅ giữ nguyên | 1 catch chuẩn, optimistic-close đúng thứ tự |
| 5 | `src/ui/Playlist/PlaylistView.tsx` | ✅ giữ nguyên | 4 catch style-only; micro-nit: `MAX_COVER_BYTES` nên hoisted, `React.useRef` vs `useRef` lẫn |
| 6 | `src/ui/FolderSelection/useFolderPicker.ts` | ✅ giữ nguyên | render-time state adjustment = React chính thức; AbortController + isAborted sau mọi await — trên chuẩn |

## Backlog (Batch 2 — cross-file findings)

| Hạng mục | Chi tiết | Skill đề xuất |
|----------|----------|---------------|
| Xoá dead prop `token` LikedSongs | 2 file (LikedSongs.tsx + TabContentRouter.tsx), 1 consumer duy nhất | refactor (ngoài luật 1-file modernize) |
| Extract `useClickOutside` | DRY ×5: TrashScreen:67, UploadButton:69, useMoreMenuEvents:51, ThemeDropdown:24, LanguageDropdown:19 | closed-loop-refactor |
| Bump react-easy-crop 6.0.2→6.2.3 | fix CJS types #663 + debounce resize #653 | dependency bump |

## Batch 1 — Core utils (2026-08-09)

| # | File | Pattern cũ → mới | Nguồn tra cứu | Trạng thái |
|---|------|------------------|---------------|------------|
| 1 | `src/hooks/useServiceWorker.ts` | giữ nguyên — async/await chỉ ~15% ngắn hơn (< 20% threshold), catch đã typed | MDN | ✅ giữ nguyên |
| 2 | `src/hooks/useTauriEvents.ts` | giữ nguyên — `.then(fn)` + cancelled flag ĐÚNG pattern Tauri v2 `listen(): Promise<UnlistenFn>` | context7 Tauri v2 namespace/event | ✅ giữ nguyên |
| 3 | `src/utils/nextTrackPrefetcher.ts` | `.then().catch().finally()` chain → async IIFE (37→31 dòng, gộp 2 nhánh lỗi cancel về 1 try/catch) | MDN Fetch API + typescript-eslint v8 | ✅ xong (commit 9b78e41) |
| 4 | `src/utils/sessionCleanup.ts` | giữ nguyên — đã `Promise.allSettled`; `.then` bắt buộc vì hàm sync (logout không block, comment nêu rõ) | — | ✅ giữ nguyên |
| 5 | `src/utils/metadata/api.ts` | giữ nguyên — shared-promise single-flight BẮT BUỘC (dedupe); async/await có trap nuốt lỗi | — | ✅ giữ nguyên |
| 6 | `src/utils/coverStore.ts` | giữ nguyên — semaphore + retry phân loại + circuit breaker + AbortSignal.timeout, vượt chuẩn | — | ✅ giữ nguyên |

## Kết luận audit (Giai đoạn 2 — đã cross-verify)

- Mojibake `�?"`: **0 chỗ** (audit grep + Main Agent rg xác nhận) — claim ban đầu sai.
- APPROVE 1 upgrade: `nextTrackPrefetcher.ts` (đạt threshold ngắn hơn ~30%, test file phủ đầy behavior contract).

## Backlog (cross-file findings)

| File | Pattern | Ghi chú |
|------|---------|---------|
| `src/utils/apiClient.ts:80-98` | `withTimeout` → `Promise.withResolvers()` (Baseline 2024) | ngắn ~20-25% — task riêng |
| `src/utils/apiClient.ts:503`, `driveHttp.ts:35`, `driveRangeTokenizer.ts:150` | có guard `AbortSignal.any`; `nextTrackPrefetcher.ts:45` không guard | rủi ro ~0 (WebView2 evergreen) |
