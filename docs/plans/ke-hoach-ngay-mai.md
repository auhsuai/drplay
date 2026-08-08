# KẾ HOẠCH CHO NGÀY MAI — 08/08/2026

> Trạng thái: 07/08/2026 ~21:40. Tất cả thay đổi ĐANG NẰM Ở WORKING TREE (CHƯA COMMIT).
> Lời tự phê: các fix vòng trước là **làm ngọn** (chặn triệu chứng, ngăn hậu quả). **Gốc rễ chưa đụng tới.**

---

## PHẦN 1 — TOÀN BỘ LỖI ĐANG GẶP (bằng chứng từ log thật)

### Lỗi 1: Range fetch Google Drive timeout — GỐC RỄ của mọi thứ
- Log 18:16 (bản cũ): `metadata-fetch-failed (size=218-751MB, format=unknown): Range fetch timed out after 30000ms` — head fetch fail.
- Log 20:20 (sau Fix A): head fetch **thành công** (format=mp3 detect được) nhưng **tail read timeout**: `bytes=297598976-297631120` (chunk cuối file 297MB), `bytes=152698880-152731970`... — Drive seek tới cuối file lớn chậm.
- Log 21:02: head timeout cả file **40-46MB** (`bytes=0-131071`) → không còn giới hạn file lớn → nghi vấn **cạn quota/throttle toàn account**.
- Log 21:25: **mọi track fail code=4 tức thì (~1 bài/giây)** nhưng Network tab: `/drive-stream/...?ext=mp3` → **206 Partial Content (from service worker)** — mạng/token OK → response body rỗng/truncated hoặc Content-Type sai.
- **CHƯA TRẢ LỜI ĐƯỢC**: vì sao range fetch chậm/timeout. Chưa đo thật (TTFB, status thật, quota usage).

### Lỗi 2: Tự next bài liên tục (auto-advance storm)
- Cơ chế đã truy: AudioController code=4 (SRC_NOT_SUPPORTED) → emit error(format_error) + ended → PlayerBar onNextTrack → next track → fail → lặp ~1 bài/giây.
- Toast không thấy vì PlayerBar clear errorInfo khi track đổi (PlayerBar.tsx:41-44).
- Đã chặn triệu chứng bằng Fix I (storm guard) — chưa verify full suite.

### Lỗi 3: Không hiện ảnh cover (dù tag chuẩn)
- Console: `ERR_UNKNOWN_URL_SCHEME` cho `drplay://cover?id=...` + `cover-post-failed: Failed to fetch` + `getPalette image load failed`.
- 2 nguyên nhân chồng nhau:
  a) **Rust binary STALE trong tiến trình `tauri dev`** (khởi động trước commit 936325c — protocol drplay:// chưa tồn tại trong binary) → mọi drplay:// fail. User chưa restart hoàn toàn.
  b) **Bug CORS thật (đã fix trong code, chưa build)**: response POST /cover thiếu `Access-Control-Allow-Origin` (mod.rs) → browser chặn POST → disk cache rỗng.
- Đã chặn triệu chứng bằng Fix G (blob fallback từ pictureData) — chưa verify full suite.

### Lỗi 4: Hiện "00:00:00" thay vì duration
- Placeholder v:9 (duration 0) resolve thành công → SongCard formatDuration(0) = "00:00:00".
- Đã fix (Fix F: hiện "–") — chưa verify full suite.

---

## PHẦN 2 — ĐÃ LÀM GÌ (Fix A→I, TẤT CẢ CHƯA COMMIT)

| Fix | Nội dung | File | Verify |
|---|---|---|---|
| A | Head 128KB = 1 request (prefetchHead) | driveRangeTokenizer.ts | test scoped xanh |
| B | Retry timeout 1 lần (không retry khi caller abort) | driveRangeTokenizer.ts | test scoped xanh |
| C | Placeholder KHÔNG dính sau lỗi network tạm thời | metadata.ts | test scoped xanh |
| D | **Rust CORS**: thêm Access-Control-Allow-Origin mọi response drplay:// | src-tauri/protocol/mod.rs | cargo test 37 passed — **CẦN BUILD RUST MỚI CÓ HIỆU LỰC** |
| E | File ≥100MB parse head-only (clamp size, bỏ tail read) | metadata.ts | test scoped xanh |
| F | Hiện "–" thay "00:00:00" khi duration chưa biết | SongCard.tsx | test scoped xanh |
| G | Cover blob fallback khi drplay:// không khả dụng | coverStore.ts, SongCard.tsx, useNowPlayingMetadata.ts | 5 file/153 tests xanh |
| H | Circuit breaker Drive throttle (3 lỗi/30s → fail nhanh 60s) | driveRangeTokenizer.ts | 5 file/153 tests xanh |
| I | Storm guard: ≥3 format_error/15s → dừng auto-next + banner | PlayerBar.tsx + i18n | PlayerBar 56/56 xanh |

