# Periodic Delta Sync (Recently-Added real-time) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task.

**Goal:** Files added to Drive from OTHER devices/web must appear in the app (library + Recently Added) without a manual reload — add a periodic background delta sync + refresh-on-window-focus.

**Root cause (xác nhận):** `proSync.worker` chạy ĐÚNG 1 lần mỗi session (startProSyncWorker từ useAuth lúc login; worker KHÔNG self-loop, không setInterval). `pro-sync-complete` (HomeTab dùng để refetch Recently Added) chỉ fire 1 lần lúc login → upload từ thiết bị khác không bao giờ hiện tới khi reload (reload → delta sync chạy lại).

**Architecture:** Main-thread poller hook — setInterval (PRO_SYNC_POLL_MS) gửi `{type:"sync", token}` cho worker (worker đã xử lý sync message + isBusy guard + delta-vs-full tự chọn theo startPageToken) + trigger ngay khi window focus (debounced). Worker KHÔNG cần sửa logic sync — chỉ thêm 1 helper trigger phía manager. HomeTab KHÔNG cần sửa (đã listen pro-sync-complete → debounce refetch).

**Tech Stack:** Existing proSync worker + proSyncManager; React hook; Drive changes API.

## Global Constraints

- **NGHIÊM CẤM tự nghĩ ra cơ chế** (standing user requirement): research-first — Google Drive changes API polling best practice (nguồn Google docs), sync interval chuẩn; cite nguồn + ngày; báo cáo deviation.
- TDD; TypeScript strict; hằng số tên; captureError; ≤100 dòng/fn; lint/tsc sạch; comment "why" tiếng Anh.
- Baseline: 89 files / 1209 tests pass (commit 8865066).
- KHÔNG đổi logic sync trong worker (chỉ thêm trigger phía main); KHÔNG đổi HomeTab/UI.

---

### Task 1: Periodic delta sync poller

**Files:**
- Modify: `src/utils/proSyncManager.ts` — lưu `lastToken` (khi startProSyncWorker/updateWorkerToken); thêm `export function triggerProSync()` → post `{type:"sync", token: lastToken}` (no-op nếu chưa có token); thêm test.
- Create: `src/hooks/useProSyncPoller.ts` — setInterval PRO_SYNC_POLL_MS → triggerProSync(); window 'focus' + 'visibilitychange' (visible) → trigger debounced (VD 2s); cleanup clearInterval + remove listeners + cancel debounce; gọi triggerProSync() NGAY khi mount (bắt kịp thay đổi từ phiên trước mà không cần chờ interval).
- Mount: trong `src/hooks/useAuth.ts` cạnh startProSyncWorker (chỉ khi có token; unmount khi logout) — xem chỗ gọi startProSyncWorker hiện tại.
- Modify: test — `src/utils/proSyncManager.test.ts` (triggerProSync posts đúng token; no-op khi chưa có token), tạo `src/hooks/useProSyncPoller.test.tsx` (fake timers: interval fire, focus fire, cleanup, debounce focus), cập nhật `useAuth.test.ts` nếu mount ở đó.

**Industry standard (research trước khi code — bắt buộc cite):**
- Google Drive changes API: changes.list với startPageToken, polling interval khuyến nghị (~60s trong official samples), 410 → full resync.
- Sync app pattern: poll khi app hoạt động + refresh ngay khi focus; tránh poll khi hidden (nếu research khuyến nghị, có thể bỏ qua hidden → quyết định + báo cáo).

**Behavior contract:**
- Khi app mở (bất kỳ tab nào): delta sync mỗi PRO_SYNC_POLL_MS (đề xuất 60s — theo research; hằng số có tên + comment vì sao) → file mới từ thiết bị khác xuất hiện trong Recently Added ≤ ~1 phút + trong db.files (search index invalidation tự động qua pro-sync-progress/complete — đã có).
- Window focus → delta sync ngay (debounce 2s — tránh spam khi alt-tab nhanh).
- Mount poller (login có token) → trigger ngay 1 lần (bắt kịp thay đổi ngay, không chờ 60s).
- Logout → poller dừng (cleanup); worker terminate đã có sẵn.
- isBusy guard trong worker chặn overlap (SYNC_BUSY — không lỗi, không log spam).
- KHÔNG thay đổi: HomeTab refresh logic, worker sync logic, Recently Added fetch.

**Rủi ro dự kiến (báo cáo trung thực):** mỗi 60s 1 request changes.list (nhẹ — không có change thì không tốn files.list); API quota; app hidden vẫn poll (quyết định theo research — có thể dừng khi hidden).

## Self-Review
- Root cause → fix: poller gửi sync message định kỳ → delta sync chạy → SYNC_COMPLETE (chỉ khi có change — worker đã guard) → HomeTab refetch → Recently Added cập nhật; db.files cũng cập nhật → mọi view + search đúng.
- Không đụng UI; worker logic giữ nguyên (chỉ thêm trigger main-side).
- Test phủ: manager trigger, hook interval/focus/cleanup, useAuth mount.
