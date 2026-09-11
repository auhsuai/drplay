# MPV Engine Integration (Option B — mpv sidecar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Quy trình chi phối:** AGENTS.md + skill `closed-loop-feature-development` (Main Agent chỉ plan/dispatch/review/verify — CẤM tự viết code sản xuất). Dispatch prompt bắt buộc nằm ở mục "Handoff" cuối file.

**Goal:** Thay toàn bộ cơ chế decode/playback web (`<audio>` + service worker proxy) bằng mpv sidecar điều khiển qua JSON IPC — gapless thật, buffer kiểm soát được, format coverage đầy đủ — giữ nguyên facade `AudioController` để UI không đổi.

**Architecture:** mpv.exe được bundle làm Tauri sidecar, điều khiển qua JSON IPC trên Windows named pipe (tokio). mpv stream nhạc từ Google Drive qua 1 HTTP proxy local nhỏ (tiny_http, random port) — proxy tự gắn Bearer token từ `token_store`, forward Range, refresh token 1 lần khi 401. Frontend giữ nguyên facade `AudioController` nhưng đổi ruột sang MpvEngine (Tauri commands + events).

**Tech Stack:** Tauri v2 · tokio (named pipe, đã có) · tiny_http 0.12 (đã có, pattern OAuth callback trong `auth.rs`) · reqwest stream (đã có) · serde_json (đã có) · React 19 + TS 5.8 frontend · vitest (~960 tests).

## Global Constraints

- Full cutover: KHÔNG giữ 2 engine song song (Luật AGENTS.md: 1 nguồn sự thật). Web audio bị XOÁ ở Task 4.
- Service worker `/drive-stream/` PHẢI được giữ cho **metadata fetch** (`src/utils/metadata.ts`, `driveRangeTokenizer.ts`, `swByteCache.ts` đều dùng) — chỉ playback audio mới chuyển sang mpv. XOÁ NHẦM SW = phá metadata pipeline.
- Pipe IPC: tên pipe ngẫu nhiên per-session `\\.\pipe\drplay-mpv-{uuid-v4}` (docs chính thức mpv: IPC insecure, có lệnh `run` — không được dùng tên cố định đoán được).
- KHÔNG log token/PII trong proxy và IPC (Luật 4 AGENTS.md).
- KHÔNG đụng dead deps `symphonia`/`lofty` trong feature này (việc riêng, xem mục "Việc ngoài scope").
- KHÔNG dùng `tauri-plugin-mpv` (non: 4 breaking/năm, ~58 downloads/tháng). Tự viết IPC.
- Volume mapping: facade web dùng 0..1 (`AudioController.volume = 1`), mpv dùng 0..100 → engine nhân 100.
- TDD bắt buộc: test FAIL trước (red) → code tối thiểu (green) → refactor. Không đảo ngược.
- Kiểm tra thật trước khi tin số dòng `file:dòng` trong plan này — grep lại code thật (5B.8.7).

---

## 1. CONTEXT — Đã điều tra được gì (đọc để không research lại)

### 1.1 Kiến trúc hiện tại (đã verify bằng chứng)

```
Google Drive ──▶ public/sw.js (SW proxy /drive-stream/{id} → files/{id}?alt=media, forward Range)
             ──▶ 2 element new Audio() (double buffer)
             ──▶ Chromium/WebView2 media engine tự decode
```

- Facade: `src/lib/AudioController.ts` (singleton, 408 dòng). Public API **chốt cứng** (mục 2.1).
- Event map: `src/lib/audioNativeEvents.ts` — `AudioEventMap` = { timeupdate, durationchange, progress, buffering, play, pause, ended, error }. Native wiring tách sẵn thành factory `createNativeEventHandlers()` (pure, test độc lập).
- Tests liên quan facade: `AudioController.test.ts` (~600 dòng, FakeAudio harness), `audioNativeEvents.test.ts`, `usePlayer.test.ts`, `usePlayerSession.test.ts`, `swStreamRetry.test.ts`, `swTokenRetry.test.ts`, `swByteCache.test.ts`, `swPrefetch.test.ts`, `swMime.test.ts`, `swRememberSizes.test.ts`.
- Retry logic web hiện có: stream retry (`&retry=` query param trong streamUrl), SW token 401 recovery (`useServiceWorker.ts`).