**Verify tổng CHƯA HOÀN TẤT**: full `npx vitest run` bị người dùng gián đoạn 3 lần (không phải fail — bị abort). Lần cuối subagent khai 96 files/1377 tests PASS nhưng **Main Agent chưa tự chạy xác nhận (Luật 6)** → việc ĐẦU TIÊN ngày mai.

---

## PHẦN 3 — GỐC RỄ CHƯA GIẢI QUYẾT (việc quan trọng nhất ngày mai)

### Câu hỏi gốc: VÌ SAO Drive range fetch timeout? (chưa có câu trả lời có đo đạc)

**Giả thuyết xếp theo độ mạnh (cần kiểm chứng bằng đo thật):**

1. **CẠN QUOTA/THROTTLE TÀI KHOẢN (mạnh nhất)** — log tiến triển khớp hoàn hảo:
   stall file lớn (18:16) → head OK/tail timeout (20:20) → cả file 40MB timeout (21:02) → mọi thứ code=4 (21:25).
   Google Drive API giới hạn media download ~10.000 request/ngày/user; **mỗi 64KB chunk = 1 request quota**. Pipeline metadata hôm nay đã đốt: nhiều file × (head + parse + tail) × retry × nhiều lần render + storm cover POST.
   → CẦN: kiểm tra trang quota Google Cloud / API dashboard (nếu có) HOẶC đọc response headers thật của 1 request khi fail (429/403 quotaExceeded?).

2. **Concurrency + first-byte latency của content-download host với file lớn** — Drive phục vụ file >~100MB qua redirect content-download; nhiều request đồng thời (semaphore 3 + audio + cover) → first-byte chậm >30s. Bằng chứng: chỉ file lớn fail lúc đầu; <audio> 1 luồng chạy được.

3. **Multipart range là giải pháp quota tối ưu đã bị bỏ** — pipeline cũ (git bef00d3~1, `http://drplay.localhost/stream?id=...`) gửi **1 request `bytes=0-65535,{tailStart}-{tailEnd}`** (multipart/byteranges) = **1 quota unit cho head+tail**. Pipeline mới 64KB/chunk = nhiều request → tốn quota gấp 4-8 lần. Hướng: **đổi driveRangeTokenizer sang multipart cho head+tail** (1 request) hoặc nâng RANGE_CHUNK (64KB → 256KB/1MB).

4. **Chưa đo được**: TTFB thật từng loại range (head/tail/mid), status thật khi fail (429/403/206), có quota usage API không.

### Điều cần làm để chốt gốc (ngày mai, BƯỚC 1):
- [ ] User: restart HOÀN TOÀN `npm run tauri dev` (tắt hẳn → chạy lại → Rust rebuild).
- [ ] User: Network tab → chụp/chép **Response Headers ĐẦY ĐỦ** của request /drive-stream/ fail (Content-Type, Content-Range, Content-Length, x-* error?) + trường hợp 206 mà code=4.
- [ ] User: thử phát 1 file NHỎ (vài MB) — nếu code=4 luôn → vấn đề toàn cục; nếu phát được → vấn đề file lớn.
- [ ] Đo script nhỏ (trong app hoặc curl có token): time-to-first-byte cho `bytes=0-131071` và `bytes={size-65536}-{size-1}` trên file 50MB vs 300MB, 1 request vs 3 concurrent.
- [ ] Kiểm tra quota: Google Cloud Console → APIs & Services → Quotas (nếu project có quyền xem) — xem Drive API download quota đã dùng bao nhiêu.

---

## PHẦN 4 — KẾ HOẠCH NGÀY MAI (theo thứ tự ưu tiên)

### Bước 1 (sáng): Verify + ổn định hiện trạng
- [ ] Chạy full `npx vitest run` (96 files ~1377 tests) + `npx tsc --noEmit` + `npx eslint` — xác nhận Fix A-I xanh sạch.
- [ ] Commit toàn bộ Fix A-I (1 commit hoặc tách theo nhóm) — ghi rõ trong commit message.
- [ ] User restart `npm run tauri dev` hoàn toàn → kiểm tra: cover hiện? còn 00:00:00? còn tự next?

