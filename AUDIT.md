# AUDIT.md — drplay (branch `refactor/cover-image-and-tags`)

**Ngày audit:** 2026-07-22
**Phạm vi:** Bước 1 (Audit codebase) + Bước 2 (Research best practice 2025-2026), theo quy trình 5 bước đã thống nhất.
**Phương pháp:** Mọi claim trong tài liệu này đều được verify trực tiếp trên code thật (đọc file, grep, trace biến) hoặc trích nguồn web cụ thể — không đoán mò. Những chỗ chưa verify được 100% sẽ ghi rõ "chưa xác nhận".

---

## 0. Ghi chú quan trọng — đọc trước khi review phần còn lại

1. **`README.md` hiện đang lỗi thời**, không phản ánh code thật:
   - Nhắc `src-tauri/src/thumbnail.rs`, `src/workers/scanner.worker.ts`, package `music-metadata` — **cả ba đều không còn tồn tại**. Đã bị xóa trong loạt commit `refactor: remove R2 cover-art + SQLite tag-database pipeline` và các commit "restore DB-only tag lookup" sau đó.
   - README vẫn đúng ở phần "không thu thập dữ liệu", "chạy local", CSP — chỉ riêng phần "Cover & metadata" và "Library sync" (nhắc `scanner.worker.ts`) là sai.
   - → Đề xuất cập nhật README ở Bước 4 (rủi ro thấp, chỉ là docs).

2. **Ý nghĩa thật của nhánh `refactor/cover-image-and-tags`** (đã verify qua git log + code, không phải suy đoán):
   - "tags" = khôi phục tag-lookup cục bộ (SQLite `music_database.db`, đọc qua `get_local_metadata_batch`) để hiển thị title/artist/duration thật ở danh sách **My Drive** — đúng như memory đã ghi.
   - "cover-image" = tính năng **mới, độc lập**: người dùng tự upload + crop ảnh cover cho **Playlist** (`ImageCropperModal.tsx` + `react-easy-crop`), lưu local. **Không liên quan** đến pipeline auto cover-art từ ID3 tag + Cloudflare R2 đã bị gỡ bỏ có chủ đích trước đó.
   - Kết luận: memory cũ "drplay không có cover-art pipeline" **vẫn đúng**, không có mâu thuẫn.

3. **Codebase đã qua nhiều vòng audit-fix nghiêm ngặt trước đó** (thấy rõ qua các comment giải thích lý do, trích nguồn MDN/AWS, và message commit rất chi tiết). Audit này **không lặp lại** những gì đã được xác nhận tốt — mục 7 liệt kê rõ để tránh đề xuất "sửa" nhầm những phần đã đúng.

4. **9 sub-agent** đã được dùng để audit code (3 agent, đọc toàn bộ file không phải excerpt) và research best practice (6 agent, dùng Exa search/research). Mọi finding "bug thật" hoặc claim quan trọng đã được tôi tự verify lại trực tiếp bằng Read/Grep trước khi đưa vào đây — không tin mù kết quả sub-agent.

---

## 1. Inventory — Rust Backend (`src-tauri/`)

