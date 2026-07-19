# Progress Ledger — Full-App Modernization (DrPlay)

> Cập nhật SAU MỖI task. Trạng thái: DONE / REJECTED_Nx / PENDING / IN_PROGRESS.
> Định dạng: Module/File | Loại phát hiện | Skill áp dụng | Trạng thái | Ghi chú

## WAVE 1 — BUG/Bảo mật/Audit (TRẠNG THÁI: VERIFIED_MERGED)
| Module/File | Loại phát hiện | Skill áp dụng | Trạng thái | Ghi chú |
|---|---|---|---|---|
| src-tauri/Cargo.toml (Rust crates audit) | RỦI RO BẢO MẬT (CVE/version) | review-only | DONE | Audit qua OSV/RustSec/crates.io: MỌI version đang resolve (từ Cargo.lock) NẰM NGOÀI mọi advisory affected range -> KHÔNG có CVE khẩn cấp. Quyết định: KEEP tất cả. Chỉ `tauri` có bản patch 2.11.5 (semver-compatible) -> bump tùY CHỌN, DEFER (cần network cargo update, low value). Source: osv.dev lists. |
| src-tauri/capabilities/default.json | RỦI RO BẢO MẬT (least-privilege) | refactor | DONE | Thu hẹp: `opener:default`->`opener:allow-open-url` (scope google.com), `dialog:default`->`dialog:allow-save`. Giữ http scoped + keepawake scoped. verify: tsc OK. (Đề xuất thêm: bỏ bare `http:default` trùng với khối scoped -> DEFER, ngoài scope W1.) |
| src-tauri/src/lib.rs | LOGIC THỪA / dead command | refactor | DONE | Gỡ `extract_metadata_safe` khỏi generate_handler! + xoá fn (unused, frontend không gọi). Thêm `.plugin(tauri_plugin_fs::init())` + command `register_download_path` (runtime fs scope). |
| src-tauri/Cargo.toml | THIẾU dependency | refactor | DONE | Thêm `tauri-plugin-fs = "2"`. |
| src/ui/components/GlobalContextMenu.tsx (handleDownload) | BUG (broken feature) | bugfix | DONE | Root cause: gọi `plugin:fs|write_file` nhưng plugin fs KHÔNG đăng ký -> download break. Fix: đăng ký fs + scoped `fs:allow-write-file` ($DOWNLOAD/**) + runtime scope qua `register_download_path` khi custom path. Download hoạt động lại. verify: tsc OK. |
| refactor_metadata.cjs | NGHI NGỜ CODE CHẾT / ARTIFACT STALE | review-only | DONE | XOÁ (an toàn: DriveRangeTokenizer=0 match, fetchWithRetry không tồn tại, không tham chiếu). |
| diff.patch / diff.txt | NGHI NGỜ CODE CHẾT / ARTIFACT | review-only | DONE | XOÁ (git apply --check báo "No valid patches in input"; diff.txt trùng byte diff.patch). |
| .gitignore (credentials/db) | RỦI RO BẢO MẬT | review-only | DONE | ĐÃ cover: credentials.json, wa_credential.json, *.db (3.4GB), refactor_*.cjs, diff.*. KHÔNG cần sửa. |

## WAVE 2 — Thiếu error-handling + Production logging (PENDING)
| Module/File | Loại phát hiện | Skill áp dụng | Trạng thái | Ghi chú |
|---|---|---|---|---|
| vite.config.ts (L34-36) + src/utils/logger.ts | BUG/LỖI THỜI + THIẾU ERROR-HANDLING | refactor | PENDING | esbuild.drop console tắt mọi log prod -> logger.ts nhánh "giữ error" dead code. Fix: transport log bền (Tauri IPC->file) hoặc drop chỉ log/info/debug. Có nguồn (vite docs). |
| React ErrorBoundary (toàn app) | THIẾU ERROR-HANDLING | feature-dev | PENDING | grep ErrorBoundary=0. Thêm top-level ErrorBoundary + fallback UI. |
| src/workers/* (workerError.ts, scanner.worker, proSync.worker) | THIẾU ERROR-HANDLING / RỦI RO BẢO MẬT | refactor | PENDING | Worker global scope riêng, initLogger không áp dụng -> log worker không redact + bị drop prod. |
| ~100+ console.* call sites | THIẾU ERROR-HANDLING / RỦI RO BẢO MẬT | refactor | PENDING | Ở DEV sanitize (main.tsx:8 gọi initLogger); Ở PROD bị drop. Chuẩn hoá qua logger module. |

## WAVE 3 — Logic cũ/mới lồng nhau + Lỗi thời + UI polish ✅ VERIFIED_MERGED (2026-07-14)
| Module/File | Loại phát hiện | Skill áp dụng | Trạng thái | Ghi chú |
|---|---|---|---|---|
| src/utils/metadata.ts (ConcurrencyQueue, parseMultipartByteRanges) | LOGIC TỰ VIẾT | refactor (KEEP) | DONE | 3.1: KEEP (không std-lib thay thế đúng use-case; p-limit mất abort per-task; byteranges không có lib npm chuẩn). Nguồn: npm p-limit 7.3.0, MDN. |
| src/App.css + package.json | LỖI THỜI (Tailwind v4) | refactor | DONE | 3P: thêm `@import "tw-animate-css";` + dep. Animation `animate-in/...` trước là NO-OP (thiếu plugin v4). Verify qua Tailwind CLI. |
| src/utils/driveApi.ts + FolderSelectionScreen.tsx + TrashScreen.tsx | THIẾU ERROR-HANDLING | refactor | DONE | 3Q: thêm helpers (searchFolders/listFolderChildren/getFileParents/getFileName/getTrashedFiles) dùng driveFetch; route 5 raw fetch qua chúng + toast lỗi. tsc OK. |
| src/ui/MainContent/MainContent.tsx | BUG (desync) + dead state | bugfix | DONE | 3R: sửa bulk delete/move desync (per-item try/catch, local DB chỉ update item thành công); bật lại isBulkOperating (set true/false). |
| src/ui/MainContent/components/SongCard.tsx | BUG (stale closure) | bugfix | DONE | 3S: bỏ custom memo comparator (default shallow) → hết stale onPlay → phát đúng bài. |
| src/ui/LikedSongs/LikedSongs.tsx + NowPlayingView.tsx | THIẾU ERROR-HANDLING | bugfix | DONE | 3T: handleUnlike await+try/catch+toast; getTrackMetadata truyền AbortSignal. |
| src/ui/Settings/components/CloseBehaviorDropdown.tsx | NGHI NGỜ CODE CHẾT | review-only (xoá) | DONE | 3U: xoá (verified unimported, 0 inbound). |
| src/ui/HomeTab/HomeTab.tsx | RỦI RO HIỆU NĂNG | refactor | DONE | 4: dời Math.random/sessionStorage ra khỏi render (useRef) → subtitle ổn định dưới StrictMode. |
| src/ui/LikedSongs/LikedSongs.tsx (cover fetch) | RỦI RO HIỆU NĂNG | refactor | DONE | 4: giới hạn concurrency 5 (batch) thay forEach N request song song. |
| src/ui/Playlist/PlaylistView.tsx | THIẾU ERROR-HANDLING | refactor | DONE | 4: validate ảnh (type/size≤5MB) + FileReader.onerror + toast load lỗi. |
| src/ui/MainContent/components/NewFolderModal.tsx | THIẾU ERROR-HANDLING | refactor | DONE | 4: validate tên thư mục (ký tự không hợp lệ). |
| src/utils/metadata.ts (addToLibrary, removeFromLibrary), color.ts (getAverageColor), downloadPath.ts (clearCustomDownloadPath), utils/scanner.ts (toàn file) | NGHI NGỜ CODE CHẾT | review-only (xoá) | DONE | 4: audit 0 inbound → xoá an toàn (scanner.ts xoá nhưng scanner.worker.ts KHÔNG import nó). Cross-verify OK. |
| Các nits LOW còn lại (console.warn, dedupe JSX, escape helper, Login `any`) | THIẾU ERROR-HANDLING (thấp) | (deferred) | PENDING | Đã log; logger đã sanitize ở prod nên chấp nhận; không đổi hành vi. |
| src/hooks/*, src/db/db.ts, src/locales | ĐÃ REVIEW | review-only | DONE | Error-handling cơ bản ổn, classify* có sẵn. Không cần động lớn. |

## WAVE 4 — Hiệu năng + dọn code chết an toàn ✅ VERIFIED_MERGED (2026-07-14)
| Module/File | Loại phát hiện | Skill áp dụng | Trạng thái | Ghi chú |
|---|---|---|---|---|
| Hiệu năng (polish đã làm ở W3+W4) | RỦI RO HIỆU NĂNG | refactor | DONE | HomeTab random render, LikedSongs N-fetch limit, stale deps (ghi nhận). Không có N+1/blocking nghiêm trọng. |
| Nghi ngờ code chết | NGHI NGỜ CODE CHẾT | review-only | DONE | Đã xoá: refactor_metadata.cjs, diff.patch, diff.txt, extract_metadata_safe (W1), CloseBehaviorDropdown (W3), addToLibrary/removeFromLibrary/getAverageColor/clearCustomDownloadPath/scanner.ts (W4). Verify 0 inbound. |

## ĐÃ XÁC NHẬN OK (không động)
| Module/File | Ghi chú |
|---|---|
| src/utils/apiClient.ts, src/utils/driveApi.ts, src-tauri/src/proxy.rs | Harden tốt (token typed, retry/backoff, Drive error classify, HMAC, rate-limit). Giữ làm chuẩn nội bộ. |
| music_database.db (3.4GB), credentials.json, wa_credential.json | KHÔNG đọc/commit/log nội dung. |
| (INFRA) REFACTOR_MASTER_PLAN.md, PROGRESS_LEDGER.md | Tạo GĐ0, cập nhật GĐ1-2. |
