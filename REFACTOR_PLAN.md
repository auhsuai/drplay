# REFACTOR_PLAN.md — drplay (branch `refactor/cover-image-and-tags`)

Dựa trên `AUDIT.md` và các quyết định đã chốt ngày 2026-07-22 (mục 8 của AUDIT.md). Milestone sắp theo đúng thứ tự ưu tiên đã yêu cầu: bảo mật/hiệu năng trước, dọn dẹp/UI sau.

## Nguyên tắc chung
- Mỗi milestone độc lập, test riêng, có thể rollback riêng.
- Không xóa code cũ ngay khi có đường fallback hợp lý — nêu rõ ở từng milestone.
- Rust không build được đầy đủ trong sandbox (thiếu WebKitGTK) → verify bằng `cargo check`/`cargo test` trên phần tách được, phần còn lại (đặc biệt milestone M1 — crate `keyring` cần system lib dbus/secret-service trên Linux) sẽ nêu rõ là **chưa verify được trong sandbox**, cần bạn test trên máy Windows thật (`cargo tauri dev`/`build`) trước khi merge.
- Frontend verify bằng `npx tsc --noEmit`, `npx vitest run`, `npm run build`.

---

## M1 — [Bảo mật] Chuyển OAuth token sang OS keychain (`keyring` crate)
**Trạng thái:** Đã approve (câu 1). Thực thi ngay.

- **File ảnh hưởng:** `src-tauri/Cargo.toml` (+`keyring`), file mới `src-tauri/src/commands/token_store.rs`, `src-tauri/src/lib.rs` (đăng ký command), `src-tauri/capabilities/default.json` (nếu cần permission), `src/hooks/useAuth.ts`, `src/utils/apiClient.ts`.
- **Thiết kế:** 3 command Rust (`store_token`, `get_token`, `clear_token`) nhận `account` (`"access_token"`/`"refresh_token"`) để tránh hard-code chuỗi rải rác. Access token vẫn giữ 1 bản in-memory ở phía JS (tránh round-trip IPC mỗi lần check hạn) — chỉ đọc từ keychain lúc khởi động app.
- **Rollback:** đọc keychain trước, fallback đọc `localStorage` cũ nếu keychain trống (hỗ trợ user nâng cấp từ bản cũ) — xóa hẳn nhánh `localStorage` ở milestone dọn dẹp sau khi xác nhận ổn qua vài lần dùng thật.
- **Rủi ro/blind spot đã biết:** `keyring` crate cần thư viện hệ thống (dbus/secret-service trên Linux) để compile với đầy đủ feature — sandbox này nhiều khả năng KHÔNG có các lib đó, nên `cargo check` có thể fail dù logic đúng. Sẽ thử verify, và nêu rõ nếu không verify được.
- **Test:** `cargo check` (best-effort), sau đó bạn cần thử full login→refresh→logout trên Windows thật.

## M2 — [Bảo mật] CSP: chuyển dạng object có cấu trúc + bỏ `unsafe-inline` khỏi `script-src`
**Trạng thái:** Đã approve (câu 2). Thực thi ngay.

- **File ảnh hưởng:** `src-tauri/tauri.conf.json` (duy nhất).
- **Rollback:** revert 1 file, tức khắc.
- **Test:** `cargo tauri dev` thật trên máy bạn để xác nhận app vẫn load được (rủi ro lý thuyết: nonce injection sai có thể làm màn hình trắng) — sandbox không chạy được GUI để tự kiểm tra bước này.

## M3 — [Hiệu năng/Kiến trúc] Đơn giản hóa slice cache bằng `moka::get_with`/`try_get_with`
**Trạng thái:** Đã approve (câu 4). Thực thi ngay.