| File | Chức năng | Dependency/API chính | Pattern |
|---|---|---|---|
| `build.rs` | Tauri build hook | `tauri-build` | Boilerplate |
| `src/main.rs` | Entry point, ẩn console Windows release | `tauri_app_lib::run` | — |
| `src/lib.rs` | Wire toàn bộ app: plugin, tray, invoke_handler, global state | `tauri::Builder`, `LazyLock`/`OnceLock`/`Atomic*` | Global static state cho giá trị dùng chung Tauri+Axum |
| `src/protocol.rs` | Custom scheme `drplay://`, ký lại HMAC, redirect sang proxy port | `hmac`, `sha2`, `url` | Constant-time HMAC compare |
| `src/commands/auth.rs` | OAuth2 login (PKCE) + refresh token | `oauth2` v4.4.2, `tiny_http`, `open` | Loopback redirect + spawn_blocking |
| `src/commands/metadata.rs` | `get_local_metadata_batch` — tra cứu SQLite local theo size+filename | `rusqlite`, `r2d2` | Semaphore-bounded batch lookup |
| `src/commands/misc.rs` | URL builder, buffer config, token mgmt, tray pref | `hmac`/`sha2` | — |
| `src/proxy/mod.rs` | Bootstrap Axum server (`/stream`), global backoff/prefetch state | `axum`, `reqwest` | Axum `State` riêng, không dùng `tauri::State` |
| `src/proxy/stream.rs` | Handler chính: verify HMAC → cooldown → probe size → cache → stream slice → prefetch nền | `axum`, `tokio::sync::{mpsc,watch,Semaphore,Notify}` | Fully async, HMAC constant-time, per-track cancel |
| `src/proxy/backoff.rs` | Full/Equal jitter backoff | `rand 0.8` | Có trích nguồn AWS blog |
| `src/proxy/cache.rs` | Cache metadata track (size+content-type) bounded | `moka::future::Cache` | TinyLFU+LRU, idle TTL |
| `src/proxy/drive_error.rs` | Phân loại lỗi Drive (403/404/429...) | `serde_json` | Reason-first, status fallback |
| `src/proxy/range.rs` | Parse HTTP `Range` (RFC 7233) | — | Pure function, có test suffix-range |
| `src/proxy/content_type.rs` | Map extension → MIME (fix WebView2 octet-stream) | — | Pure function |
| `src/proxy/constants.rs`, `types.rs` | Hằng số, kiểu dữ liệu dùng chung | — | — |
| `src/slice_cache.rs` | Cache slice audio 512KB, dedup request đang chạy | `moka`, `tokio::sync::{Notify,RwLock}` | `InflightGuard` chống leak/race qua `Arc::ptr_eq` |
| `tests/eviction_stall.rs` | Stress test regression moka-rs/moka#590 | — | `#[ignore]` 30s test |
| `src-tauri/capabilities/default.json` | Permission Tauri v2 (KHÔNG phải allowlist v1) | — | Scope rất chặt (domain/path cụ thể) |

## 2. Inventory — React Frontend (`src/`)

**Logic layer** (đầy đủ ở phụ lục sub-agent, tóm tắt các nhóm chính):
- **Auth/token**: `hooks/useAuth.ts`, `utils/apiClient.ts` — PKCE login, proactive refresh, revoke on logout. **Lưu token qua `localStorage`** (xem mục 6).
- **Data/cache**: `db/db.ts` (Dexie/IndexedDB, schema versioned), `utils/driveApi/*` (fetch wrapper + backoff/jitter + Retry-After), `workers/proSync.worker.ts` (background sync toàn bộ/delta qua Drive Changes API).
- **Playback**: `hooks/usePlayer.ts` (queue/shuffle/session restore), `ui/PlayerBar/*` (9 hook con: audio engine, error recovery, progress UI viết DOM trực tiếp để tránh re-render, keyboard, MediaSession API).
- **Prefetch**: `utils/streamPrefetcher.ts`, `utils/nextTrackPrefetcher.ts` — LRU in-memory, concurrency-limited.
- **UI**: `ui/MainContent` (virtualized list + 6 hook con), `ui/HomeTab`, `ui/LikedSongs`, `ui/Playlist` (có `ImageCropperModal`), `ui/Settings`, `ui/Sidebar`, `ui/components/MoreMenu/*`.

**Không có** state library toàn cục (Redux/Zustand/Jotai) — dùng Context+`useReducer`+hook. **Không có** TanStack Query — fetch tự viết tay, Dexie đóng vai trò cache bền.

---

## 3. Bug đã xác nhận thật (ưu tiên xem xét ở Bước 3/4)

Các mục này **đã được tôi trực tiếp verify bằng code** (không chỉ dựa vào sub-agent):