### Bước 2 (trưa): Điều tra GỐC — đo thật Drive
- [ ] Thu thập bằng chứng mục "Điều cần làm để chốt gốc" ở trên.
- [ ] Chốt giả thuyết 1/2/3/4 bằng số liệu thật (không đoán).
- [ ] Nếu = quota cạn: chờ reset (~nửa đêm PT) + thiết kế giảm request quota tối đa + UI cảnh báo quota thay vì im lặng.

### Bước 3 (chiều): Sửa GỐC theo bằng chứng
Các phương án (chọn theo kết quả Bước 2, KHÔNG làm trước khi có số liệu):
- [ ] **P1 — Multipart range**: driveRangeTokenizer gộp head+tail vào 1 request `bytes=0-{head-1},{tailStart}-{tailEnd}` (parse multipart/byteranges như pipeline cũ từng làm) → giảm 50%+ request quota.
- [ ] **P2 — Tăng RANGE_CHUNK**: 64KB → 256KB hoặc 1MB (ít request hơn, bớt nhạy với first-byte latency).
- [ ] **P3 — Timeout thích nghi theo kích thước**: file lớn → timeout dài hơn (60-90s) cho TAIL read riêng; hoặc bỏ tail read cho file lớn hoàn toàn (đã làm phần head-only ở Fix E, mở rộng nếu cần).
- [ ] **P4 — Quota-aware metadata scheduler**: ngừng metadata fetch khi đang phát (audio ưu tiên tuyệt đối); đếm request/day, dừng sớm khi gần ngưỡng.
- [ ] **P5 — Nếu token hết hạn là thủ phạm code=4**: kiểm tra luồng refresh token trong SW (SW_TOKEN_EXPIRED → waitForTokenChange → UPDATE_TOKEN) — SW trả 401 text → audio code=4; cần log rõ loại status trong AudioController (phân biệt 401/429/403/HTML).

### Bước 4 (tối): Đóng vòng
- [ ] Verify full suite + test live trên máy user (Drive thật).
- [ ] Commit fix gốc + ghi codebase-memory ADR đầy đủ.
- [ ] Báo cáo user: gốc là gì (có số liệu), đã sửa thế nào.

---

## PHẦN 5 — NGƯỜI DÙNG CẦN LÀM (để mọi thứ có hiệu lực)

1. **Restart HOÀN TOÀN `npm run tauri dev`** (tắt hẳn terminal → chạy lại). Tauri dev KHÔNG tự rebuild Rust nếu tiến trình chạy từ trước → Rust binary đang stale (thiếu drplay:// + CORS fix).
2. Đừng mở `http://localhost:1420` trong trình duyệt riêng — drplay:// chỉ chạy trong WebView của Tauri (Fix G đã làm cover chạy được cả 2 nơi, nhưng đúng môi trường vẫn quan trọng).
3. Khi gặp lỗi: F12 → Network → chép **Response Headers đầy đủ** của request /drive-stream/ + status. Đây là bằng chứng quyết định để chốt gốc.
4. Nếu muốn xác nhận quota: Google Cloud Console → Quotas (Drive API) hoặc kiểm tra hóa đơn/quota qua dashboard Google.

---

## PHẦN 6 — LỆNH VERIFY CHUẨN

```powershell
# Frontend full suite
npx vitest run
# TypeScript
npx tsc --noEmit
# Lint file đụng
npx eslint <các file đụng>
# Rust (src-tauri)
cargo test --lib
# Trạng thái working tree (tất cả chưa commit)
git status --short
```

---

## GHI NHỚ (tránh lặp lại sai lầm)

- **Làm gốc trước, ngọn sau**: mọi fix mới phải trả lời được "nó sửa vì sao range fetch timeout" bằng SỐ LIỆU ĐO ĐƯỢC, không phải suy đoán.
- **Mỗi 64KB chunk = 1 request quota Google** — thiết kế fetch phải quota-aware.
- **Rust binary stale = triệu chứng giả**: restart tauri dev trước khi nghi ngờ code frontend.
- **Toast bị clear khi track đổi** — không dùng "không thấy toast" làm bằng chứng "không có lỗi".
- **Fix D (CORS Rust) đã sửa nhưng CHƯA BUILD** — chưa có hiệu lực gì cho tới khi user restart.