### 1.2 Quyết định kiến trúc đã chốt (user confirm 2026-09-11)

| Quyết định | Giá trị | Lý do |
|---|---|---|
| Chiến lược | **Full cutover** | Luật 1 nguồn sự thật; UI giữ nguyên nhờ facade |
| mpv phân phối | **Bundle sidecar** (`externalBin`) | App tự chủ, không bắt user cài mpv; +~60-90MB chấp nhận |
| Transport | **Proxy localhost Rust** | Chuẩn ngành (rclone serve http pattern); Drive auth tập trung; cache/refresh 1 chỗ |
| IPC | **Tự viết JSON IPC (tokio named pipe)** | Plugin Tauri quá non; protocol chính thức đơn giản; tokio đã có |

### 1.3 Research findings (nguồn đầy đủ ở mục 9)

**Auth/transport — chuẩn ngành là local proxy:**
- `rclone serve http` là pattern cộng đồng chuẩn để play nhạc từ cloud storage; project `gdrive-music-player` stream Google Drive qua rclone serve http local.
- ⚠️ **Bẫy redirect**: HTTP clients strip header `Authorization` khi redirect cross-origin. `www.googleapis.com/drive/v3/files/{id}?alt=media` + Bearer thường trả 200 thẳng (không redirect) — nhưng nếu gặp 302 sang `googleusercontent.com` thì phải tự re-apply header (reqwest `redirect(Policy::none)` + follow tay, hoặc verify với curl thật trong Task 2). SW hiện tại playback được chứng tỏ luồng hiện tại ổn — ghi lại response thực tế khi verify.
- mpv auth trực tiếp: `--http-header-fields` (official answer, mpv discussion #15009) — KHÔNG dùng vì đã chọn proxy.

**IPC — JSON IPC là chuẩn cho external process:**
- Chuẩn ngành: app **embed** → libmpv C API (Plex, IINA, mpv.net — Wikipedia); app điều khiển **process ngoài** → JSON IPC (Jellyfin MPV Shim dựng trên python-mpv-jsonipc; occivink/mpv-music-player client-server).
- Protocol (mpv `DOCS/man/ipc.rst`): line-delimited JSON, MỖI message kết thúc `\n`, không được có `\n` trong message. Command: `{"command":["loadfile","URL"],...}` + optional `request_id`. Reply: `{"error":"success","data":...,"request_id":N}`. Events: `{"event":"property-change","id":N,"name":"...","data":...}`. Windows: `--input-ipc-server=\\.\pipe\NAME`, mpv tự tạo pipe, client cần overlapped I/O (tokio `named_pipe` OK). Lệnh extra: `get_property`, `set_property`, `observe_property(id, name)`.
- **Security warning chính thức**: IPC insecure, có lệnh `run` (arbitrary command execution) → local only + tên pipe random + KHÔNG bao giờ expose ra ngoài.

**mpv flags khởi động (audio-only, chốt trong plan):**
```
--no-video --no-terminal --idle=yes
--input-ipc-server=\\.\pipe\drplay-mpv-{uuid}
--gapless-audio=always
--prefetch-playlist=no          (v1: tự quản queue bằng append-play, tránh phức tạp)
--demuxer-readahead-secs=30
--demuxer-max-back-bytes=64MiB  (seek lùi instant trong cửa sổ này)
--demuxer-max-bytes=256MiB
--cache=yes
--force-media-title=no          (khỏi popup)
```
- Buffer observable qua IPC: `demuxer-cache-time`, `demuxer-cache-duration`, `paused-for-cache`, `demuxer-cache-state` → render thanh buffer từ số liệu thật (thay `driveRangeTokenizer`/`swByteCache` phần audio).
- Bit-perfect: `--audio-exclusive=yes` — để OFF mặc định v1, làm setting sau (YAGNI).
- Quirk test Windows: socat/echo chỉ gửi được không đọc reply → test bằng code thật, không tay-fiddle.

**License/size:** mpv GPLv2+ nhưng ship exe riêng qua sidecar = mere aggregation (không lây GPL). libmpv in-process thì dính GPL — tránh. Build Windows khuyến nghị: zhongfly/mpv-winbuild hoặc shinchiro builds (SourceForge) — **subagent phải tra lại nguồn build mới nhất trước khi code (Luật 3)**.

**Ecosystem reference (đọc khi bí):**
- `nini22P/mpv-tauri` + `tauri-plugin-mpv` (source đọc được, MPL-2.0): tham khảo cách spawn/observe trong Tauri, không dùng dependency.
- `occivink/mpv-music-player`: proof gapless + waveform seekbar + output switching qua IPC.
- Tauri sidecar docs: `v2.tauri.app/develop/sidecar` — binary phải tên `mpv-x86_64-pc-windows-msvc.exe`, khai báo `bundle.externalBin`, thêm permission spawn vào `capabilities/default.json`.

### 1.4 Bẫy đã phát hiện trong repo (không được dẫm lại)

1. `rg` KHÔNG có trong PowerShell PATH → dùng grep tool tích hợp hoặc `Select-String`. Gọi `rg` = fail mất vòng.
2. `metadata.ts` + `driveRangeTokenizer` + `swByteCache` dùng `/drive-stream/` cho METADATA → SW không được xoá.
3. `symphonia`/`lofty` trong `Cargo.toml:42-43` là dead deps (không file .rs nào tham chiếu) — đừng nhầm là đang decode native.
4. `buildStreamUrl` tests cho thấy WMA/AIFF chủ động bị strip ext (Chromium không decode) — mpv sẽ mở lại được các format này (không cần làm gì thêm).
5. `tiny_http` đang dùng cho OAuth callback trong `auth.rs` — tham khảo pattern bind port/reuse, đừng đụng luồng callback.
6. FakeAudio harness trong `AudioController.test.ts` mock DOM audio — Task 3 phải viết harness mới cho IPC events (mock `invoke`/`listen` của `@tauri-apps/api`), KHÔNG cố tái dùng FakeAudio DOM.
7. Mọi thay đổi TS phải qua `npx eslint <file>` — husky pre-commit chặn.

---

## 2. INTERFACE CONTRACTS (chốt cứng — đổi contract = REJECT, phải sửa plan trước)

### 2.1 Facade `AudioController` — giữ NGUYÊN public API sau (UI không đổi):

```ts
// src/lib/AudioController.ts — các method bắt buộc giữ nguyên signature:
public static getInstance(): AudioController
public on<K extends keyof AudioEventMap>(event: K, handler: AudioEventHandler<K>): () => void
public async playTrack(track: Track, startTime?: number): Promise<void>
public togglePlay(): void
public pause(): void
public seek(time: number): void
public setVolume(vol: number): void        // 0..1 → mpv volume = vol*100
public toggleMute(): void
public getVolume(): number                 // 0..1
public isMuted(): boolean
public getCurrentTime(): number
public getDuration(): number
public getBuffered(): BufferedSource
public release(): void
// AudioEventMap (audioNativeEvents.ts): timeupdate, durationchange, progress,
//   buffering{isBuffering}, play, pause, ended, error
```

### 2.2 Rust Tauri commands (Task 1 & 2 tạo, Task 3 dùng):

```rust
// Task 1 — mpv module (src-tauri/src/mpv/)
#[tauri::command] async fn mpv_spawn(app: AppHandle) -> Result<(), String>
   // spawn sidecar + connect pipe + observe các property mặc định. Idempotent (đã spawn → Ok).
#[tauri::command] async fn mpv_command(cmd: Vec<String>) -> Result<serde_json::Value, String>
   // ví dụ ["loadfile", url, "replace"], ["seek", "42", "absolute"], ["set_property","volume",75]
#[tauri::command] async fn mpv_get_property(prop: String) -> Result<serde_json::Value, String>
#[tauri::command] async fn mpv_shutdown() -> Result<(), String>
// Events emit ra frontend (app_handle.emit):
//   "mpv-property" → { name: String, data: serde_json::Value }
//   "mpv-event"    → { event: String, reason: Option<String> }   // vd end-file + reason "eof"/"error"

// Task 2 — stream proxy (src-tauri/src/stream_proxy/)
#[tauri::command] async fn stream_proxy_start(app: AppHandle) -> Result<u16, String>
   // bind 127.0.0.1:0 → trả port. Idempotent (đã start → trả port cũ).
   // GET /stream/{fileId} → proxy files/{id}?alt=media với Bearer từ token_store,
   //   forward Range header + trả 206/Content-Range như upstream.
   // 401 → refresh token ĐÚNG 1 lần (reuse logic auth.rs) → retry; 401 lần 2 → 502.
// Event: "stream-proxy-error" → { fileId: String, status: u16 }
```

### 2.3 Frontend wiring (Task 3):

- `MpvAudioController` implements đúng facade 2.1. `playTrack(track)`: lấy port từ `stream_proxy_start` (cache lại) → url = `http://127.0.0.1:{port}/stream/{track.id}` → `mpv_command(["loadfile", url, "replace"])`.
- Map events: `time-pos`→timeupdate · `duration`→durationchange · `pause=false`→play · `pause=true`→pause · `paused-for-cache`→buffering · `demuxer-cache-state`→progress+getBuffered · `end-file(reason=eof)`→ended · `end-file(reason=error)`→error.
- Mute: mpv không có mute riêng → set `volume=0` và nhớ volume cũ (facade behavior: `isMuted()` vẫn đúng).
- `playTrack` khi đang load bài khác (race): mpv `loadfile replace` tự hủy load cũ — KHÔNG cần hàng đợi phức tạp; phải set `getCurrentTime()`=0 ngay khi loadfile thành công.
- Hook vẫn gọi `AudioController.getInstance()` — không đổi import nào ngoài file facade.

---

## 3. TASKS (vertical slice, tuần tự — cùng working tree, 5C.4)

### Task 1: mpv sidecar + JSON IPC client (Rust)

**Files:**
- Create: `src-tauri/src/mpv/mod.rs`, `src-tauri/src/mpv/ipc.rs`, `src-tauri/src/mpv/process.rs`
- Create: `scripts/fetch-mpv.mjs` (download mpv build → `src-tauri/bin/mpv-x86_64-pc-windows-msvc.exe`, gitignore binary, commit script)
- Modify: `src-tauri/Cargo.toml` (không thêm crate mới nếu tokio đủ; uuid đã có v4)
- Modify: `src-tauri/tauri.conf.json` (`bundle.externalBin: ["bin/mpv"]`)
- Modify: `src-tauri/capabilities/default.json` (permission sidecar spawn theo docs v2.tauri.app/develop/sidecar)
- Modify: `src-tauri/src/lib.rs` (register commands + invoke_handler)
- Test: `src-tauri/src/mpv/ipc.rs` (unit test trong file, `#[cfg(test)]`)

**Interfaces:** Consumes: không. Produces: commands 2.2 (mpv_*), events `mpv-property`/`mpv-event`.

- [ ] **Step 1: Tra cứu bắt buộc** — DuckDuckGo/context7: (a) nguồn download mpv Windows build mới nhất đang khuyến nghị, (b) Tauri v2 sidecar exact config (externalBin naming + capability permission), (c) tokio named pipe client pattern (`tokio::net::windows::named_pipe::ClientOptions::open` + poll retry khi pipe chưa tồn tại). Ghi link + ngày vào report.
- [ ] **Step 2: Test FAIL trước — protocol framing** (`ipc.rs` unit test, không cần mpv thật):
  - serialize command → đúng 1 dòng JSON kết thúc `\n`, không `\n` trong message
  - parse reply có `request_id` → match đúng pending request (HashMap<u64, oneshot::Sender>)
  - parse `property-change` event → `(name, data)` đúng
  - dòng rác/không-JSON → bỏ qua không crash
- [ ] **Step 3: Chạy `cargo test -p drplay` trong `src-tauri` → FAIL** (module chưa có).
- [ ] **Step 4: Implement tối thiểu** `ipc.rs` (framing + request map + event stream) → test PASS.
- [ ] **Step 5: Implement** `process.rs`: spawn sidecar với flags mục 1.3, pipe name `\\.\pipe\drplay-mpv-{uuid}`, poll-connect (timeout 5s, backoff 100ms), error handling phân loại: sidecar missing (không tìm thấy exe), spawn fail, pipe connect timeout — mỗi loại 1 message rõ ràng, log qua `log` crate (đã có) KHÔNG log token.
- [ ] **Step 6: Implement** `mod.rs`: 4 Tauri commands mục 2.2 + observe mặc định lúc spawn: `time-pos, duration, pause, paused-for-cache, demuxer-cache-state` + listener `end-file` → emit events. `mpv_spawn` idempotent.
- [ ] **Step 7: `scripts/fetch-mpv.mjs` + tauri.conf externalBin + capabilities** — chạy script thật, xác nhận exe tồn tại, app build được với `npm run tauri build` (hoặc ít nhất `cargo check` pass + conf hợp lệ).
- [ ] **Step 8: Verify thủ công spike** — `cargo run` dev, gọi `mpv_spawn` rồi `mpv_command(["loadfile", "<đường dẫn file wav/flac local bất kỳ>", "replace"])` từ console → NGHE THẤY TIẾNG. Ghi log IPC vào report làm bằng chứng.
- [ ] **Step 9: Commit** `feat(mpv): sidecar + json ipc client`.

### Task 2: Stream proxy (Rust)

**Files:**
- Create: `src-tauri/src/stream_proxy/mod.rs` (+ `server.rs` nếu >400 dòng/file — giới hạn 6f)
- Modify: `src-tauri/src/lib.rs` (register `stream_proxy_start`)
- Test: unit test trong module + fixture server (spawn 1 tiny_http thứ 2 trong test làm upstream giả — không cần mock crate mới)

**Interfaces:** Consumes: `token_store` (đọc token), logic refresh trong `auth.rs` (tái dùng — BẮT BUỘC đọc auth.rs trước, không viết lại refresh). Produces: `stream_proxy_start` + event `stream-proxy-error` (2.2).

- [ ] **Step 1: Đọc `auth.rs` + `token_store.rs` thật** — xác định hàm đọc token + refresh có sẵn. Nếu refresh không tách được hàm → DỪNG báo cáo (không tự sửa ngoài scope).
- [ ] **Step 2: Test FAIL trước:** (a) proxy forward path `/stream/abc` → upstream nhận `GET files/abc?alt=media` + header Bearer; (b) Range header forwarded, 206 + Content-Range passthrough; (c) upstream 401 → gọi refresh đúng 1 lần → retry → 200; (d) 401 lần 2 → trả 502 + emit event; (e) 2 request song song không chết; (f) upstream timeout 15s → 504.
- [ ] **Step 3: Chạy test → FAIL.**
- [ ] **Step 4: Implement tối thiểu** → PASS. Lưu ý: reqwest redirect policy — verify curl thật `www.googleapis.com/drive/v3/files/{id}?alt=media` với Bearer xem có 302 không; nếu có → `Policy::none` + follow tay re-apply Authorization (bẫy mục 1.3).
- [ ] **Step 5: Verify spike thật** — start proxy, `curl -H "Range: bytes=0-1023" http://127.0.0.1:{port}/stream/{fileId-thật}` → nhận 206 + 1024 bytes âm thanh hợp lệ.
- [ ] **Step 6: Commit** `feat(mpv): localhost stream proxy with token refresh`.

### Task 3: Frontend MpvAudioController (TS)

**Files:**
- Create: `src/lib/mpvAudio.ts` (engine + event mapping; tách file nếu >400 dòng)
- Modify: `src/lib/AudioController.ts` (đổi ruột sang mpv, giữ nguyên facade 2.1; tên class giữ `AudioController`)
- Modify: `src/lib/audioNativeEvents.ts` CHỈ nếu cần export type chung — không xoá `createNativeEventHandlers` ở task này (Task 4 mới dọn)
- Test: `src/lib/mpvAudio.test.ts` (viết mới), sửa `AudioController.test.ts` (thay FakeAudio DOM bằng mock `invoke`/`listen`)

**Interfaces:** Consumes: commands 2.2 + `@tauri-apps/api/core` invoke + `event` listen. Produces: facade 2.1 không đổi.

- [ ] **Step 1: Tra cứu context7/DuckDuckGo:** Tauri v2 `invoke` + `listen`/`EventCallback` pattern trong React (cleanup listener khi `release()`).
- [ ] **Step 2: Test FAIL trước** (vitest, mock `@tauri-apps/api`):
  - `playTrack` → đúng 2 invoke: `stream_proxy_start` (cache port, lần 2 không gọi lại) + `mpv_command(["loadfile", "http://127.0.0.1:{port}/stream/{id}", "replace"])`
  - event `mpv-property` name=`time-pos` data=12 → listener `timeupdate` nhận `{position:12}` (đối chiếu payload shape thật trong `audioNativeEvents.ts`)
  - `pause=true` → `pause`; `pause=false` → `play`
  - `paused-for-cache=true/false` → `buffering {isBuffering}` đúng thứ tự
  - `end-file` reason=`eof` → `ended` đúng 1 lần; reason=`error` → `error` + không emit `ended`
  - `setVolume(0.5)` → `mpv_command` chứa volume 50; `toggleMute` → volume 0 + nhớ giá trị cũ, unmute trả đúng
  - `seek(42)` → `["seek","42","absolute"]`
  - `playTrack(track, 120)` → loadfile xong set `seek 120 absolute` (mirror `seekOnLoadedMetadata` hiện tại)
  - `release()` → `mpv_shutdown` invoke + gỡ mọi listener (không leak)
- [ ] **Step 3: Chạy `npx vitest run src/lib/mpvAudio.test.ts` → FAIL.**
- [ ] **Step 4: Implement** `mpvAudio.ts` + đổi ruột `AudioController.ts` → PASS + toàn bộ test cũ liên quan sửa tương ứng PASS.
- [ ] **Step 5: ESLint + tsc** trên file đụng: `npx eslint src/lib/mpvAudio.ts src/lib/AudioController.ts && npx tsc --noEmit`.
- [ ] **Step 6: Verify thật (playwright hoặc tay theo webapp-testing)** — `npm run tauri dev`, play 1 bài từ Drive thật: phát được, seek được, volume/mute đúng, hết bài auto next, buffering spinner không kẹt. Screenshot + console sạch vào report.
- [ ] **Step 7: Commit** `feat(player): swap audio engine to mpv behind AudioController facade`.

### Task 4: Cleanup web audio path + verify tổng

**Files:**
- Modify: `src/lib/audioNativeEvents.ts` (xoá `createNativeEventHandlers` nếu không còn ai dùng — grep inbound trước!)
- Modify/Xoá: `src/lib/AudioController.test.ts` phần test web-audio cũ, `audioNativeEvents.test.ts` tương ứng
- KHÔNG đụng: `public/sw.js`, `metadata.ts`, `driveRangeTokenizer*`, `swByteCache*`, `streamPrefetcher*` (còn phục vụ metadata/prefetch — nếu audit thấy prefetch audio-only chết hẳn → LIỆT KÊ báo cáo, quyết định riêng, không xoá trong task này)
- Test: guard test chống tái xuất hiện (`expect(() => new Audio()).toBeDefined()` không đủ — viết test assert `AudioController` không còn dùng `HTMLAudioElement`: grep-free runtime test là đủ, hoặc xoá test cũ là chính)

- [ ] **Step 1: Inbound check** `createNativeEventHandlers`, `new Audio(`, `streamUrl` dùng chỗ nào — liệt kê file:dòng vào report trước khi xoá.
- [ ] **Step 2: Xoá + sửa test.** Guard: `grep` trong CI không bắt được — dùng 1 vitest assert facade không tham chiếu DOM audio (`expect((AudioController as any) prototype ctor name...)` — thực tế chỉ cần xoá sạch + tsc pass).
- [ ] **Step 3: Full verify (5B.7 tầng 2 — Main Agent tự chạy):** `npx vitest run` toàn bộ + `npm run build` + `npx tsc --noEmit` + `cargo test` + smoke test UI thật.
- [ ] **Step 4: Commit** `chore(player): remove web audio engine after mpv cutover`.

---

## 4. VERIFY PLAN (theo 5B.7 — 2 tầng)

- **Tầng 1 (subagent, mỗi task):** test file liên quan + `npx tsc --noEmit` + eslint file đụng + bằng chứng RED→GREEN (baseline số test + log FAIL cụ thể + log PASS) + spike thật (Task 1: nghe tiếng; Task 2: curl 206; Task 3: play Drive thật).
- **Tầng 2 (Main Agent, sau APPROVE mỗi task):** đọc diff từng file + cross-verify 1-2 claim + `npx tsc --noEmit` đúng 1 lệnh + commit.
- **Full suite + build:** CHỈ 1 lần cuối session sau Task 4 (nếu batch kéo dài quá 6-8 giờ thì 1 lần giữa + 1 lần cuối).

## 5. VIỆC NGOÀI SCOPE (backlog, KHÔNG làm trong feature này)

- Xoá dead deps `symphonia`/`lofty` (Cargo.toml:42-43) — dispatch riêng, giảm compile time.
- Setting hi-fi: `--audio-exclusive=yes` toggle + ReplayGain (`--replaygain=album`).
- Waveform seekbar từ demuxer-cache-state (proof: occivink/mpv-music-player).
- Dọn `streamPrefetcher`/`swByteCache` phần prefetch audio nếu sau cutover thừa hẳn.

## 6. HANDOFF — quy trình cho session sau

1. **Mở đầu:** load `closed-loop-feature-development`; worktree: tree hiện tại sạch trên `main` — tạo branch `feat/mpv-engine` (worktree sẽ làm cargo target mới toanh, chậm; in-place branch là đủ vì chỉ 1 agent chạy tuần tự — ghi lý do nếu reviewer hỏi).
2. **Dispatch prompt:** dùng NGUYÊN VĂN khối "Bạn là subagent thực thi ĐÚNG 1 slice..." trong skill feature (mục 5B.6 AGENTS.md). Kèm: Task tương ứng từ file này + ràng buộc Global Constraints + báo cáo theo Report Format mục 6 của skill.
3. **Codebase-memory:** project tên là `E-drplay` (không phải `drplay`) — đã có ADR chứa dossier điều tra mpv. Mỗi task xong ghi ADR mới (contract nếu có đổi, bẫy mới).
4. **Môi trường:** `rg` không có → dùng grep tool. Vitest qua `npx vitest run <file>`. Rust test: `cargo test` trong `E:\drplay\src-tauri`. User repo có pre-commit husky (eslint + prettier).
5. **Review:** checklist feature-specific trong skill; REJECT phải kèm dòng/rule vi phạm + hướng sửa (5C.6). Circuit breaker ≥3 REJECT cùng lỗi → dừng, xem lại plan, báo user (Luật 7).
6. **Nếu User không online để xác nhận spike nghe tiếng:** Task 1 Step 8 được thay bằng bằng chứng IPC log (property-change nhận được + loadfile error:success) — không được bỏ verify hoàn toàn.

## 7. Self-review checklist (Main Agent chạy trước khi coi plan xong)

- [ ] Task 3 Step 2 payload shape đối chiếu `AudioEventMap` thật (position/duration field names) — đọc `audioNativeEvents.ts` trước khi viết test.
- [ ] Task 2 refresh-once: tìm trong `auth.rs` xem đã có hàm retry-with-refresh nào để tái dùng chưa (SW có logic tương tự ở `useServiceWorker.ts:161` — tham khảo behavior, không share code TS/Rust).
- [ ] Đổi contract bất kỳ → cập nhật mục 2 + codebase-memory ADR trước khi dispatch.

## 9. Nguồn (đã tra 2026-09-11)

- mpv IPC protocol chính thức: github.com/mpv-player/mpv/blob/master/DOCS/man/ipc.rst
- mpv auth header discussion: github.com/mpv-player/mpv/discussions/15009
- mpv reconnect flags: gist.github.com/steinxborg/0e452ce1481699926c3414c773a0dd19
- Tauri sidecar: v2.tauri.app/develop/sidecar
- tauri-plugin-mpv (tham khảo, không dùng): github.com/nini22P/tauri-plugin-mpv + lib.rs/crates/tauri-plugin-mpv
- Reference app Tauri+mpv: deepwiki.com/nini22P/mpv-tauri
- Music player pattern: github.com/occivink/mpv-music-player · furqanhun.github.io/mpv-music
- rclone serve http pattern: rclone.org/commands/rclone_serve_http · github.com/Venkatesh-6921/gdrive-music-player
- python-mpv-jsonipc (Jellyfin MPV Shim foundation): github.com/iwalton3/python-mpv-jsonipc
- mpv Wikipedia (libmpv vs embed): en.wikipedia.org/wiki/Mpv_(media_player)
- Dossier codebase-memory: project `E-drplay` (ADR decode-mechanism + research-mpv 2026-09-11)