### 3.1 — Prefetch bài kế tiếp dùng sai queue khi ở shuffle mode
`src/hooks/usePlayer.ts:264-266` tính `shuffled` (thứ tự đã xáo trộn) và gán vào `playbackQueue`, nhưng dòng `335` và `365` gọi `maybePrefetchNextTrack(contextQueue, targetTrack)` — dùng `contextQueue` (queue **gốc chưa xáo**), không dùng biến `shuffled` vừa tính. Kết quả: ở shuffle mode, app prefetch nhầm track (theo thứ tự chưa xáo) trong khi track thật sự phát tiếp theo (theo `playbackQueue` đã xáo) không được làm nóng cache trước. Không gây lỗi phát nhạc (việc chọn next track vẫn đúng, chỉ mất lợi ích prefetch), nhưng là bug logic thật, phạm vi sửa rất hẹp (đổi `contextQueue` → `shuffled` tại 2 điểm gọi trong nhánh shuffle).

### 3.2 — Event `drive-quota-exceeded` không bao giờ được Rust emit
Grep toàn bộ `src-tauri/src/**/*.rs` cho `.emit(` chỉ thấy 3 event: `token-expired`, `buffer-status` (x2). **Không có** `drive-quota-exceeded`. Nhưng frontend lắng nghe event này ở **2 nơi độc lập**: `src/App.tsx:86` (hiện `RateLimitModal`) và `src/ui/PlayerBar/usePlaybackControl.ts:208` (hiện toast lỗi). Lỗi quota thật (`DriveErr::DownloadQuota`) được Rust trả qua **HTTP header** `X-Stream-Error-Type: download-quota` trên response `/stream`, đọc bởi `useAudioErrorRecovery.ts` qua HEAD-probe — một cơ chế hoàn toàn khác. Kết luận: 2 UI phản hồi quota-exceeded (modal + toast) hiện **không thể kích hoạt được** trong code hiện tại. Cần quyết định: thêm `app.emit("drive-quota-exceeded", ())` ở phía Rust khi phát hiện `DriveErr::DownloadQuota`, hay bỏ 2 listener chết này.

### 3.3 — GET `/stream` luôn trả `206 Partial Content`, kể cả khi không có header `Range`
`src-tauri/src/proxy/stream.rs:574` — nhánh GET luôn set `StatusCode::PARTIAL_CONTENT`. Trong khi nhánh HEAD (dòng 261) xử lý đúng: `if range_str.is_some() { PARTIAL_CONTENT } else { OK }`. RFC 9110 §14.2 yêu cầu `200 OK` cho response đầy đủ (không có Range). WebView2 luôn gửi `Range` khi phát media nên chưa gây lỗi thực tế, nhưng sai spec — có thể gây nhầm cho client không phải WebView2 (curl, test tool).

### 3.4 — `clear_local_cache` (Rust) và `clearAppCache()` (JS) đều là no-op, nhưng UI Settings có nút "Clear Cache" ngụ ý có tác dụng
`src-tauri/src/commands/misc.rs:70-72`: `pub async fn clear_local_cache(_app: tauri::AppHandle) -> Result<(), String> { Ok(()) }`. `src/utils/cache.ts` gọi `invoke("clear_local_cache")` và bản thân comment trong file đã tự nhận đây không giải phóng bộ nhớ thật. Người dùng bấm "Clear Cache" trong Settings nhưng không có gì được xóa thật.

---

## 4. SAFE-FIX — phạm vi hẹp, rủi ro thấp, có thể làm trực tiếp ở Bước 4

*(Chưa làm gì — chỉ liệt kê theo yêu cầu dừng lại sau Bước 1+2)*

