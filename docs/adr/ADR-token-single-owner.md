# ADR: Token single-owner — Rust proxy giữ single-flight, FE/SW chỉ hỏi token

- **Trạng thái:** Proposed (chưa triển khai)
- **Ngày:** 2026-09-19
- **Commit tham chiếu:** 7252004 (main)
- **Phạm vi:** RC-8 (§13 FINAL-ARCHITECTURE-AUDIT), debt G7 (§12), P8 §11.6/§12 mục 8, P1 F9/O5
- **Ngoài phạm vi:** login/logout UX, mô hình bảo mật keyring, retry matrix HTTP data plane (§16 mục 3 — giữ nguyên)

## 1. Bối cảnh (đọc từ code thật tại 7252004)

### 1.1 Ba bản sao access token, ba mô hình hết hạn khác nhau

| Nơi giữ | Lưu ở đâu | Hết hạn theo | Ai mint |
|---|---|---|---|
| FE — `src/utils/tokenRefresh.ts` | localStorage (`ACCESS_TOKEN_KEY` + `TOKEN_TIME_KEY`, dòng 273-284) | `TOKEN_EXPIRY_MS` = 50 phút (dòng 39, 190) | FE, single-flight `refreshPromise` (50-54, 197-222) |
| Rust proxy — `src-tauri/src/stream_proxy/mod.rs` | memory `cached: Mutex<Option<String>>` (72-89) | Không mốc thời gian — chỉ 401 buộc đổi (112-115) | Rust, single-flight qua `refresh_lock` + `generation` (117-232) |
| SW — `public/sw.js` | biến module `accessToken` (5) | Không — chờ `UPDATE_TOKEN` (682-687) | Không tự mint; chờ FE đẩy sang (822-831) |

### 1.2 Hai writer của OS credential vault (refresh token)

1. **FE**: `getValidToken` → `invoke("refresh_google_token")` (tokenRefresh.ts:230); nếu response có `refresh_token` xoay vòng thì `await writeRefreshToken(...)` (285-294) → `invoke("set_refresh_token")` (refreshTokenStore.ts:161); keyring lỗi → giữ memory + localStorage + marker "newer" (195-206). Login cũng ghi qua đường này (useAuth.ts:184-192). Logout xóa vault (useAuth.ts:325-327).
2. **Rust proxy**: trong `DriveTokenSource.refresh` — đọc vault `token_store::get_refresh_token` (mod.rs:159), mint `auth::refresh_google_token` (176), rotation ghi thẳng `token_store::set_refresh_token` (193-221).

Cả hai cùng đọc/ghi một entry keyring `drplay/refresh_token` (token_store.rs:21-24). Không có khóa chung xuyên tiến trình. `DriveTokenSource` được tạo bên trong `stream_proxy_start` (mod.rs:264-270) và sống trong proxy server task — không expose qua app state.

### 1.3 Ba retry/refresh policy

| Tầng | Retry refresh | Timeout |
|---|---|---|
| FE | lỗi mạng → tối đa 4 lần, base 30s / max 120s (tokenRefresh.ts:45-47, 132-155); `invalid_grant`/unknown → `auth-logout` (321-330) | refresh 15s (refreshTokenStore.ts:16), keyring 5s (22) |
| Rust | 401 → `refresh(true)` đúng 1 lần → retry request → 401 thứ hai = 502 (server.rs:172-180) | vault 5s, mint 15s (mod.rs:50, 80-84) |
| SW | 401 → chờ chủ tối đa 10s (`SW_TOKEN_WAIT_TIMEOUT_MS`, sw.js:15) → retry 1 lần (822-831); 429/5xx backoff 400/1200ms (782-801) | 10s chờ token (15) |

### 1.4 Đối chiếu audit ↔ code

Audit RC-8 viết "3 stack token refresh (Rust/SW/FE) cung ghi vault" — **không đúng với code**: SW không mint, không ghi vault; nó chỉ giữ bản sao và chờ `UPDATE_TOKEN`. Thực tế có **2 writer vault** (FE và Rust proxy) và **1 waiter** (SW). Phần còn lại của RC-8 (rotation 2 writer, 3 retry policy) khớp code.

## 2. Vấn đề / Rủi ro

1. **Rotation race xuyên tiến trình (cấu trúc cho phép, CHƯA có bug thực chứng).** FE và Rust có thể mint đồng thời từ cùng một refresh token; nếu Google xoay token, hai bên ghi vault không phối hợp → last-writer-wins. Một bên mint thất bại `invalid_grant` (do bên kia vừa xoay) → proxy trả 502 cho mpv dù FE đang giữ token mới. Mức độ evidence: audit P8 phân loại "STRONGLY INDICATED — chưa thấy report bug thực tế" (§15), §17 Q5. Không được nâng thành FACT.
2. **FE chỉ tự bảo vệ bản thân.** Precedence memory → marker → keyring (refreshTokenStore.ts:72-121) chỉ chống keyring cũ cho chính FE; nó không thấy bản ghi của Rust.
3. **Logout chưa thông báo cho Rust.** `deleteRefreshToken` xóa vault, nhưng access token Rust đang cache trong memory vẫn sống tới khi gặp 401 (pre-existing; sẽ nghiêm trọng hơn nếu Rust thành owner duy nhất). `DriveTokenSource` không có khái niệm session.
4. **Ba policy retry lệch nhau** (bảng 1.3): cùng một lỗi mạng, ba tầng xử lý khác nhau, không có bảng chung.

## 3. Quyết định

**Rust giữ vai trò single-owner refresh/mint; FE và SW trở thành consumer.**

