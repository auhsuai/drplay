# Modernize Log

Theo dõi các file đã được hiện đại hóa (skill: closed-loop-code-modernize).
Mỗi batch = 1 nhóm file liên quan, mỗi file = 1 dispatch riêng (TDD).

## Batch 1 — Core utils (2026-08-09)

| # | File | Pattern cũ → mới | Nguồn tra cứu | Trạng thái |
|---|------|------------------|---------------|------------|
| 1 | `src/hooks/useServiceWorker.ts` | giữ nguyên — async/await chỉ ~15% ngắn hơn (< 20% threshold), catch đã typed | MDN | ✅ giữ nguyên |
| 2 | `src/hooks/useTauriEvents.ts` | giữ nguyên — `.then(fn)` + cancelled flag ĐÚNG pattern Tauri v2 `listen(): Promise<UnlistenFn>` | context7 Tauri v2 namespace/event | ✅ giữ nguyên |
| 3 | `src/utils/nextTrackPrefetcher.ts` | `.then().catch().finally()` chain → async IIFE (~30% ngắn hơn) | MDN fetch / Response.body.cancel | ⏳ dispatch |
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