- **Rust**: hằng số trùng lặp không đồng bộ — `TRACK_CACHE_MAX_ENTRIES` (`proxy/cache.rs:25` và lặp lại trong test ở `proxy/mod.rs:81`), `DB_POOL_MAX_SIZE` (`lib.rs:45` và `commands/metadata.rs:24`). Nên export 1 nguồn duy nhất.
- **Rust**: GET `/stream` trả sai status khi thiếu Range (mục 3.3) — sửa theo đúng nhánh HEAD đã làm.
- **Rust**: so sánh `status != 206` bằng literal số thay vì `StatusCode::PARTIAL_CONTENT` (`stream.rs:54,107`) — nhất quán hoá.
- **Rust**: `trim_cached_slice` (`proxy/content_type.rs:31-38`) thiếu nhánh `else { chunk.clear(); }` khi `skip == chunk.len()` — edge case hiếm nhưng nên vá.
- **React**: `document.execCommand("copy")` đã deprecated (`utils/copyToClipboard.ts:24`) → dùng `navigator.clipboard.writeText`.
- **React**: export chết `cachePrefetchedStream` (`utils/streamPrefetcher.ts:41`) — không ai gọi, nên xóa.
- **React**: `handleLocateFile` nhận `e: any` thay vì `CustomEvent<...>` đúng kiểu (`hooks/useLocateFile.ts:26`).
- **React**: `Intl.Collator` tạo mới mỗi lần gọi `sortDriveItems` — nên singleton module-level.
- **React**: nhánh chết `"Settings page coming soon..."` trong `MainContent.tsx:136-137` — không bao giờ render tới nhưng vẫn tồn tại trong code.
- **React**: bug 3.1 (shuffle prefetch) — sửa 2 dòng, thay `contextQueue` bằng `shuffled` tại điểm gọi trong nhánh shuffle.
- **Docs**: cập nhật `README.md` — xóa tham chiếu `thumbnail.rs`, `scanner.worker.ts`, `music-metadata` đã không còn tồn tại.

---

## 5. CONCERN — cần bạn quyết định trước khi làm (kiến trúc / bảo mật / UX)

### 5.1 Bảo mật (ưu tiên cao nhất theo yêu cầu của bạn)

| # | Vấn đề | Hiện trạng | Đề xuất (chờ quyết định) | Mức xáo trộn |
|---|---|---|---|---|
| S1 | **Access + refresh token lưu plaintext trong `localStorage`** (`useAuth.ts`, `apiClient.ts`) | Xác nhận trực tiếp qua code | Chuyển sang OS keychain qua crate `keyring` (Windows Credential Manager/macOS Keychain/Linux Secret Service), thêm 3 Tauri command `store_token`/`get_token`/`clear_token`; access token ngắn hạn có thể giữ in-memory thay vì keychain để tránh IPC round-trip mỗi lần check | Trung bình — ước ~0.5 ngày, đổi `useAuth.ts`+`apiClient.ts`+3 command Rust mới |
| S2 | CSP `script-src 'self' 'unsafe-inline'` — làm yếu chống XSS; CSP hiện là **string dạng flat**, khiến Tauri không tự chèn được nonce | Xác nhận qua `tauri.conf.json` | Chuyển CSP sang **dạng object có cấu trúc** (per-directive) để Tauri tự chèn nonce/hash, sau đó bỏ `'unsafe-inline'` khỏi `script-src`. `style-src 'unsafe-inline'` thì **giữ nguyên** — chấp nhận được với Tailwind, không phải vector đánh cắp token | Thấp — chỉ đổi 1 file config |
| S3 | `oauth2` crate pin ở v4.4.2 — không có advisory RUSTSEC chính thức (đã tra và loại trừ RUSTSEC-2024-0014, đó là của crate khác), nhưng v5 docs cảnh báo rõ nguy cơ SSRF do helper `http_client`/`async_http_client` mặc định follow redirect không giới hạn | Xác nhận qua research (Compass), cross-check version trong `Cargo.lock` | Nâng cấp `oauth2` v4→v5 (API đổi: constructor, trait-based HTTP client, `reqwest` 0.11→0.12) | Trung bình-cao — đụng mọi call site auth |
| S4 | `client_secret` nhúng cứng vào binary qua `include_str!` | Đây là **đúng chuẩn Google** cho loại credential "Desktop app" — Google tự xác nhận loại này "không giữ được secret", PKCE mới là lớp bảo vệ thật | **Không cần đổi** — giữ nguyên, chỉ là ghi chú để không ai nhầm tưởng đây là lỗi | Không áp dụng |

