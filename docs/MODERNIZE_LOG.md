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

## Batch 11 — MainContent UI + components (2026-08-16)

Audit 18 file (MainContent/*, SongCard, DropZone, UploadButton, SortDropdown, BottomNav...): 82 pattern, **1 upgrade APPROVE**.

| # | File | Pattern cũ → mới | Nguồn tra cứu | Trạng thái |
|---|------|------------------|---------------|------------|
| 1 | `src/ui/MainContent/components/ProgressRing.tsx` | `role="img"` → `role="progressbar"` + `aria-valuenow/min/max` (determinate upload progress announce live) | W3C APG + MDN progressbar | ✅ xong (commit `2e53c9f`) |

81 pattern giữ nguyên — nhóm đạt chuẩn cao: TanStack Virtual directDomUpdates (3.14.5 verified .d.ts), useSyncExternalStore uploadVersion, Tauri onDragDropEvent native, custom memo comparator SongCard (KHÁC compiler — load-bearing cho stale-prop fix).

## Backlog (Batch 11 — cross-file findings)

| Hạng mục | Chi tiết |
|----------|----------|
| Dead prop `isInitialMount` | Chain 3 file (MainContent:342 → TopNavigationBar:27,46,323 → SortDropdown:21,46) + 3 test file — 100% dead, không consumer đọc. Precedent: dead prop token (c7119bb). Skill refactor |
| APG arrow-key nav cho menu | UploadButton + SortDropdown + MoreMenu/ThemeDropdown/LanguageDropdown thiếu ArrowDown/Up/Home/End — app-wide, cần shared menu primitive |
| formatDuration vs formatTime | 2 formatter song song khác contract ("HH:MM:SS" vs "M:SS") — giữ, DRY nit |
| parseInt partial parse | PaginationControls:91-96 — "12abc"→12, nit UX |
| UploadBadge `<div aria-label>` không role | a11y nit, transient cue, low severity |

## Batch 10 — Playback UI (2026-08-16)

Audit 18 file (PlayerBar/* + NowPlaying/* + Seek components): 46 pattern, **4 upgrades APPROVE** (3 dispatch).

| # | File | Pattern cũ → mới | Nguồn tra cứu | Trạng thái |
|---|------|------------------|---------------|------------|
| 1 | `src/ui/PlayerBar/PlayerBar.tsx` | nested ternary errorText (4 nhánh) → `ERROR_TEXT` Record + `??` fallback | eslint no-nested-ternary | ✅ xong (commit `bddc723`) |
| 2 | `src/ui/PlayerBar/TrackInfo.tsx` | `useAuthStore.getState().accessToken` (non-reactive, chỗ duy nhất trong repo) → `useAuthStore((s) => s.accessToken)` — token refresh refetch cover | zustand v5 README | ✅ xong (commit `236dc15`) |
| 3 | `src/ui/PlayerBar/VolumeSlider.tsx` | `AudioController.getInstance().toggleMute()` (chỗ duy nhất còn singleton) → `audio.toggleMute()` prop; thêm `pointercancel` (trước kẹt isVolumeActive + rò listener) | pattern repo (useSeekDrag) | ✅ xong (commit `650708e`) |

42 pattern giữ nguyên — PlaybackEngine surface 100% khớp sau Batch 8, render-time adjust chuẩn React 19, DOM-direct hot path đúng (useSyncExternalStore KHÔNG áp dụng 4/s tick).

## Backlog (Batch 10 — cross-file findings)

| Hạng mục | Chi tiết | Skill đề xuất |
|----------|----------|---------------|
| Input-focus guard lặp ×3 | useKeyboardShortcuts:22-28, useSeekKeyboard:29-35, VolumeSlider:58-64 (activeElement INPUT/TEXTAREA/contentEditable) | extract `isTextInputTarget()` |
| Transport button + playMode toggle trùng | TransportControls:87-133 vs NowPlayingControls:55-118 | extract shared component |
| `seekRelative` lặp ×2 | PlayerBar:98-104 vs NowPlayingView:46-52 | extract `useRelativeSeek(audio)` |
| Dead prop `showFolderIcon` | Skeleton.tsx:105, 0 caller | xoá (như dead prop token LikedSongs) |
| Cleanup setState lúc unmount | useNowPlayingMetadata:123-128 (no-op React 18+) | defensive dead code |
| setTimeout không cancel unmount | useSeekDrag:122 | benign (React 18+ no-op) |

## Batch 9 — Player core hooks (2026-08-16)

Kết luận audit: **4/4 file chuẩn 2026 — 0 upgrade đạt threshold** (zustand v5 API đúng, React 19 race-guard chuẩn, error handling typed-unknown + captureError context).

| # | File | Kết luận | Ghi chú |
|---|------|----------|---------|
| 1 | `src/hooks/usePlayer.ts` | ✅ giữ nguyên | useShallow v5, handlePlayTrackRef latest-callback (useEffectEvent KHÔNG thay thế được — callback truyền xuống sub-hook), AbortController abort-previous, isAbortError phân loại, clone `{...prev}` mobile resume có chủ đích |
| 2 | `src/hooks/player/usePlayerQueue.ts` | ✅ giữ nguyên | NEXT_MODE Record type-safe, Fisher-Yates chuẩn, fallbackHead edge case lock, getState() ngoài render đúng zustand v5, flatMap 1-pass |
| 3 | `src/hooks/player/usePlayerSession.ts` | ✅ giữ nguyên | AbortController + isAborted() sau mọi await, throttle manual SAVE_THROTTLE_MS=5000 named, beforeunload+pagehide dual (Android), getPlaybackEngine đã modernize |
| 4 | `src/hooks/player/utils.ts` | ✅ giữ nguyên | classifyPlayerError, isAbortError duck-typed (jsdom), seekRelative clamp + SeekableAudio interface tối thiểu |

## Backlog (Batch 9 — cross-file findings)

| Hạng mục | Chi tiết |
|----------|----------|
| Dead-write `lastSessionKv` | sessionCleanup:13,35 DELETE + usePlayerSession:57,62 READ, nhưng KHÔNG nơi nào WRITE key này (grep toàn src xác nhận) → fallback kv production luôn `undefined`. Giữ defensive (test D lock). Cần xác minh ý đồ dual-write với user trước khi sửa. |

## Batch 8 — Android group (2026-08-16)

Audit nhóm Android mới nhất (commit 2026-08-14/15): 5 file, 27 pattern, 3 upgrades APPROVE.

| # | File | Pattern cũ → mới | Nguồn tra cứu | Trạng thái |
|---|------|------------------|---------------|------------|
| 1 | `src/lib/nativeAudioBridge.ts` | cast `as unknown as AudioController` → `PlaybackEngine` interface (2 engine `implements`); 9 magic strings → `PLUGIN_COMMAND` constants | TypeScript handbook + MDN | ✅ xong (commit `f5380ee`) |
| 2 | `src/hooks/useMediaSession.ts` | 6 chỗ `AudioController.getInstance()` → `getPlaybackEngine()` (fix media keys chạm HTMLAudio chết trên Android) | Tauri docs | ✅ xong (commit `3a39f00`) |
| 3 | `src/App.tsx` + `useHardwareBack.ts` | popstate/pushState hack → `registerNativeBackHandler()` dùng `onBackButtonPress` (Tauri 2.9+) | PR #14133 (merged 15/10/2025) | ✅ xong (commit `7f875cf`) |
| 4 | `useNativeAudio.ts`, `useBackgroundPlayback.ts`, `useHardwareBack.ts` stack | ✅ giữ nguyên (23 pattern khác) | MDN + Tauri docs | ✅ giữ nguyên |

Lưu ý: config key `app.onBackButtonPress` KHÔNG tồn tại trong schema Tauri 2.11 (deny_unknown_fields) — native side enabled qua codegen TauriActivity.kt, không đổi tauri.conf.json. Verify hạn chế theo yêu cầu user: test files liên quan + tsc + eslint (không full build/vitest). Cần test thiết bị Android thật (back chain, media keys).

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
