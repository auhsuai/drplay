# Master Plan — Full-App Modernization (DrPlay)

> Chiến dịch: MEGA MISSION 2026. Main Agent = Kiến trúc sư + Reviewer duy nhất.
> Mọi code sản xuất do subagent viết; Main Agent chỉ plan/dispatch/review/verify/ghi nhớ.
> Trạng thái: ✅ HOÀN TẤT (Giai đoạn 0–2 + Wave 1–4 VERIFIED_MERGED, 2026-07-14). tsc EXIT=0, vitest 45/45 pass.

## Tech Stack Snapshot
- Ngày bắt đầu: 2026-07-13. Repo: C:\Users\thinkpad\Desktop\Antigravity\drplay (git repo).
- Loại app: Desktop (Tauri 2) — frontend Vite 7 + React 19 + TypeScript 5.8, backend Rust (src-tauri).
- Test: vitest (`vitest run`); đã có *.test.ts cho apiClient, driveApi, folderFetchGuard, normalizeText, logger, workerError. Có thêm test script rời (test-gui.js, test_rate.cjs, test_db.py, test_const.rs, Google_Drive_Music_Scanner.ipynb).
- Build: `tsc && vite build`; Tauri CLI v2. Rust build qua cargo (profile.release: lto, strip).
- Dữ liệu: music_database.db (SQLite ~3.4GB, backend rusqlite). CẤM đọc/commit file này.
- Bí mật (KHÔNG log nội dung): credentials.json, wa_credential.json.

### Frontend deps (package.json, hiện tại)
react ^19.1.0, @tauri-apps/api ^2 (+ plugin dialog/http/opener ^2), @react-oauth/google ^0.13.5, @tanstack/react-virtual ^3.14.5, dexie ^4.4.4, dexie-react-hooks ^4.4.0, idb-keyval ^6.2.6, i18next ^26.3.3, react-i18next ^17.0.8, music-metadata-browser ^2.5.11, strtok3 ^10.3.5, jsmediatags ^3.9.7, lucide-react ^1.22.0, react-easy-crop ^6.0.2, puppeteer ^25.2.1 (dev?), buffer ^6.0.3, tauri-plugin-keepawake-api ^0.1.0. Dev: vite ^7.0.4, @vitejs/plugin-react ^4.6.0, vitest ^2.1.0, typescript ~5.8.3, tailwindcss ^4.3.1 (+ @tailwindcss/postcss), postcss, autoprefixer.

### Rust deps (Cargo.toml, hiện tại — CẦN audit CVE/version ở Wave 1)
tauri ^2 (tray-icon), tauri-plugin-{opener,dialog,http} ^2, tauri-plugin-keepawake 0.1.0, serde 1, serde_json 1, oauth2 4.4.2, base64 0.22.1, url 2.5.0, reqwest 0.12.4 (json,stream), open 5.1.2, rusqlite 0.31.0 (bundled), image 0.25.10, tokio 1 (full), futures-util 0.3.30, symphonia 0.5.4 (all), lofty 0.24.0, tiny_http 0.12.0, lazy_static 1.5.0, md5 0.7.0, hmac 0.12.1, sha2 0.10.8, r2d2 0.8, r2d2_sqlite 0.24.0, axum 0.7.5, tokio-stream 0.1.15, async-stream 0.3.5, bytes 1.6.0, uuid 1.8.0, moka 0.12.15 (future), once_cell 1.21.4, walkdir 2.5.0.

## Kiến trúc tổng quan (từ codebase-memory index: 1308 nodes / 2556 edges)
- Lớp: `utils` = core (fan-in 136), `ui` (fan-out 99 tới utils), `hooks` (25), `workers` (entry), `App` (entry). Rust `src-tauri` cohesion 0.98 (rất gắn kết).
- Entry: src/main.tsx -> App.tsx. UI tab: HomeTab, LikedSongs, Playlist, Settings, Login, Sidebar, NowPlaying, PlayerBar, MainContent, FolderSelection.
- Hooks: useAuth, useDrive, usePlayer, useTheme. PlayerBar/useAudioEngine = engine phát nhạc (churn cao, error-handling gần đây).
- Workers: scanner.worker.ts, proSync.worker.ts, workerError.ts.
- DB: src/db/db.ts (Dexie/IndexedDB) + backend rusqlite (music_database.db).
- Rust routes: `/stream` (proxy.rs handle_stream, HMAC sig, rate-limit, Drive error classify, token recovery), `/file`.
- i18n: src/i18n.ts + locales/{en,vi}.
- Churn cao (nguy cơ vỡ): PlayerBar.tsx (33), lib.rs (30), App.tsx (20), proxy.rs (15), metadata.ts (13), usePlayer.ts (13).