- **Authority duy nhất mint access token**: `DriveTokenSource` (đã có single-flight + generation + timeout, có test tại mod.rs:805-888). Mở thành app-managed state và expose command `get_valid_access_token` (tên làm việc) trả access token còn/hết hạn theo mốc của chính Rust.
- **Vault refresh token**: chỉ một đường ghi rotation trong luồng refresh — Rust. FE không còn persist rotation (`writeRefreshToken` chỉ còn dùng cho login/keyring-fallback, giữ nguyên hành vi ở đó). Login vẫn qua FE vì `login_google_native` trả token cho webview; đây là writer vault thứ hai **chỉ ở login** (một lần/phiên), không phải rotation — chấp nhận trong ADR này.
- **FE**: `getValidToken` giữ nguyên chữ ký nhưng bỏ nhánh tự mint; khi cần token mới thì `invoke` command trên. Vẫn cache access token trong localStorage để các HTTP call của webview + push SW không đổi hành vi.
- **SW**: không đổi gì. `UPDATE_TOKEN` vẫn được đẩy từ FE (nguồn token giờ là Rust qua FE). Hợp đồng `SW_TOKEN_EXPIRED` → `getValidToken(true)` → push giữ nguyên (useServiceWorker.ts:201-218).
- **Logout**: thêm command Rust `invalidate_token` (clear cache + generation++), FE gọi trong luồng logout song song với `deleteRefreshToken`. Đây là điều kiện tiên quyết của quyết định, không phải follow-up.
- **Retry refresh hợp nhất**: 1 bảng duy nhất cho nhánh refresh (đề xuất giữ numeric của FE: 4 lần, 30s→120s) do Rust sở hữu; SW thuần túy là waiter, không tính là một policy refresh.

### Phương án đã cân nhắc và loại

- **FE làm owner** (FE mint rồi đẩy Rust): loại — mpv phát qua Rust proxy không phụ thuộc webview; webview bận/treo không được phép chặn playback refresh. Rust đã có single-flight + test đầy đủ hơn.
- **Truyền token tường minh FE→Rust mỗi lần load** (P1 §12 mục 6 phương án 2): loại — kéo dài đường token qua URL/command của engine, không xử lý được SW metadata lane, và làm tăng bề mặt lộ token.

## 4. Migration plan (ADR → spike → migrate)

1. **R0 — no-code (ADR này):** chốt boundary đọc/ghi; liệt kê testable vs cần spike (mục 5).
2. **Spike A (đo race thực tế — chưa đủ evidence):** log có cấu trúc (không token) tại 2 điểm mint: `tokenRefresh.ts` nhánh success và `DriveTokenSource.refresh` success, mỗi log `{writer, rotated: bool, ts}`; chạy vài ngày/phiên dài, đếm số lần 2 writer xoay trong cùng cửa sổ < 30s. Không cần spike nếu chỉ chốt quyết định kiến trúc — nhưng **không được ghi "đã đo"** khi chưa chạy.
3. **Spike B (khả thi kỹ thuật):** kiểm tra `DriveTokenSource` chuyển từ per-proxy-task (mod.rs:264-270) sang `app.manage` dùng chung; xác nhận không đổi hành vi 401-once→502 (test hiện có phải xanh).
4. **B1 — Rust:** tách `SharedTokenSource` + command `get_valid_access_token` + `invalidate_token`. Rollback: chưa ai gọi command, hành vi cũ giữ nguyên.
5. **B2 — FE:** `getValidToken` chuyển nhánh mint sang invoke command; keyring read vẫn giữ cho login/fallback; bỏ `writeRefreshToken` trong nhánh rotation sau khi B1 ổn định 1 phiên. Có cờ rollback (đường cũ vẫn compile).
6. **B3 — FE logout:** gọi `invalidate_token` + test race logout ↔ refresh (session id đã có cơ chế tương tự trong tokenRefresh.ts:296-305).
7. **B4 — dọn:** xóa retry refresh của FE khi nhánh mint cũ không còn caller; cập nhật ADR sang Accepted.

**Rollback từng bước:** B1/B2 độc lập (command không được gọi = vô hại); B3 fail → logout vẫn xóa vault như hiện tại, chỉ mất tính năng clear cache Rust (pre-existing).

## 5. Test — cái gì testable ngay, cái gì cần spike

- **Testable ngay (unit, không cần Tauri runtime):** single-flight Rust (đã có, mod.rs:862-888); single-flight FE (tokenRefresh.test.ts); precedence refreshTokenStore; hành vi 401-once→502 (server tests).
- **Testable sau B1 (mock invoke):** FE gọi command thay vì mint; logout gọi `invalidate_token`.
- **Cần spike/integration (không unit test được):** race rotation thực tế xuyên tiến trình; ordering logout ↔ refresh; hành vi khi vault treo đồng thời cả hai bên. Nếu không chạy được integration, ghi rõ trong ADR khi Accept.

## 6. Open questions

1. Google có xoay refresh token thường xuyên không, và token cũ có bị vô hiệu ngay sau rotate không? (chưa có evidence trong repo).
2. Tần suất thực tế của cửa sổ race (Spike A chưa chạy).
3. Sau khi Rust thành owner, FE còn cần giữ access token trong localStorage cho lane nào ngoài HTTP API + push SW? (cần liệt kê caller `getValidToken` trước B2).
4. Multi-account/tương lai có phá giả định "1 tài khoản/entry keyring" (token_store.rs:22-24) không.

## 7. Ranh giới không đụng

- Không đổi retry matrix data plane của Rust proxy (§16 mục 3), không đổi `stream_proxy` data plane boundary (§16 mục 4).
- Không đổi cơ chế bảo mật keyring/localStorage đang chạy (token_store.rs:1-17 — mô hình threat đã accepted).
- Không đổi hợp đồng SW wait/retry (sw.js:775-833) ngoài nguồn token.
