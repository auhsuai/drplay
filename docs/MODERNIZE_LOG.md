# Modernize Log

Theo dõi các file đã được hiện đại hóa (skill: closed-loop-code-modernize).
Mỗi batch = 1 nhóm file liên quan, mỗi file = 1 dispatch riêng (TDD).

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