### 5.2 Kiến trúc Rust/Tauri

- **State toàn cục (`static`+`LazyLock`/`Atomic`) dùng để chia sẻ giữa Tauri command layer và Axum server nhúng chung process** — research xác nhận đây là hạn chế thật (không có bridge chính thức giữa `tauri::State` và Axum `State`), pattern hiện tại "acceptable nhưng có thể cải thiện": có thể chuyển các giá trị *mutable* (buffer size, slice cache, minimize-to-tray flag) sang 1 `Arc<T>` duy nhất inject vào cả 2 hệ thống, còn giá trị *write-once* (token, port) giữ static là ổn.
- **`Result<T, String>` cho mọi Tauri command** — chấp nhận được cho prototype, nhưng 2025-2026 khuyến nghị dùng `thiserror` enum + `#[serde(tag="kind")]` để frontend switch theo loại lỗi. Migration incremental, không breaking.
- **Không có `tracing`/`log`, chỉ `eprintln!`** — nên thêm `tauri-plugin-log` (đơn giản) hoặc `tauri-plugin-tracing` (mạnh hơn, có Webview layer để forward log ra devtools).
- **`slice_cache.rs`'s `InflightEntry`/`InflightGuard` tự viết tay để dedup request đang chạy** — research phát hiện **moka's `get_with`/`try_get_with` đã có sẵn single-flight semantics y hệt**, được document rõ ràng, đã test kỹ trong chính moka. Đây là cơ hội đơn giản hóa code có giá trị cao: có thể xóa hẳn `InflightEntry`+`InflightGuard`+`HashMap` custom, giữ nguyên `moka::Cache` + semaphore prefetch. **Cần cẩn trọng vì đây là code lõi streaming** — nên làm ở milestone riêng có test kỹ trước/sau.

### 5.3 Dữ liệu/Schema & tính năng chưa hoàn thiện

- `folderFetchGuard.ts` — code chết, không ai gọi (`fetchFolderContents` có param `_guard?` không truyền ở đâu). Quyết định: xóa hẳn, hay wire vào để chống race khi user chuyển folder nhanh?
- `db.metadataCache` table (Dexie) tồn tại trong schema nhưng không ai viết vào — comment "for future ID3 tag caching". Quyết định: xóa khỏi schema, hay đây là chỗ đặt cho việc tương lai?
- `handleManualResume` (PlayerBar) — logic đầy đủ, state `manualResume` được reducer set khi `NotAllowedError` (autoplay bị chặn), nhưng **không tìm thấy UI nào gọi `handleManualResume`** — có thể là feature "Tap to resume" chưa hoàn thiện.
- `toastDismissRef` trong `usePlaybackControl.ts:413` luôn là object `{ current: null }` mới — không được nối với `toastDismissRef` thật trong `useErrorDisplay` — trông như phần khung sườn chưa nối hết.
- Sự kiện `drive-quota-exceeded` (mục 3.2) — cần quyết định hướng xử lý.
- `useDownload.ts` tải file bằng `fetch` + buffer nguyên file vào memory renderer trước khi tạo `Blob` — với FLAC lossless lớn có thể tốn RAM đáng kể. Có nên chuyển sang command Rust streaming-to-disk?

### 5.4 Frontend state/data — kết luận nghiên cứu (không cần đổi trừ khi có nhu cầu cụ thể)