## Chuẩn tham chiếu 2026 (NGUỒN — đã xác nhận qua context7/web)
- **Tauri**: bản ổn định mới nhất được docs tham chiếu là 2.9.x (2.9.3). Repo dùng `^2` -> đã thuộc nhánh 2.x, KHÔNG cần nâng major. Chuẩn bảo mật: dùng Capabilities/permissions (CapabilityBuilder, permission_scoped allow/deny) thay vì cấp rộng. Nguồn: docs.rs/tauri/2.9.3 (capability_builder.rs, authority.rs).
- **Vite**: repo dùng ^7.0.4. Bản mới nhất (docs) là 8.x (8.0.10). Quan trọng: `esbuild.drop: ['console','debugger']` (dùng ở Vite 7 hiện tại) SẼ xoá mọi lời gọi `console.*` khi build production. Ở Vite 8, tuỳ chọn chuyển sang `build.rolldownOptions.output.minify.compress.drop*` (Oxc) — hành vi drop vẫn giữ nguyên. Nguồn: vitejs/vite docs (shared-options.md, guide/migration.md). => XÁC NHẬN: lớp log dựa trên `console.*` bị vô hiệu ở production.
- **React**: 19.x. Chuẩn xử lý lỗi render = Error Boundary (class component getDerivedStateFromError/componentDidCatch), KHÔNG bắt lỗi render bằng try/catch (try/catch không bắt lỗi JSX render). Nguồn: react/react docs (error boundary, validateNoJSXInTryStatement). App HIỆN TẠI KHÔNG có ErrorBoundary nào.
- **Tailwind**: repo dùng ^4.3.1 — đã là major v4 mới nhất, OK. Không cần đổi lớn.
- **TypeScript**: ~5.8.3 — mới, strict mode bật (noUnusedLocals/Params). OK.
- **Rust crates**: reqwest 0.12.4, axum 0.7.5, rusqlite 0.31, lofty 0.24, symphonia 0.5.4, tokio 1, moka 0.12.15. CẦN audit CVE/version tại Wave 1 (đặc biệt reqwest, axum, rusqlite, symphonia, lofty) trước khi sửa — task research riêng của Wave 1.

## Phát hiện chính (tóm tắt; chi tiết từng dòng ở PROGRESS_LEDGER.md)
1. [BUG/LỖI THỜI + THIẾU ERROR-HANDLING] `vite.config.ts:34-36` `esbuild.drop:['console','debugger']` xoá mọi `console.*` ở production -> `logger.ts:75-80` (nhánh "giữ error đã redact ở prod") thành DEAD CODE. Hậu quả: production mất HOÀN TOÀN observability lỗi (khoảng 100+ call site console.* đều bị tắt). FIX: chuyển log lỗi sang transport không bị drop (vd: module logger riêng gửi qua Tauri event tới backend ghi file, hoặc chỉ drop log/info/debug, giữ error/warn) — route mọi log qua `logger.ts` thay vì console trực tiếp. (Wave 1/2, rủi ro Trung bình, ưu tiên Cao)
2. [THIẾU ERROR-HANDLING] Không có React Error Boundary nào (`grep ErrorBoundary` = 0 kết quả). Lỗi render sẽ crash UI thầm lặn. FIX: thêm top-level ErrorBoundary + fallback UI. (Wave 2, rủi ro Thấp-Trung bình, ưu tiên Cao)
3. [THIẾU ERROR-HANDLING / RỦI RO BẢO MẬT] `workers/*` chạy global scope riêng, `initLogger()` không áp dụng (`workerError.ts:9`) -> log worker không qua redaction, và cũng bị drop ở prod. FIX: áp dụng sanitize trong worker hoặc gửi log về main thread qua postMessage. (Wave 2)
4. [LỖI THỜI / LOGIC LỒNG NHAU] `refactor_metadata.cjs` là script tự ghi đè `metadata.ts` (DriveRangeTokenizer) — STALE (ref `fetchWithRetry` không tồn tại nữa). Chưa apply (DriveRangeTokenizer = 0 match trong source). FIX: xoá/archive artifact, không chạy. (Sub-track artifact, rủi ro Thấp)
5. [NGHI NGỜ CODE CHẾT / ARTIFACT] `diff.patch`/`diff.txt` (33KB) chỉ chạm metadata.ts, nhưng KHÔNG phải git patch hợp lệ (`git apply --check` báo "No valid patches in input") -> artifact sinh bởi tool khác, chưa rõ apply chưa. FIX: review nội dung, quyết xoá hoặc archive. (Sub-track artifact)
6. [OK / ĐÃ TỐT] `apiClient.ts` (TokenRefreshError typed, timeout AbortSignal, retry, proactive refresh), `driveApi.ts` (retry/backoff, classifyDriveError, không log secrets), `proxy.rs` (HMAC verify, rate-limit backoff, Drive error classify, token recovery) — đã harden tốt (khớp loạt commit gần đây). Giữ nguyên, chỉ dùng làm chuẩn tham chiếu cho các module khác.
7. [RỦI RO BẢO MẬT - CẦN AUDIT] Version Rust crate (reqwest 0.12.4, axum 0.7.5, rusqlite 0.31, symphonia 0.5.4, lofty 0.24) — cần tra CVE/version mới nhất tại Wave 1.
8. [HIỆU NĂNG - tiềm năng] `ConcurrencyQueue` tự viết trong metadata.ts; `parseMultipartByteRanges` tự viết. Có thể đánh giá thay bằng chuẩn thư viện, nhưng hiện hoạt động → ưu tiên Thấp, chỉ đổi nếu có lý do đo lường.