- **File ảnh hưởng:** `src-tauri/src/slice_cache.rs` (thay đổi chính), `src-tauri/src/proxy/stream.rs` (chỗ gọi `get_or_fetch`).
- **Giữ nguyên API public:** `try_get`, `get_or_fetch`, `batch_insert`, `find_missing_run`, `used_bytes` — không đổi signature, để không phải sửa call site khác ngoài `stream.rs`.
- **Rủi ro:** code lõi streaming — sai có thể gây đứng nhạc. Phải giữ nguyên hành vi mà `InflightGuard` hiện chống (request đang chạy bị cancel giữa chừng phải "wake" các request đang chờ, không được leak).
- **Rollback:** file khá độc lập, dễ revert nguyên file.
- **Test:** giữ toàn bộ test hiện có trong `slice_cache.rs` + `tests/eviction_stall.rs` pass, viết thêm test cho case concurrent-cancel để đảm bảo hành vi y hệt bản cũ.

## M4 — [Bảo mật, ĐỀ XUẤT — CHƯA THỰC THI, chờ approve riêng] Nâng cấp `oauth2` v4.4.2 → v5
**Trạng thái:** Đề xuất trong kế hoạch theo đúng ràng buộc gốc ("không tự ý đổi major dependency"). Sẽ hỏi lại riêng trước khi làm — KHÔNG động vào ở đợt này.

- **File ảnh hưởng (nếu làm):** `Cargo.toml` (`oauth2` 5.x, `reqwest` 0.12), `src-tauri/src/commands/auth.rs` (constructor mới, tự cấu hình `redirect::Policy::none()`).
- **Rủi ro:** breaking API toàn diện ở 2 call site auth.
- **Rollback:** pin lại `oauth2 = "4.4.2"`.

## M5 — [Dọn dẹp rủi ro thấp] Sửa bug đã xác nhận + code chết + docs
**Trạng thái:** Đã approve (câu 5, 6→không đổi gì, 8→chỉ sửa docs). Thực thi ngay, gộp thành các commit nhỏ độc lập theo nhóm.

**Nhóm Rust:**
- Hằng số trùng lặp (`TRACK_CACHE_MAX_ENTRIES`, `DB_POOL_MAX_SIZE`) → 1 nguồn duy nhất.
- GET `/stream` luôn trả `206` dù không có `Range` → sửa theo đúng nhánh HEAD (200 khi không có Range).
- `status != 206` literal → `StatusCode::PARTIAL_CONTENT`.
- `trim_cached_slice` thiếu nhánh `else { chunk.clear(); }`.

**Nhóm React:**
- Bug 3.1: `usePlayer.ts` prefetch sai queue ở shuffle mode → dùng biến `shuffled` đã tính, không dùng `contextQueue` gốc.
- `document.execCommand` deprecated → `navigator.clipboard.writeText`.
- Xóa export chết `cachePrefetchedStream`.
- `useLocateFile.ts`: `e: any` → `CustomEvent<...>` đúng kiểu.
- `sortDriveItems.ts`: `Intl.Collator` → singleton module-level.
- Xóa nhánh chết `"Settings page coming soon..."` trong `MainContent.tsx`.
- Xóa 2 listener chết `drive-quota-exceeded` (`App.tsx`, `usePlaybackControl.ts`) + component `RateLimitModal` không dùng nữa — **sẽ verify trước** đường xử lý quota thật (qua `X-Stream-Error-Type` header) không bị ảnh hưởng.

**Docs:**
- `README.md`: xóa tham chiếu `thumbnail.rs`, `scanner.worker.ts`, `music-metadata`, `crossfade` — các mục này không còn tồn tại trong code.

- **Rollback:** mỗi nhóm là commit riêng, revert độc lập nếu cần.
- **Test:** `npx tsc --noEmit`, `npx vitest run`, `npm run build`; `cargo check` cho phần Rust tách được.

---

## Thứ tự thực thi (Bước 4)
M2 (nhanh, an toàn) → M5 (batch nhỏ, độc lập) → M3 (Rust lõi, cần test kỹ) → M1 (Rust+TS, cần test kỹ + có blind spot sandbox) → verify toàn bộ → CHANGELOG_REFACTOR.md (Bước 5).
M4 giữ nguyên ở dạng đề xuất, không thực thi.