- **Player state (reducer+hook+ref)**: research kết luận **phù hợp, không cần Zustand/Jotai** — vì `PlayerBar` là leaf component, không ai khác subscribe state của nó. Chỉ đáng đổi nếu tương lai có tính năng như mini-player/Now-Playing overlay ở nơi khác cần đọc state này.
- **TanStack Query**: research kết luận **không nên thêm** — Dexie đã đóng vai trò nguồn sự thật bền (source of truth), thêm TanStack Query sẽ tạo 2 lớp cache song song, dư thừa. Chỉ đáng xem lại nếu vấn đề thực tế là request trùng lặp khi nhiều component cùng fetch 1 folder.
- **Crossfade/gapless**: `<audio>` 2 element hiện tại **không đảm bảo crossfade chính xác** trên đa nền WebView2/WebKitGTK/WKWebView. Nếu crossfade là ưu tiên thật, hướng đúng là Web Audio API (`AudioContext`+`GainNode`); nếu cần gapless tuyệt đối (sample-accurate), tiền lệ thực tế (dự án Musicat) cho thấy cuối cùng phải chuyển sang decode native Rust (Symphonia+cpal) — đây là quyết định lớn, chỉ nên làm nếu người dùng thật sự phàn nàn về chất lượng crossfade hiện tại.
- **`@tanstack/react-virtual` v3.14.5**: đang là bản mới nhất (chưa có v4). Các bug WebView2 trong lịch sử git khớp với nguyên nhân đã biết của thư viện (React concurrent rendering đo kích thước trước khi mount) — các fix đã áp dụng (bỏ `React.memo`, anchor `top:0`, reset size cache) đúng hướng khuyến nghị chính thức. Có tuỳ chọn mới `directDomUpdates` (v3.14.0) đáng thử nếu còn giật khi cuộn.

### 5.5 Build & Release

- **CI hiện tại chỉ build Windows**, trigger trên mọi push `main`, không cache (npm/cargo), không dùng `tauri-apps/tauri-action`, không sign — trong khi README nói hỗ trợ đa nền tảng. Đây là gap thật giữa README và CI.
- **Chưa có code signing**: Windows nên dùng Azure Artifact Signing (EV token vật lý không còn thực tế cho CI); macOS cần Apple Developer Program ($99/năm) + notarization — đây là **quyết định có chi phí thật**, cần bạn approve trước.
- **`tauri-plugin-updater` chưa cấu hình** — biến `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` đã có placeholder rỗng trong workflow nhưng chưa có key thật, chưa có `plugins.updater` trong `tauri.conf.json`. Thứ tự khuyến nghị: updater trước (hoạt động ngay trên Windows/Linux) → ký Windows → build+notarize macOS (updater tự hoạt động trên macOS sau khi có notarization).
- Chỉ build `msi`, có thể thêm `nsis` (exe installer) song song, chi phí thấp.

---

## 6. Đã làm tốt — KHÔNG đề xuất sửa

- **PKCE + CSRF state check** đúng chuẩn trong OAuth flow (`auth.rs`).
- **Local loopback redirect (`tiny_http`, `127.0.0.1`, random port)** — đúng khuyến nghị hiện hành của Google và RFC 8252 cho desktop app, tốt hơn custom URI scheme.
- **Tauri v2 capabilities/permissions** (`capabilities/default.json`) — đã ở v2 thật, scope rất chặt theo domain/path cụ thể. Không phải bài toán migrate v1→v2.
- **Constant-time HMAC compare** (`stream.rs`, `protocol.rs`) — tránh timing side-channel.
- **`moka` pin vào git commit cụ thể** kèm comment giải thích rõ (fix LRU eviction stall chưa release) — quyết định có chủ đích, có test riêng xác nhận (`tests/eviction_stall.rs`).
- **Backoff full-jitter/equal-jitter + cooldown ladder** cho Google Drive rate limit — khớp chính xác khuyến nghị AWS.
- **HTTP Range request cho streaming** (progressive download) — đúng cách Google Drive API khuyến nghị cho file media lớn; HLS/DASH sẽ là over-engineering cho use case 1-user-1-file này.
- **Semaphore giới hạn prefetch nền (4 concurrent) + cancel theo track** — tránh flood Drive API khi virtual-scroll render nhiều item.
- **`InflightGuard` với `Arc::ptr_eq`** chống race khi entry cũ bị dọn nhầm — đúng, dù nay có thể thay bằng `moka::get_with` (mục 5.2).
- **`tokio` feature set đã narrow có chủ đích** (không dùng `full`), đúng khuyến nghị hiện hành.
- **`@tanstack/react-virtual` fix WebView2** (bỏ `React.memo`, anchor `top:0`, reset size cache khi đổi trang) — đúng hướng khuyến nghị chính thức của thư viện.
- **`useTagLookup.ts`** — dùng ref + forced re-render thay vì state, tránh re-render 50 item mỗi lần resolve tag — pattern đúng.
- **`useBulkOperations.ts`/`TrashScreen.tsx`** — dùng sequential loop / `Promise.allSettled` có chủ đích cho batch destructive operation, tracking thành công/thất bại riêng.
- **`logger.ts`** — sanitize token/file-id khỏi log, reset `lastIndex` regex global đúng cách.
- **Toàn bộ network call đã có timeout** (`AbortSignal.timeout`) — đã được một vòng audit trước đó bổ sung, có trích nguồn MDN.

