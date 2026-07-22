# CHANGELOG_REFACTOR.md — drplay (branch `refactor/cover-image-and-tags`)

Bước 5 của phương pháp luận 5 bước (Audit → Research → Plan → Execute → Changelog). Tổng hợp toàn bộ các milestone đã thực thi trên nhánh này, từ `AUDIT.md`/`REFACTOR_PLAN.md` ban đầu đến đợt xử lý CONCERN còn lại. Mỗi mục nêu: thay đổi, lý do, cách verify, và rủi ro/blind spot còn lại (nếu có).

---

## M1 — [Bảo mật] OAuth token → OS keychain

- `keyring` crate (Windows Credential Manager / macOS Keychain / Linux Secret Service) thay `localStorage` cho `refresh_token`. `access_token` (ngắn hạn, ~1h) vẫn giữ in-memory phía JS, không round-trip IPC mỗi lần check hạn.
- 3 command Rust mới: `store_token`/`get_token`/`clear_token` (`src-tauri/src/commands/token_store.rs`), nhận `account` param để tránh hard-code chuỗi rải rác.
- **Verify:** `cargo check` không chạy được đầy đủ trong sandbox (thiếu `webkit2gtk-devel`, hạn chế vĩnh viễn của môi trường này) — verify qua standalone crate riêng cho API usage của `keyring`. **Cần test thật trên Windows** (`cargo tauri dev`) trước khi merge.

## M2 — [Bảo mật] CSP structured form + bỏ `unsafe-inline`

- `tauri.conf.json`: CSP chuyển từ chuỗi flat sang dạng object có cấu trúc, bỏ `unsafe-inline` khỏi `script-src` (Tauri tự inject nonce).
- **Verify:** không tự kiểm tra được GUI trong sandbox — **cần test thật** (`cargo tauri dev`) để xác nhận app vẫn load đúng (rủi ro lý thuyết: nonce injection sai → màn hình trắng).

## M3 — [Hiệu năng/Kiến trúc] Đơn giản hóa slice cache bằng `moka::try_get_with`

- Thay `InflightEntry`/`InflightGuard` hand-rolled (Notify-based waiters, `Arc::ptr_eq` cleanup-on-drop) bằng `moka::try_get_with` — cùng guarantee (coalesce concurrent fetch cho cùng key) nhưng native, ít code tự viết hơn.
- Giữ nguyên API public (`try_get`, `get_or_fetch`, `batch_insert`, `find_missing_run`, `used_bytes`).
- **Phát hiện quan trọng lúc đó:** `get_or_fetch` có đầy đủ test (dedup, error-propagation, leader-cancel) nhưng **0 caller thực trong production** — `stream.rs` gọi `fetch_range_from_drive`/`batch_insert` trực tiếp, không dedup. Đã báo cho user, không tự vá vào hot path lúc đó. → Giải quyết ở M9 (xem dưới).
- **Verify:** standalone crate riêng, 7 test pass.

## M4 — [Bảo mật] `oauth2` v4.4.2 → v5

- v4's `oauth2::reqwest::http_client`/`async_http_client` helper mặc định follow redirect trong lúc exchange code/token — v5 docs gọi đây là rủi ro SSRF, yêu cầu tự build `reqwest::Client` với `redirect::Policy::none()`.
- `BasicClient::new()` (v5) chỉ nhận `ClientId`, cấu hình còn lại qua builder (`.set_client_secret/set_auth_uri/set_token_uri/set_redirect_uri`).
- **Verify:** standalone crate, chạy thật với Google endpoint (lỗi đúng như kỳ vọng với credential giả).

## M5 — Dọn dẹp rủi ro thấp (bug xác nhận + code chết + docs)

- Rust: hằng số trùng lặp gộp về 1 nguồn; GET `/stream` sai RFC 9110 (luôn trả 206 kể cả không có `Range` header) → sửa theo đúng chuẩn (200 khi không Range); `trim_cached_slice` thiếu nhánh `else`.
- React: bug shuffle-mode prefetch sai queue (`usePlayer.ts`); `document.execCommand` → `navigator.clipboard.writeText`; xóa export chết `cachePrefetchedStream`; `useLocateFile.ts` type đúng (`CustomEvent<...>` thay `any`); xóa 2 listener chết `drive-quota-exceeded` + component `RateLimitModal` không dùng (đã verify đường xử lý quota thật qua `X-Stream-Error-Type` header không bị ảnh hưởng).
- Docs: `README.md` xóa tham chiếu file/package không còn tồn tại (`thumbnail.rs`, `scanner.worker.ts`, `music-metadata`, `crossfade`).
- **Verify:** `npx tsc --noEmit` sạch, `npx vitest run` pass, `npm run build` thành công.

---

## Đợt xử lý CONCERN còn lại trong AUDIT.md (theo quyết định batch của user)

Sau M1-M5, user liệt kê lại các CONCERN chưa xử lý và ra quyết định theo 5 nhóm (E/D/C/B/A). D (build/release: CI multi-platform, code signing, updater) — bỏ qua theo yêu cầu, không có budget.