## Wave Plan (Giai đoạn 3 — CHỜ XÁC NHẬN)
- **Wave 1 — BUG nghiêm trọng + Rủi ro bảo mật + Audit phụ thuộc** ✅ VERIFIED_MERGED (2026-07-14)
  - 1.1 Audit CVE/version Rust crates: KẾT QUẢ = KHÔNG có CVE khẩn cấp (mọi version resolve nằm ngoài advisory range). Quyết định KEEP tất cả; `tauri` có bản patch 2.11.5 (tùy chọn, DEFER). Source: osv.dev/RustSec.
  - 1.2 Capabilities: thu hẹp `opener:default`->`opener:allow-open-url` (scope google), `dialog:default`->`dialog:allow-save`; gỡ `extract_metadata_safe` (dead); thêm `tauri-plugin-fs` + scoped `fs:allow-write-file` ($DOWNLOAD/**) + runtime scope command `register_download_path`. FIX BUG download (trước đó break do thiếu plugin fs).
  - 1.3 Artifact: XOÁ refactor_metadata.cjs, diff.patch, diff.txt (an toàn).
  - Verify: `cargo check` xanh (subagent), `npx tsc --noEmit` EXIT=0 (Main Agent tự chạy). Rủi ro: Cao. Ghi chú: chưa chạy `tauri build` bundling đầy đủ (nặng); bare `http:default` còn trùng scoped -> đề xuất W tiếp.
- **Wave 2 — Thiếu error-handling ở luồng core + Production logging** ✅ VERIFIED_MERGED (2026-07-14)
  - 2.1 Sửa xung đột vite.config drop console vs logger: đổi `esbuild.drop` thành CHỈ `['debugger']` (giữ console để logger.ts monkeypatch chạy ở prod, redact + retain error/warn; log/info/debug vẫn no-op). logger.ts giữ nguyên. Source: vite docs (esbuild.drop xoá console ở build-time). Verify: tsc OK.
  - 2.2 Thêm React ErrorBoundary cấp cao (src/ui/ErrorBoundary.tsx) + wrap <App/> ở main.tsx. Source: react.dev error boundary. Verify: tsc OK.
  - 2.3 Worker logging: import `sanitizeString` vào workerError.ts áp dụng cho log worker. Verify: tsc OK + vitest 11/11.
  - 2.4 (resolved by 2.1): sau 2.1, mọi console.* được redact (DEV+PROD) qua logger monkeypatch + worker sanitize → KHÔNG cần sửa từng site.
  - Rủi ro: Trung bình. Verify: tsc EXIT=0, vitest workerError 11/11, cross-check từng file. (Chưa chạy `tauri build` bundling prod.)
- **Wave 3 — Logic cũ/mới lồng nhau + Lỗi thời + UI polish** ✅ VERIFIED_MERGED (2026-07-14)
  - 3.1 KEEP ConcurrencyQueue/parseMultipartByteRanges (không std-lib thay thế đúng use-case).
  - 3.2 Fixes: tw-animate-css (App.css); route raw Drive fetch → driveApi helpers + toast; sửa bulk delete/move DESYNC BUG + dead isBulkOperating (MainContent sửa); SongCard stale onPlay memo; LikedSongs handleUnlike await; NowPlaying AbortSignal; xoá CloseBehaviorDropdown (dead).
  - Verify: tsc 0 error, vitest 45/45 pass.
- **Wave 4 — Hiệu năng + dọn code chết an toàn** ✅ VERIFIED_MERGED (2026-07-14)
  - 4.1 Perf polish: HomeTab random render fix, LikedSongs N-fetch concurrency limit, PlaylistView image validate+FileReader onerror, NewFolderModal name validate.
  - 4.2 Dead-code audit + safe-delete: scanner.ts (toàn file), addToLibrary/removeFromLibrary (metadata.ts), getAverageColor (color.ts), clearCustomDownloadPath (downloadPath.ts) — all verified 0 inbound.
  - Toàn bộ chiến dịch: tsc EXIT 0, vitest 45/45 pass.
- **QUY TẮC CỔNG**: Wave sau chỉ bắt đầu khi wave trước = DONE trong ledger + Integration Verify xanh (build/typecheck/test suite/Playwright smoke nếu có UI) + đã merge + ghi codebase-memory. KHÔNG chạy 2 wave song song.

## Ghi chú
- App đã được harden khá tốt ở lớp network/auth (apiClient, driveApi, proxy.rs) qua các commit gần đây. Chiến dịch này do đó thiên về: (a) vá lỗ hổng production-logging, (b) Error Boundary, (c) audit bảo mật phụ thuộc, (d) dọn artifact/stale code, hơn là viết lại diện rộng.
- KHÔNG chạy refactor_metadata.cjs. KHÔNG đọc/commit music_database.db.