---

## 7. Nghiên cứu best practice 2025-2026 (Bước 2) — 7 hạng mục

> Mỗi mục: hiện trạng dự án → verdict → nguồn chính. Chi tiết đầy đủ (nhiều câu hỏi con hơn, trích dẫn URL) đã được 6 agent research tổng hợp; đây là bản rút gọn cho việc review.

### 7.1 Tauri v2 + Rust async
- State sharing Tauri+Axum: **acceptable, có thể cải thiện** → dùng `Arc<T>` chung thay static rời rạc cho giá trị mutable. [v2.tauri.app/develop/state-management]
- `Result<String>` error: **acceptable, có thể cải thiện** → `thiserror` + `#[serde(tag="kind")]`. [codegiz.com/blog/vrpokkp8]
- Logging: **lỗi thời, nên đổi** → `tauri-plugin-log` hoặc `tauri-plugin-tracing`. [v2.tauri.app/plugin/logging]
- Capabilities system: **đã đúng chuẩn**, không cần đổi. [v2.tauri.app/security/capabilities]
- Tokio narrowed features: **đã đúng chuẩn**. [tokio feature-flags guide]

### 7.2 Google Drive OAuth2 + API
- Desktop app + client_secret + PKCE: **đã đúng chuẩn Google**. [developers.google.com/identity/protocols/oauth2/native-app]
- Loopback redirect: **đã đúng chuẩn** (Google + RFC 8252). 
- `oauth2` v4.4.2 helper mặc định follow redirect (rủi ro SSRF khi exchange code/token): **lỗi thời, nên nâng cấp v5** — không có advisory RUSTSEC chính thức riêng (đã tra và loại trừ), nhưng chính docs v5 cảnh báo rõ. [docs.rs/oauth2, github.com/ramosbugs/oauth2-rs/UPGRADE.md]
- Backoff/jitter: **đã đúng chuẩn AWS**. Range request cho Drive: **đã đúng chuẩn Google**. [aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter, developers.google.com/workspace/drive/api/guides/manage-downloads]

### 7.3 Audio streaming + cache
- Progressive HTTP Range (không HLS/DASH): **đã đúng chuẩn** cho use case 1-user. 
- `moka` vẫn là lựa chọn hàng đầu 2025-2026 cho cache async có eviction (TinyLFU) — **đã đúng chuẩn**.
- `rusqlite`+`r2d2` cho tra cứu metadata read-only: **ổn, không cần đổi** — SQLite vẫn hợp lý hơn sled/redb cho dữ liệu có cấu trúc quan hệ; nếu muốn hiện đại hóa async có thể xét `deadpool-sqlite` (rủi ro thấp, không gấp).
- **Phát hiện giá trị cao**: `moka::get_with`/`try_get_with` đã có sẵn single-flight — có thể thay hoàn toàn `InflightEntry`/`InflightGuard` tự viết tay (mục 5.2). [docs.rs/moka]
- Cache đĩa bền (ngoài in-memory) cho lần nghe lại sau khi restart app: có giá trị thật nhưng không gấp — có thể làm bằng `lru` crate + file theo track/offset.