### B — Code chết / tính năng chưa hoàn thiện

- **`folderFetchGuard.ts`:** xác nhận qua grep toàn bộ codebase — 0 caller thực (`fetchFolderContents`'s `_guard` param không được truyền ở đâu). Xóa module + test + param.
- **`db.metadataCache` (Dexie):** không có gì viết vào từ khi pipeline R2/SQLite tag-cache cũ bị gỡ. Xóa khỏi schema qua version bump có cấu trúc (`stores({ metadataCache: null })` — Dexie yêu cầu `null` rõ ràng để drop table, không chỉ omit).
- **`handleManualResume` (PlayerBar):** điều tra kỹ trước khi quyết — phát hiện đây KHÔNG phải code chết mà là feature có logic đầy đủ (reducer set `manualResume` khi `NotAllowedError`/autoplay bị chặn) nhưng thiếu UI trigger. Quyết định wire vào (nút play + banner "tap to resume") thay vì xóa, vì xóa sẽ mất khả năng phục hồi thật của app.
- **`toastDismissRef` (`usePlaybackControl.ts`):** điều tra xác nhận 0 reader ở bất kỳ đâu — xóa.
- **`useDownload.ts` buffer nguyên file:** chuyển sang Rust command `download_file_to_disk` (mới), dùng `tokio::fs`/`AsyncWriteExt` ghi từng chunk thẳng ra đĩa — bộ nhớ renderer không còn tăng theo kích thước file (quan trọng cho FLAC lossless lớn).

### E — Cải thiện frontend (tùy chọn, user chọn làm cả 2)

- **React Compiler 1.0** (stable, ổn định từ 10/2025): auto-memoization ở build time, giảm nhu cầu tự viết `React.memo`/`useMemo`/`useCallback` — liên quan trực tiếp vì lịch sử app có nhiều bug `React.memo`-related ở khu vực virtualization.
- **TanStack Virtual `directDomUpdates`:** gate `rerender()` React chỉ khi tập item hiển thị thực sự đổi (không phải mỗi tick scroll). Áp dụng đầy đủ (`containerRef` + bỏ `transform` inline, để library tự viết thẳng vào DOM qua `elementsCache`) cho danh sách My Drive chính (đã có `measureElement` sẵn cho đo chiều cao động). HomeTab/LikedSongs/PlaylistView (hàng cố định chiều cao, không `measureElement`) chỉ bật cờ `directDomUpdates: true` — vẫn có lợi ích gate-rerender (độc lập với việc có `elementsCache` hay không) nhưng không đổi JSX, vì thiếu `measureElement` thì bỏ `transform` inline sẽ làm mất vị trí item.

### A — Kiến trúc Rust (làm theo tiêu chuẩn tốt nhất)

- **Structured logging:** `eprintln!`/`println!` (14 chỗ) → `tauri-plugin-log` (chính thức, KHÔNG chọn `tauri-plugin-tracing` vì đó là crate bên thứ 3 của 1 người, ~21k download, kèm flamegraph/profiling/OpenTelemetry app không cần). Log level khớp mức độ nghiêm trọng thật (content-type-override + diag perf = debug vì quá thường xuyên; retry-exhausted = error). Target Stdout + LogDir (trước đây KHÔNG lưu gì — crash không có terminal đính kèm = 0 chẩn đoán). Giữ `eprintln!` song song CHỈ ở 1 dòng build() Err fatal (bảo vệ trường hợp log plugin tự nó chưa init xong).
- **`Result<T, String>` → `AppError` (thiserror + serde `tag=kind,content=message`):** áp dụng cho toàn bộ 12 command. **Phát hiện quan trọng:** 2 nơi frontend (`apiClient.ts`'s `getValidToken`, `LoginScreen.tsx`) substring-match text lỗi để quyết định hành vi thật (logout khi `invalid_grant`, chọn toast khi timeout) — đổi sang object `{kind, message}` sẽ làm `String(err)` ra `"[object Object]"` và VÔ HIỆU HÓA các nhánh đó nếu không sửa. Đã tạo `src/utils/appError.ts` (`isAppError`/`getErrorMessage`) và sửa mọi nơi đọc message lỗi. Thêm test mới assert `auth-logout` event thật được dispatch (không chỉ check return null, vì mọi nhánh catch của `getValidToken` đều return null bất kể phân loại đúng/sai).
- **Static → `Arc<T>` cho state dùng chung Tauri+Axum:** đúng theo phạm vi audit đã chỉ rõ — chỉ 2 giá trị MUTABLE (`GLOBAL_BUFFER_SECONDS`, `GLOBAL_SLICE_CACHE`), fold vào `AppState` (đã có cơ chế Axum State injection đúng cho `client`/`cache_store`) + `app.manage()` cho Tauri. `PROXY_SECRET`/`PROXY_PORT`/`GLOBAL_STREAM_TOKEN`/rate-limit & prefetch atomics GIỮ static (audit tự xác nhận write-once value là ổn, không đổi) — không mở rộng thành viết lại toàn bộ global.

### C — Dedup thật vào hot path streaming (rủi ro cao nhất, làm cuối)

- Wire `SliceCache::get_or_fetch` (đã có từ M3, 0 caller) vào CẢ HAI nơi: main response loop và background prefetch loop trong `stream.rs`. Trước đây 2 caller đồng thời cho cùng `(track_id, offset)` — phổ biến nhất là main loop của request mới đua với prefetch loop của request cũ cho cùng track — sẽ cả hai gọi Drive độc lập.
- Giữ nguyên batching nhiều-slice-1-request (không đánh đổi hiệu năng batching để lấy dedup): closure fetch cả batch, `batch_insert` các slice `[1..count]` như side effect, trả slice đầu cho `get_or_fetch` tự cache.
- Phải genericize `get_or_fetch` (trước đây hardcode `String`) để giữ được variant `DriveErr` cụ thể (`Rate` vs `NotFound` vs...) xuyên qua một lượt dedup-wait — logic retry/backoff bên ngoài cần phân biệt được.
- **Giới hạn đã biết** (nêu rõ trong doc comment `get_or_fetch`): dedup theo offset bắt đầu của batch, không phải full range-lock — 2 caller mà `find_missing_run` cho kết quả overlap KHÔNG trùng khớp offset bắt đầu thì vẫn không được dedup với nhau. Sửa chính xác cần interval-tree in-flight tracker, không tương xứng với mức rủi ro của một gap chỉ gây lãng phí gọi Drive, không gây sai kết quả.
- **Verify:** không compile được app đầy đủ trong sandbox (như mọi lần) — verify qua (1) `rustfmt --check` toàn bộ file đã sửa (0 lỗi cú pháp), (2) file `slice_cache.rs` thật copy nguyên văn vào crate độc lập, chạy với đúng commit `moka` đã pin — cả 7 test cũ pass với signature mới, (3) crate độc lập mô phỏng đúng pattern kết hợp (generic error type + `batch_insert` re-entrant từ trong `try_get_with` init future của key khác + typed error propagate tới waiter), (4) crate độc lập mô phỏng ĐÚNG kịch bản động cơ ban đầu — main-loop-style và prefetch-loop-style đua nhau fetch CÙNG batch — xác nhận giảm từ 2 lần gọi Drive xuống 1, tất cả slice cache đúng bất kể ai làm leader, batch KHÔNG overlap vẫn độc lập đúng.

---

## Xung đột với commit trực tiếp của owner (auhsuai) trong lúc agent đang làm việc

Trong lúc thực thi đợt batch B/E/A/C, owner đã tự commit trực tiếp lên CÙNG nhánh (`5288eb9` — "fix: hover flicker at card edges in virtualized list + overscroll-contain on all scroll views", author `auhsuai`), xây trên đúng commit cuối cùng agent đã push trước đó (`1fe2504`). Phát hiện qua `git fetch` trước khi push (không giả định remote không đổi). Đã `git rebase` toàn bộ 6 commit của batch này lên trên `5288eb9` — 0 conflict thật (không có file nào cả 2 bên cùng sửa CÙNG vùng: `SongCard.tsx` — file owner sửa cấu trúc nhiều nhất — không nằm trong bất kỳ commit nào của batch này; `VirtualizedSongList.tsx`'s `pb-2`→`pb-3` cả 2 bên sửa độc lập nhưng ra giá trị GIỐNG NHAU nên git tự merge sạch). Verify lại toàn bộ (`tsc`/`vitest`/`build`) sau rebase — 161/161 test pass, build thành công. Đã diff cây cuối cùng trên GitHub so với local — khớp byte-for-byte, không mất gì từ cả 2 phía.

---

## Trạng thái verify tổng thể

Sandbox không có `webkit2gtk-devel` (không có trong repo AL2023) → không `cargo build`/`cargo check` được cho toàn bộ app Tauri — hạn chế **vĩnh viễn** của môi trường này, không phải lỗi riêng của đợt này. Đã bù bằng:
- `rustfmt --check` cho mọi file Rust đã sửa (xác nhận cú pháp hợp lệ độc lập với thư viện hệ thống thiếu).
- Standalone crate riêng cho mọi logic Rust rủi ro cao (dùng đúng version/commit dependency đã pin trong `Cargo.toml`).
- Frontend: `npx tsc --noEmit`, `npx vitest run`, `npm run build` — pass đầy đủ.

**Cần làm trên máy thật trước khi merge vào main:**
- `cargo tauri dev`/`build` đầy đủ trên Windows (nền tảng duy nhất app này ship).
- Test thủ công: login → refresh token → logout (M1 keychain); CSP không làm trắng màn hình (M2); phát nhạc, seek nhanh, để prefetch chạy dài rồi seek qua vùng nó đang tải (M9 dedup); tải file lớn xem RAM renderer không tăng (B5 streaming download); xem file log thật được tạo ở đúng thư mục theo OS (A1 logging).