### 7.4 React frontend
- Player state (reducer+hook+ref): **phù hợp với quy mô hiện tại**, không cần Zustand/Jotai trừ khi có component ngoài PlayerBar cần đọc state này. Có lưu ý: React 19 `useContext` có regression re-render (issue #33498) — chỉ liên quan nếu dùng Context rộng, hiện tại project ít bị ảnh hưởng.
- TanStack Query trên Dexie: **không nên thêm** — dư thừa, Dexie đã là nguồn sự thật.
- Crossfade/gapless: **cần Web Audio API nếu muốn crossfade chính xác** — `<audio>` 2 element hiện tại không đảm bảo timing chính xác đa nền.
- `@tanstack/react-virtual` v3.14.5: **đã là bản mới nhất**, bug WebView2 lịch sử đã fix đúng hướng khuyến nghị.
- React Compiler 1.0 (stable 10/2025): đáng bật — tự động memoize, giảm nhu cầu `React.memo` thủ công (liên quan trực tiếp tới lịch sử bug virtualization).

### 7.5 Bảo mật — lưu credential
- localStorage cho token: **lỗi thời, nên đổi** sang `keyring` crate (không dùng `tauri-plugin-stronghold` — đã được xác nhận **sắp deprecated** theo maintainer Tauri, tháng 11/2025).
- CSP `script-src 'unsafe-inline'`: **nên bỏ**, nhưng phải chuyển CSP sang dạng object có cấu trúc trước (mới cho phép Tauri tự chèn nonce).
- CSP `style-src 'unsafe-inline'`: **giữ nguyên, ổn với Tailwind**.

### 7.6 Build/Release
- CI hiện tại: **lỗi thời, nên đổi** — thiếu cache, chỉ Windows, không dùng `tauri-action`.
- Code signing: **thiếu hoàn toàn** — Windows nên qua Azure Artifact Signing (EV token vật lý không còn thực tế); macOS cần Apple Developer Program (bắt buộc, không có đường miễn phí).
- Updater: **chưa hoạt động** (key rỗng) — nên làm sau khi có ít nhất Windows signing.

---

## 8. Câu hỏi cần bạn quyết định trước khi qua Bước 3 (REFACTOR_PLAN.md)

1. **Bảo mật token (S1)**: đồng ý chuyển sang `keyring` crate không? (Ảnh hưởng: `useAuth.ts`, `apiClient.ts`, +3 Rust command mới)
2. **CSP (S2)**: đồng ý chuyển `tauri.conf.json`'s `csp` từ string sang object có cấu trúc + bỏ `unsafe-inline` khỏi `script-src`?
3. **`oauth2` v4→v5 (S3)**: có muốn nâng cấp ngay (đụng toàn bộ call site auth), hay chấp nhận rủi ro SSRF thấp (chỉ ảnh hưởng lúc exchange code, không phải hot path) và để sau?
4. **Đơn giản hóa cache streaming bằng `moka::get_with`** (mục 5.2): đây là thay đổi code lõi streaming — có muốn làm không, và làm ở milestone riêng có test A/B kỹ trước/sau?
5. **`drive-quota-exceeded` (mục 3.2)**: thêm emit ở Rust, hay bỏ 2 listener chết ở frontend?
6. **`clear_local_cache`/`clearAppCache` (mục 3.4)**: implement thật, hay đổi UI để không ngụ ý có tác dụng?
7. **Build/release**: có muốn đầu tư vào code signing (Windows Azure ~$10-100/tháng, macOS Apple Dev $99/năm) và multi-platform CI ở giai đoạn này, hay để sau vì đây là quyết định có chi phí thật?
8. **Crossfade/Web Audio API**: chất lượng crossfade hiện tại có phải vấn đề thật người dùng gặp, hay chỉ là điểm lý thuyết nên biết?

---

*Hết Bước 1 + Bước 2. Chờ review trước khi viết REFACTOR_PLAN.md (Bước 3).*
