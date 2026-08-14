# DrPlay Android Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đưa DrPlay (Tauri v2 desktop music player, stream Google Drive) chạy được trên Android — APK cài được, đăng nhập được, phát nhạc được (background), UI touch-friendly.

**Scope mobile (điều chỉnh 2026-08-14, user chốt):**
- **KHÔNG có upload** trên mobile — ẩn UploadButton, DropZone, upload folder/file, upload session; chỉ viewer/player
- **KHÔNG fetch metadata + KHÔNG hiện metadata** trên mobile — không ID3 parse (local lẫn network), không cover art, không artist/album hiển thị; danh sách chỉ hiện tên file + thông tin Drive có sẵn (name, size, modifiedTime); player/NowPlaying chỉ hiện tên bài
- **KHÔNG phân trang** trên mobile — mọi danh sách dùng virtual scroll (tanstack đã có); không UX load-more/paging (Drive API pageToken nền vẫn chạy — bất khả kháng do API cap 1000/request — nhưng vô hình với user)

**Architecture:** Giữ nguyên SW proxy cho desktop (QUYẾT ĐỊNH ĐÓNG BĂNG — không refactor đường stream). Android: cùng codebase Tauri v2, native playback qua ExoPlayer-based plugin cho background, OAuth qua system browser + custom scheme redirect (RFC 8252), token qua Android Keystore. Desktop không được vỡ bất cứ lúc nào trong tiến trình — mọi thay đổi phải gate theo platform.

**Tech Stack:** Tauri 2.11.3, React 19, Rust (keyring, reqwest), `tauri-plugin-deep-link`, `tauri-plugin-native-audio` (hoặc fork), Android SDK (minSdk 24, targetSdk 37).

## Global Constraints

- **LUẬT ĐÓNG BĂNG STREAM:** `public/sw.js`, `/drive-stream/` pipeline, `AudioController.ts`, `driveRangeTokenizer.ts`, metadata demuxer — **KHÔNG được sửa hành vi** ở bất kỳ task nào (chỉ được thêm nhánh mobile song song, không đổi code desktop). Vi phạm = REJECT.
- **Desktop không vỡ:** sau mỗi task, `npx tsc --noEmit` + `npx vitest run` (các test file liên quan) + build Windows vẫn xanh.
- **TDD:** code logic mới (không phải config/UI thuần) phải viết test đỏ trước.
- **Scope mobile (xem Goal):** không upload, không metadata display, virtual scroll toàn bộ — mọi task UI phải kiểm tra scope này. Code desktop của các tính năng bị ẩn KHÔNG được xoá (vẫn giữ cho desktop) — chỉ gate hiển thị/active bằng `IS_MOBILE`.
- **cfg-gating chuẩn Tauri v2:** dùng `#[cfg(desktop)]` / `#[cfg(mobile)]` (alias có sẵn) cho Rust; frontend dùng `IS_MOBILE` từ `@tauri-apps/plugin-os` (fallback userAgent regex).
- **Không thay đổi luồng OAuth desktop** (loopback + tiny_http giữ nguyên) — chỉ thêm luồng mobile.
- **Token:** refresh token KHÔNG bao giờ xuất hiện trong log/error (pattern hiện có token_store.rs:34).
- **Nguồn bắt buộc khi gặp API mới:** DuckDuckGo MCP + context7 trước khi code (tauri-plugin-deep-link, tauri-plugin-native-audio, keyring android feature, Media3).
- Môi trường đã xác nhận sẵn sàng: ANDROID_HOME=`C:\Users\thinkpad\AppData\Local\Android\Sdk`, NDK_HOME=`...\ndk\30.0.14904198`, JAVA_HOME=JDK 17, rustup đã có 4 targets android.
- **Worktree cảnh báo:** nhánh `refactor/cover-image-and-tags` (worktree `C:\Users\thinkpad\Desktop\Antigravity\refactor`) đang đụng cover pipeline — task nào chạm `useTrackMetadata`/cover phải kiểm tra nhánh đó đã merge chưa; chưa merge thì KHÔNG chạm.
- Plan thực thi trên nhánh riêng `feature/android-port` (git worktree).

---

## PHASE 0 — Scaffold + GATE: SW có sống trên Android không?

### Task 1: Khởi tạo Android project (tauri android init)

**Files:**
- Create: `src-tauri/gen/android/**` (sinh tự động)
- Modify: `src-tauri/tauri.conf.json` (bundle config android nếu cần), `src-tauri/Cargo.toml` (plugin mobile cần thiết), `src-tauri/capabilities/default.json` (permissions)

**Interfaces:**
- Produces: `src-tauri/gen/android/` (Gradle project), package name `com.drplay.app`, thư mục `src-tauri/gen/android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Tạo nhánh worktree**
```bash
git -C C:\Users\thinkpad\Desktop\Antigravity\drplay worktree add C:\Users\thinkpad\Desktop\Antigravity\drplay-android feature/android-port
cd C:\Users\thinkpad\Desktop\Antigravity\drplay-android
```
Expected: nhánh `feature/android-port` từ HEAD `62f484c`.

- [ ] **Step 2: Chạy android init**
```bash
npm run tauri android init
```
Expected: sinh `src-tauri/gen/android/` (Gradle project, manifest, icons). Nếu hỏi package identifier → `com.drplay.app`.

- [ ] **Step 3: Xác nhận cấu hình android trong tauri.conf.json**
Đọc lại `src-tauri/tauri.conf.json` — nếu có `bundle.android` section, xác nhận `minSdkVersion: 24`. Thêm (nếu chưa có):
```json
"bundle": {
  "android": {
    "minSdkVersion": 24
  }
}
```
(Chỉ sửa nếu thiếu — init tự sinh có thể đã đủ.)

- [ ] **Step 4: Verify — build Android release**
```bash
npm run tauri android build -- --apk
```
Expected: **KHÔNG được chạy lệnh này ở task này nếu compile blocker chưa fix** — thay vào đó chạy `cargo check` cho target android:
```bash
cd src-tauri && cargo check --target aarch64-linux-android 2>&1 | Select-Object -First 40
```
Expected: lỗi compile ở `tray.rs` (`use tauri::menu` / `tauri::tray`) và `lib.rs:155` (`E0061` mobile_entry_point) — **ghi nhận chính xác lỗi này làm baseline** cho Task 3-4. Nếu compile PASS bất ngờ → báo cáo khác biệt, không tự kết luận.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/gen src-tauri/tauri.conf.json && git commit -m "chore(android): scaffold android project (tauri android init)"
```
(Giữ cả gen/android — đây là project source cho Android build.)

**Verify đầy đủ (ghi vào report):** baseline `cargo check --target aarch64-linux-android` — log lỗi cụ thể từng dòng (tray + mobile_entry_point).

---

### Task 2: GATE — Test SW register trên Android device/emulator

> **GATE QUYẾT ĐỊNH:** kết quả task này chọn nhánh thực thi cho Phase 4 (native audio bridge) và mức độ sửa `AudioController`. KHÔNG sửa bất kỳ code stream nào ở task này — chỉ đo.

**Files:**
- Create: (tạm, chỉ để test, sẽ xoá) `src-tauri/gen/android/app/src/main/AndroidManifest.xml` — KHÔNG sửa trong task này
- Đọc: `src/hooks/useServiceWorker.ts`, `public/sw.js`, `src-tauri/gen/android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Kiểm tra emulator/device sẵn có**
```bash
adb devices
avdmanager list avd
```
Expected: ghi danh sách. Nếu không có AVD → tạo 1 AVD (API 34+):
```bash
avdmanager create avd -n drplay-test -k "system-images;android-34;google_apis;x86_64"
```

- [ ] **Step 2: Chạy debug build lên device (compile blocker tạm thời bỏ qua — xem note)**
> NOTE: nếu Task 1 phát hiện compile blocker chặn build → chạy Task 3+4 TRƯỚC rồi quay lại task này (đánh dấu phụ thuộc). Nếu muốn test SW nhanh không cần fix: patch tạm (KHÔNG commit) `#[cfg(desktop)]` cho tray + di chuyển mobile_entry_point, test xong revert — nhưng khuyến nghị: chạy tuần tự 3→4→2 vì fix chỉ mất 30 phút.
```bash
npm run tauri android dev
```

- [ ] **Step 3: Test SW register trên device**
Trong app đã mở, thực thi trên console/JS (qua adb + webview debug — chrome://inspect):
```js
navigator.serviceWorker.register('/sw.js').then(r => console.log('SW OK', r)).catch(e => console.log('SW FAIL', e.message))
```
Expected ghi lại chính xác: `SW OK` hay `SW FAIL` + message. Kiểm tra thêm:
```js
window.isSecureContext
navigator.serviceWorker.controller
```

- [ ] **Step 4: Test phát thử 1 file nhạc** (nếu SW OK): mở app, đăng nhập tạm (OAuth chưa xong → dùng token tay qua console nếu có), bấm play 1 bài — ghi nhận phát được hay SRC_NOT_SUPPORTED.

- [ ] **Step 5: Ghi GATE REPORT vào `docs/superpowers/plans/android-gate-report.md`** (file mới):
```
# GATE: SW trên Android — 2026-08-14
- Tauri version: 2.11.3
- WebView version (adb shell dumpsys webviewupdate | grep Current): <ghi>
- Device/emulator + API level: <ghi>
- isSecureContext: <true/false>
- SW register: <OK/FAIL + message>
- SW controller: <có/không>
- Play thử: <phát được/không + lỗi nếu có>
- Kết luận nhánh: A (SW sống — giữ webview audio, native audio chỉ cho background) | B (SW chết — native audio là đường playback chính, webview im lặng/skip)
```

- [ ] **Step 6: Commit gate report**
```bash
git add docs/superpowers/plans/android-gate-report.md && git commit -m "docs(android): gate report - SW trên Android"
```

**Interfaces (quan trọng — các task sau đọc file này):** mọi task Phase 4+ phải đọc `docs/superpowers/plans/android-gate-report.md` trước khi làm, và ghi rõ trong report của mình nhánh A hay B đang áp dụng.

---

## PHASE 1 — Fix compile blockers (bắt buộc để build Android)

### Task 3: cfg-gate tray theo desktop

**Files:**
- Modify: `src-tauri/src/lib.rs:9,17,186` (`mod tray;`, `use tray::...`, `setup_tray(app)?;`)
- Modify: `src-tauri/src/tray.rs` (toàn file)

**Interfaces:**
- Consumes: không
- Produces: `#[cfg(desktop)]` gate — trên mobile module tray không tồn tại; desktop hành vi giữ NGUYÊN 100%

**Behavior contract (BẢO TOÀN 100% desktop — nếu đổi → báo cáo trước khi làm):**
- Desktop: tray setup chạy y như cũ trong `setup()` (lib.rs:186), `update_minimize_to_tray` command còn nguyên
- Toggle minimize-to-tray trong Settings vẫn hoạt động desktop
- Android: không có tray, command `update_minimize_to_tray` vẫn được đăng ký nhưng trả Ok(()) no-op (tránh frontend catch lỗi — frontend App.tsx:232 đã có .catch nên chấp nhận được; KHÔNG đổi frontend)

- [ ] **Step 1: Viết test đỏ (Rust unit test — nếu module test hiện có cho tray)**
Đọc `src-tauri/src/tray.rs` — nếu có `#[cfg(test)]` block, chạy baseline:
```bash
cd src-tauri && cargo test --no-run
```
Expected: ghi baseline (pass/fail số test). KHÔNG có test tray → ghi N/A.

- [ ] **Step 2: Gate module + imports trong lib.rs**
```rust
// lib.rs
#[cfg(desktop)]
mod tray;
#[cfg(desktop)]
use tray::{setup_tray, update_minimize_to_tray, IS_QUITTING, MINIMIZE_TO_TRAY};
```
Và ở `setup()` (lib.rs:186):
```rust
#[cfg(desktop)]
setup_tray(app)?;
```
Đồng thời: `update_minimize_to_tray`, `IS_QUITTING`, `MINIMIZE_TO_TRAY` được dùng ở `on_window_event` (lib.rs:191-197) — bọc nguyên block CloseRequested-minimize-to-tray trong `#[cfg(desktop)]` (tìm và gate chính xác mọi nơi dùng, grep `MINIMIZE_TO_TRAY|IS_QUITTING|update_minimize_to_tray|setup_tray` trong lib.rs).

- [ ] **Step 3: Gate module contents tray.rs**
```rust
// tray.rs — đầu file
#![cfg(desktop)]
```
(Toàn bộ file chỉ desktop — đặt attribute đầu file là đơn giản nhất, giữ nguyên code bên dưới.)

- [ ] **Step 4: Verify**
```bash
cd src-tauri && cargo check --target aarch64-linux-android
cargo check  # desktop vẫn OK
```
Expected: android check PASS (lỗi tray hết); desktop check PASS.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/lib.rs src-tauri/src/tray.rs && git commit -m "fix(android): cfg-gate tray module for desktop only"
```

**Verify đầy đủ (bắt buộc ghi report):** baseline `cargo check --target aarch64-linux-android` (lỗi từ Task 1) → sau fix PASS + `cargo check` desktop PASS. Cả 2 command chạy thật.

---

### Task 4: Sửa mobile_entry_point vào đúng chỗ

**Files:**
- Modify: `src-tauri/src/lib.rs:155-160` (bỏ attribute sai chỗ), `src-tauri/src/lib.rs:162` (thêm attribute vào `pub fn run()`)

**Interfaces:**
- Produces: `pub fn run()` có `#[cfg_attr(mobile, tauri::mobile_entry_point)]` — chuẩn Tauri v2, desktop không đổi

**Behavior contract:** desktop `cargo run` vẫn chạy y như cũ; Android build sẽ sinh `_start_app` gọi đúng `run()`.

- [ ] **Step 1: Sửa lib.rs**
Xoá `#[cfg_attr(mobile, tauri::mobile_entry_point)]` khỏi `apply_window_activity_for_window` (lib.rs:155), thêm vào ngay trước `pub fn run()` (lib.rs:162):
```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
```

- [ ] **Step 2: Verify**
```bash
cd src-tauri && cargo check --target aarch64-linux-android && cargo check
```
Expected: cả 2 PASS. (Nếu vẫn fail → lỗi khác ngoài 2 blocker đã biết — báo cáo, đừng tự sửa lan.)

- [ ] **Step 3: Commit**
```bash
git commit -am "fix(android): move mobile_entry_point to run() (was on window activity helper)"
```

---

## PHASE 2 — OAuth Android (browser + custom scheme)

### Task 5: Rust — thêm luồng login Android (deep-link redirect)

**Files:**
- Modify: `src-tauri/Cargo.toml` (thêm `tauri-plugin-deep-link`)
- Modify: `src-tauri/src/lib.rs` (plugin init + command mới)
- Create: `src-tauri/src/auth_android.rs` (hoặc thêm vào `auth.rs` — chọn 1, theo pattern có sẵn của file)
- Modify: `src-tauri/capabilities/default.json` (permission deep-link nếu cần)
- Modify: `src-tauri/tauri.conf.json` (`plugins.deep-link.mobile[].scheme` = `com.drplay.app` — hoặc scheme ngắn `drplay`)

**Interfaces:**
- Produces: command `login_google_mobile()` -> `Result<Value, String>` (cùng shape JSON như `login_google_native`: `access_token`, `refresh_token`, `expires_in`) — được frontend gọi khi `IS_MOBILE`
- Consumes: `wa_credential.json` (cấu trúc `installed.client_id/client_secret` — NHƯNG Android client phải được tạo riêng trong Google Console: package name `com.drplay.app` + SHA-1; user phải cung cấp file credential Android — báo user trước khi làm task này)

**Behavior contract (bắt buộc liệt kê):**
- Desktop: `login_google_native` giữ NGUYÊN 100% (loopback + tiny_http + open::that)
- Android: mở browser ngoài (qua `tauri_plugin_opener` — đã init sẵn lib.rs:164 — dùng `open_url` với `with_fallback: true` hoặc `browser: Some("chrome")`) với redirect_uri = custom scheme (`com.drplay.app:/oauth2redirect`), PKCE S256 giống desktop, CSRF state
- Deep-link: dùng `tauri_plugin_deep_link::DeepLinkExt` — `app.deep_link().on_open_url(...)` lắng nghe redirect, trong callback parse `code`/`state`/`error`, so CSRF, exchange token, gửi kết quả cho frontend qua event (`auth:result`) hoặc store vào `OnceLock` + promise
- Timeout 5 phút, cancel (error param) trả Err giống desktop
- Scope: GIỮ NGUYÊN 4 scopes desktop (drive, drive.appdata, email, profile) + access_type=offline + prompt=consent
- CSP: redirect qua custom scheme KHÔNG bị CSP chặn (navigation) — không cần sửa CSP cho việc này

- [ ] **Step 1: Tra cứu bắt buộc (Luật 3)**
DuckDuckGo + context7: `tauri-plugin-deep-link` docs (v2.tauri.app/plugin/deep-linking/) — cấu hình scheme, `on_open_url` API, permissions; xác nhận custom scheme (`com.drplay.app:`) hay dùng dạng `<scheme>:/` — ghi nguồn vào report. Kiểm tra version plugin mới nhất compatible tauri 2.11.

- [ ] **Step 2: Yêu cầu user trước khi code**
Báo user: (a) tạo OAuth client Android trong Google Console (package `com.drplay.app` + SHA-1 từ `keytool -list -v -keystore src-tauri/gen/android/app/build.gradle.kts` release keystore hoặc debug keystore), (b) nếu dùng custom scheme redirect → vào Advanced Settings bật cho phép (Google đã hạn chế custom scheme từ 10/2023); (c) file credential Android đặt cạnh `wa_credential.json`. **BLOCK nếu user chưa tạo client** — hoặc làm trước trên nhánh riêng không chờ (chọn theo user).

- [ ] **Step 3: Thêm plugin + config**
```toml
# Cargo.toml (dependencies)
tauri-plugin-deep-link = "2"
```
```json
// tauri.conf.json
"plugins": {
  "deep-link": {
    "mobile": [{ "scheme": "com.drplay.app" }]
  }
}
```
```rust
// lib.rs builder
.plugin(tauri_plugin_deep_link::init())
```

- [ ] **Step 4: Viết test đỏ cho logic parse + CSRF (thuần, không cần device)**
Tách logic parse redirect URL (code/state/error) thành hàm thuần `parse_oauth_redirect(url: &str, expected_state: &str) -> Result<OAuthRedirect, OAuthError>` trong `auth_android.rs` + unit test:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_code_and_state() {
        let parsed = parse_oauth_redirect("com.drplay.app:/oauth2redirect?code=abc&state=xyz", "xyz").unwrap();
        assert_eq!(parsed.code, "abc");
    }
    #[test]
    fn rejects_mismatched_state() {
        assert!(parse_oauth_redirect("com.drplay.app:/oauth2redirect?code=abc&state=bad", "xyz").is_err());
    }
    #[test]
    fn detects_error_param() { /* error=cancelled -> Err("User cancelled authorization") */ }
}
```
Run: `cd src-tauri && cargo test auth_android` — Expected FAIL (module chưa có) → implement → PASS (RED→GREEN đầy đủ, log cụ thể).

- [ ] **Step 5: Implement command + deep-link listener**
Command `login_google_mobile()`: spawn async, dựng auth URL (PKCE + state lưu `OnceLock<(PkceVerifier, CsrfToken)>`), `opener::open_url(auth_url, None::<&str>)`, tạo `oneshot` channel, `deep_link().on_open_url` (setup từ `setup` hook — đăng ký 1 lần, lưu sender vào static) push URL vào channel, timeout 300s; nhận URL → parse → verify state → exchange (dùng `oauth2::reqwest::async_http_client` như `refresh_google_token`) → trả JSON.
Error-handling chuẩn Luật 4: phân loại (timeout / cancelled / CSRF / exchange fail / deep-link không về), log ngữ cảnh KHÔNG token, trả Err có nghĩa cho frontend.

- [ ] **Step 6: Verify**
```bash
cd src-tauri && cargo check --target aarch64-linux-android && cargo check && cargo test
```
Expected: PASS hết (test mới + cũ). Desktop: `cargo check` PASS.

- [ ] **Step 7: Commit**
```bash
git add src-tauri && git commit -m "feat(android): OAuth login via system browser + deep-link redirect (desktop loopback unchanged)"
```

### Task 6: Frontend — gọi đúng luồng login theo platform

**Files:**
- Modify: `src/ui/Login/` (tìm file chứa `invoke('login_google_native')` — grep trước)
- Create: `src/utils/platform.ts` (13 dòng — port từ adr_drplay nhưng KHÔNG import plugin-os nếu chưa cài; dùng regex userAgent + try/catch; xem Task 9 — task này có thể gộp phụ thuộc platform.ts, nếu Task 9 chưa chạy thì tạo tạm tại đây)

**Interfaces:**
- Consumes: command `login_google_mobile` (Task 5)
- Produces: `IS_MOBILE: boolean` (export từ platform.ts)

**Behavior contract:**
- Desktop: y hệt hiện tại (`login_google_native`)
- Android: `login_google_mobile`; UI hiện thông báo "mở trình duyệt để đăng nhập" (i18n thêm key — giữ song ngữ en/vi, theo pattern `locales/en/*.json`)
- Lỗi từ command hiển thị như hiện tại (pattern lỗi login đã có)

- [ ] **Step 1: Grep vị trí invoke login** — `rg "login_google_native" src/` — đọc file đó.
- [ ] **Step 2: Tạo platform.ts** (nếu chưa có từ Task 9):
```ts
export const IS_MOBILE = /Android|iPhone|iPad|iPod|webOS|IEMobile|Opera Mini/i.test(
  navigator.userAgent
);
```
(không cần plugin-os — đủ cho quyết định UI; ghi chú trong comment lý do)

- [ ] **Step 3: Sửa chỗ gọi login**
```ts
const result = await invoke(IS_MOBILE ? 'login_google_mobile' : 'login_google_native');
```
+ UI state "đã mở trình duyệt, chờ redirect..." trên mobile. Test logic chọn luồng: test đỏ → xanh (vitest, file test cạnh hook/file chứa logic — mock `invoke` theo pattern test hiện có `src/hooks/__tests__/`).

- [ ] **Step 4: Verify** `npx tsc --noEmit` + `npx vitest run` (file test liên quan + login tests) + `npx eslint` trên file đụng.
- [ ] **Step 5: Commit** `git commit -am "feat(android): route login by platform (mobile uses deep-link flow)"`

---

## PHASE 3 — Keyring Android (Keystore)

### Task 7: Bật android-native-keyring-store

**Files:**
- Modify: `src-tauri/Cargo.toml` (feature keyring)
- Modify: `src-tauri/src/token_store.rs` (set default store trên Android)

**Interfaces:**
- Consumes: —
- Produces: `set_refresh_token/get_refresh_token/delete_refresh_token` hoạt động trên Android (Keystore) — signature giữ nguyên

**Behavior contract:**
- Desktop: 100% không đổi (Windows Credential Manager qua feature v1)
- Android: `Entry::new` không fail `NoDefaultStore` — dùng `android-native-keyring-store` (Keystore)
- Fallback an toàn: nếu Keystore init fail → command trả Err có ngữ cảnh (KHÔNG tự rơi xuống localStorage — frontend đã có fallback localStorage riêng ở apiClient.ts:223-244)

- [ ] **Step 1: Tra cứu bắt buộc (Luật 3)** — context7/docs: keyring 4.x `android-native-keyring-store` feature — cách kích hoạt: trong `main()`/setup trước khi dùng Entry, gọi gì? (tra `keyring_core::set_default_store` pattern từ `keyring-4.1.6/src/cli.rs` — có sẵn local trong `~/.cargo/registry`). Đọc source local trước + docs.
- [ ] **Step 2: Cargo.toml**
```toml
keyring = { version = "4.1.6", features = ["android-native-keyring-store"] }
```
- [ ] **Step 3: token_store.rs — init store trên Android**
Trong `refresh_token_entry()` hoặc `main()`: `#[cfg(target_os = "android")]` → `keyring_core::set_default_store(...)` (theo pattern cli.rs — đọc chính xác API từ source local) trước `Entry::new`. Wrap trong hàm `ensure_android_store()` gọi 1 lần (OnceLock/Once).
- [ ] **Step 4: Verify** `cd src-tauri && cargo check --target aarch64-linux-android && cargo check` — PASS. Unit test thuần cho logic chọn store (nếu tách được) — test đỏ → xanh.
- [ ] **Step 5: Commit** `git commit -am "feat(android): enable android-native-keyring-store (Keystore) for refresh token"`

---

## PHASE 4 — Native audio bridge (background playback)

> **PHỤ THUỘC GATE (Task 2):** đọc `docs/superpowers/plans/android-gate-report.md` trước. Nhánh A (SW sống): webview audio là chính, native audio chỉ cần cho background. Nhánh B (SW chết): native audio là đường playback CHÍNH — kiến trúc khác nhau, task này tách theo nhánh.

### Task 8A (nhánh A): Native audio cho background — bridge tối thiểu

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` (plugin init)
- Create: `src/lib/nativeAudioBridge.ts` (adapter — chỉ mobile)
- Create: `src/hooks/useNativeAudio.ts` (điều khiển khi IS_MOBILE)

**Interfaces:**
- Produces: `nativeAudioBridge` với API: `play(url, meta)`, `pause()`, `resume()`, `seekTo(sec)`, `onState(listener)` — gọi qua `invoke('plugin:native-audio|...')` (API plugin — verify khi tra cứu)

**Behavior contract:**
- Desktop: KHÔNG đụng — `useNativeAudio` không bao giờ mount (IS_MOBILE guard)
- Android nhánh A: webview `<audio>` vẫn phát (SW sống), `useNativeAudio` đồng bộ: khi `isPlaying` → native audio phát cùng URL (không audio — để không lệch timing: mô hình là "webview audio tắt, native phát" HOẶC "webview phát + native im lặng cho lock screen" — CHỌN 1, ghi rõ trong plan thực thi; khuyến nghị: native là nguồn phát, webview audio câm — vì ExoPlayer xử lý background/suspend tốt hơn; giữ seek bar đồng bộ qua onState)
- Trạng thái lock-screen: play/pause/next/prev/seek qua MediaSession (plugin tự lo)
- **KHÔNG được** đổi `AudioController` code hiện tại — bridge nằm ngoài, ở tầng hook player (`usePlayer.ts`): chỗ `usePlayer` điều khiển `audio` (tìm điểm gọi `audioController.play...`), thêm nhánh `if (IS_MOBILE)` gọi bridge thay vì HTMLAudioElement — **đọc kỹ usePlayer.ts + AudioController interface trước, liệt kê chính xác điểm chèn vào report, behavior contract cho từng điểm**

- [ ] **Step 1: Tra cứu bắt buộc** — context7 + duckduckgo: `tauri-plugin-native-audio` API chính xác (JS methods, tên command, events), khả năng: remote URL (https drive URL), set header Authorization? (nếu KHÔNG hỗ trợ headers → nhánh A webview cũng cần URL có auth — SW cung cấp `/drive-stream/` origin-relative → vấn đề: ExoPlayer không có cookie/token đó; khả năng dùng `https://tauri.localhost/drive-stream/...` từ native? — tra cứu + báo cáo rõ, đừng đoán)
- [ ] **Step 2: Thêm plugin + Cargo + lib.rs init**
- [ ] **Step 3: bridge + hook** (TDD: test thuần logic chọn hành động map từ player state → plugin calls; mock invoke)
- [ ] **Step 4: Verify** `npx tsc --noEmit` + vitest liên quan + `cargo check --target aarch64-linux-android`
- [ ] **Step 5: Test device** (nếu được — adb + emulator): phát nhạc, khoá màn hình, xác nhận nhạc chạy tiếp + lock screen có controls
- [ ] **Step 6: Commit** `feat(android): native audio bridge for background playback (webview audio primary)`

### Task 8B (nhánh B): Native audio là đường playback chính

**Files:** như 8A +:
- Modify: `src/hooks/player/` (điểm chèn chính xác sau khi đọc — liệt kê behavior contract từng điểm)
- Modify: `src/utils/streamPrefetcher.ts` / `nextTrackPrefetcher.ts` — CHỈ thêm nhánh mobile no-op (không đổi desktop path)

**Behavior contract (bổ sung so với 8A):**
- Android: KHÔNG dùng HTMLAudioElement — `usePlayer` gọi `nativeAudioBridge` cho play/pause/seek/next
- URL phát: phụ thuộc khả năng header của plugin — nếu plugin không hỗ trợ header: CHỐT PHƯƠNG ÁN (chọn 1, thảo luận với Main Agent trước khi code — đây là quyết định kiến trúc, không tự quyết): (i) fork plugin thêm headers; (ii) URL query `access_token` (đã biết bị chặn — LOẠI); (iii) Rust proxy `drplay://stream/` (được phép CHỈ khi user duyệt lại quyết định đóng băng — mặc định KHÔNG); (iv) URL qua `https://tauri.localhost` + SW nếu SW sống 1 phần
- Seek: ExoPlayer tự Range (không cần tokenizer) — tokenizer chỉ còn cho desktop
- Metadata: playlist/queue/history vẫn là JS (Dexie) — không đổi

- [ ] Steps tương tự 8A + bước quyết định URL auth (bàn với Main Agent) + test device bắt buộc
- [ ] Commit tương ứng

---

## PHASE 5 — UI mobile + port mobile work cũ

### Task 9: platform.ts + plugin-os + IS_MOBILE

**Files:**
- Create: `src/utils/platform.ts`
- Modify: `package.json` (thêm `@tauri-apps/plugin-os` — ver khớp tauri 2.11)
- Modify: `src-tauri/Cargo.toml` (thêm `tauri-plugin-os`), `src-tauri/src/lib.rs` (`.plugin(tauri_plugin_os::init())`)
- Modify: `src-tauri/capabilities/default.json` (permission `os:default`)

**Interfaces:**
- Produces: `export const IS_MOBILE: boolean` — dùng cho mọi quyết định UI mobile

**Behavior contract:** desktop → false; Android → true; fallback regex khi plugin fail (pattern adr_drplay/src/utils/platform.ts:1-13 — nhưng SỬA lỗi cũ: cài đúng @tauri-apps/plugin-os).

- [ ] **Step 1:** `npm i @tauri-apps/plugin-os` (bản phù hợp — check `npm view @tauri-apps/plugin-os versions` hoặc theo docs)
- [ ] **Step 2:** port platform.ts (test đỏ: unit test mock `type()` trả 'android'/'windows' → IS_MOBILE đúng — theo pattern mock hiện có trong repo)
- [ ] **Step 3:** Cargo + lib.rs + capabilities
- [ ] **Step 4: Verify** `npx tsc --noEmit` + vitest file liên quan + `cargo check --target aarch64-linux-android`
- [ ] **Step 5: Commit** `feat(android): platform detection (IS_MOBILE)`

### Task 10: Hardware back button (useHardwareBack + History API)

**Files:**
- Create: `src/hooks/useHardwareBack.ts` (port từ adr_drplay/src/hooks/useHardwareBack.ts:1-25 — đọc trước, file 25 dòng, stack LIFO)
- Modify: `src/App.tsx` (chèn `useHardwareBack` handlers theo state hiện tại — KHÁC bản cũ: search/trash/settings giờ ở gate khác; đọc kỹ App.tsx + AppShell.tsx + TabContentRouter.tsx, liệt kê thứ tự back đúng: đóng overlay → đóng NowPlaying → về Home → thoát (window.close — KHÔNG dùng plugin:process vì chưa có))

**Behavior contract (liệt kê theo thứ tự ưu tiên back):**
- Overlay (search/trash/settings modal nếu open) → đóng overlay
- NowPlaying open → đóng NowPlaying
- Tab ≠ Home → về Home
- Tab = Home → thoát app (đúng chuẩn Android: back ở root = exit)
- Desktop: KHÔNG có hành vi nào thay đổi (hook không active khi !IS_MOBILE)
- Kiểm tra xung đột: `usePlayerSession` pagehide/visibility (grep trước — tránh đụng)

- [ ] **Step 1:** port hook (test đỏ: vitest — stack push/pop, empty stack behavior)
- [ ] **Step 2:** tích hợp App.tsx (grep state liên quan: `activeTab`, `folderHistory`, `handleBack`, `isNowPlayingOpen`, overlays — map chính xác, báo cáo khác biệt so với bản cũ nếu có)
- [ ] **Step 3: Verify** tsc + vitest + eslint
- [ ] **Step 4: Commit** `feat(android): hardware back button via History API`

### Task 11: BottomNav + layout mobile

**Files:**
- Create: `src/ui/components/BottomNav.tsx` (port adr_drplay/src/ui/components/BottomNav.tsx:1-42 — 4 tab: Home/Drive/Liked/Playlist + safe-area)
- Modify: `src/ui/layouts/AppShell.tsx` (IS_MOBILE → ẩn Sidebar, hiện BottomNav, flex-col)
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` (mobile: ẩn volume/cover, layout gọn — đọc hiện trạng responsive: đã có `lg` breakpoint ẩn heart/MoreMenu; bổ sung tối thiểu)

**Behavior contract:** desktop layout 100% y hệt; mobile: Sidebar ẩn (không unmount state), BottomNav 4 tab chuyển tab đúng như Sidebar hiện tại (tìm handler chuyển tab của Sidebar — reuse cùng handler).

- [ ] **Step 1:** port BottomNav (kiểm tra i18n keys `sidebar.*` có sẵn — dùng chung; nếu thiếu → thêm key en+vi theo pattern `locales/`)
- [ ] **Step 2:** AppShell layout branch (test: vitest render AppShell mock IS_MOBILE — theo pattern test UI hiện có; hoặc guard logic tách hàm `shouldShowBottomNav(IS_MOBILE)` test được)
- [ ] **Step 3: Verify** tsc + vitest + eslint + screenshot kiểm tra nhanh bằng `npm run dev` + playwright (webapp-testing) viewport mobile
- [ ] **Step 4: Commit** `feat(android): bottom nav + mobile layout (desktop unchanged)`

### Task 12: Mobile: KHÔNG fetch metadata + KHÔNG hiện metadata (tên file thôi)

> **SCOPE mobile (user chốt):** không ID3 parse, không cover, không artist/album — list chỉ hiện tên file.
> **CẢNH BÁO worktree:** kiểm tra nhánh `refactor/cover-image-and-tags` merge chưa (git branch --merged). CHƯA merge → KHÔNG chạm `useTrackMetadata`/cover — báo Main Agent, ghi defer.

**Files:**
- Đọc trước (xác định điểm gate chính xác, ghi report file:dòng): `src/hooks/usePlayer.ts:285-308`, `src/hooks/useTrackMetadata.ts`, `src/utils/metadata/` (pipeline), `src/ui/NowPlaying/` (cover + palette: bản cũ port từ adr_drplay NowPlayingView.tsx:79,93,299,309,324), `src/ui/components/SongCard.tsx` + `src/ui/LikedSongs/` + `src/ui/Playlist/` + `src/ui/MainContent/components/` (chỗ hiện artist/album/cover)
- Modify: các vị trí hiện metadata/cover — gate `IS_MOBILE` hiển thị/điều khiển

**Behavior contract (mobile):**
- KHÔNG gọi ID3 parse (local lẫn network) — playTrack không chờ metadata (pattern cũ: PlayerBar.tsx:157-160 "skip metadata loading on mobile to speed up playback")
- KHÔNG fetch cover từ mạng, KHÔNG palette extraction, KHÔNG hiện cover bất kỳ đâu (list, player, NowPlaying)
- List item hiện: tên file + size/modifiedTime (dữ liệu Drive files.list có sẵn — KHÔNG cần thêm call)
- Player/NowPlaying: chỉ tên bài (không artist/album/cover)
- Desktop: 100% y hệt — gate ở tầng hook/UI, KHÔNG đổi pipeline `src/utils/metadata/`
- KHÔNG đổi behavior contract pipeline chung — quyết định từ audit: port ở tầng hook

- [ ] **Step 1:** đọc pipeline + UI hiện tại, liệt kê chính xác từng điểm hiện metadata/cover (report file:dòng + behavior contract cho từng điểm) — KHÔNG code trước khi liệt kê
- [ ] **Step 2:** gate IS_MOBILE từng điểm (test đỏ → xanh: test hook render với IS_MOBILE mock — assert không gọi fetch cover / không ID3; theo pattern test hiện có)
- [ ] **Step 3: Verify** tsc + vitest + eslint
- [ ] **Step 4: Commit** `perf(android): no metadata/cover on mobile — name-only lists (desktop unchanged)`

### Task 13: CSP Android + xác nhận cover path (mobile KHÔNG hiện cover)

> **SCOPE mobile:** không hiện cover → `drplay://` không còn được dùng trên mobile; task này giảm xuống còn: xác nhận không block gì + sửa CSP nếu cần cho streaming.

**Files:**
- Đọc: `src/utils/coverStore.ts` (xác nhận điểm gọi cover — Task 12 đã gate hết), `src-tauri/tauri.conf.json` (CSP prod: `media-src 'self' blob: data: https://www.googleapis.com drplay:` — đã đủ cho SW streaming `/drive-stream/` vì SW response vẫn origin 'self'; xác nhận lại)
- Modify: `src-tauri/tauri.conf.json` — CHỈ nếu phát hiện thiếu origin cho Android (vd `connect-src` khi deep-link OAuth cần) — bằng chứng cụ thể, không đoán

**Behavior contract:** desktop CSP y hệt; Android không cần `drplay:` trong CSP (không dùng) — không sửa vô tội vạ (CSP chung 2 nền tảng — thêm `http://drplay.localhost` CHỈ khi có bằng chứng cần).

- [ ] **Step 1:** đọc coverStore.ts (xác nhận Task 12 đã gate toàn bộ điểm gọi cover — nếu chưa, báo Main Agent), đối chiếu CSP với các origin thực tế dùng trên Android (googleapis, oauth2.googleapis.com, *.googleusercontent.com — đã có)
- [ ] **Step 2:** nếu cần → sửa CSP kèm lý do; không cần → ghi N/A rõ lý do
- [ ] **Step 3: Verify** `cargo check --target aarch64-linux-android` (config validate khi build android) + tsc
- [ ] **Step 4: Commit** `chore(android): CSP verified for Android (no cover scheme needed on mobile)` (hoặc fix tương ứng)

### Task 14: Mobile: virtual scroll toàn bộ danh sách, bỏ phân trang UX

> **SCOPE mobile (user chốt):** "không còn phân trang mà sẽ làm virtual scroll". Hiện trạng: UI list đã dùng @tanstack/react-virtual (MainContent.windowing.test.tsx, LikedSongs, PlaylistView, FullRecentView), dữ liệu vào qua `useDriveOnDemandFetch` (pageToken 1000/trang → Dexie) + `drivePagination.ts` (fetchAllPages ≤10 trang). Phân trang ở đây = cơ chế fetch chia trang + bất kỳ UX load-more nào còn sót.

**Files:**
- Đọc trước (liệt kê chính xác file:dòng trong report): `src/hooks/useDriveOnDemandFetch.ts` (toàn bộ), `src/hooks/useDriveExplorer.ts`, `src/utils/drivePagination.ts`, `src/utils/driveConstants.ts` (PAGINATION_PAGE_SIZE), `src/ui/HomeTab/HomeTab.tsx` (recent lists — có dùng pagination không), `src/ui/MainContent/MainContent.tsx` (windowing hiện tại), `src/ui/LikedSongs/`, `src/ui/Playlist/` (đã virtual — xác nhận)
- Modify: theo kết quả đọc (tầng fetch/UI trên mobile)

**Behavior contract (mobile):**
- Mọi danh sách hiển thị qua virtual scroll (tanstack) — không nút "Load more", không chia trang hiển thị
- Fetch: vẫn phải pageToken nền (Drive cap 1000/request — bất khả kháng) NHƯNG loop fetch tự động cho hết (pattern `useDriveOnDemandFetch` while-loop hoặc `fetchAllPages` cap) → user không thấy phân trang
- Số item lớn (hàng nghìn file) vẫn mượt (virtual scroll đã có)
- Desktop: 100% y hệt — chỉ gate mobile; KHÔNG đổi drivePagination.ts / useDriveOnDemandFetch cho desktop
- **KHÔNG fetch-all vô hạn:** giữ cap an toàn hiện có (MAX_PAGINATION_PAGES=10 = 10k items) — vượt cap báo "thư mục quá lớn" thay vì treo

- [ ] **Step 1:** đọc code + liệt kê (report): nơi nào còn UX phân trang (nút load-more, "hiện thêm", page indicator); nơi nào list chưa virtual; nơi fetch dừng sớm
- [ ] **Step 2:** implement theo danh sách: (a) list chưa virtual → wrap tanstack (theo pattern VirtualizedSongList.tsx:2,69), (b) bỏ UX load-more trên mobile (gate IS_MOBILE), (c) đảm bảo fetch loop tự động hết trang (không UX chia trang) — test đỏ → xanh từng món (vitest: windowing tests pattern MainContent.windowing.test.tsx)
- [ ] **Step 3: Verify** tsc + vitest + eslint + kiểm tra nhanh bằng `npm run dev` + playwright (webapp-testing) viewport mobile — scroll danh sách 1000+ item
- [ ] **Step 4: Commit** `feat(android): virtual scroll everywhere on mobile, no paging UX (desktop unchanged)`

---

## PHASE 6 — Desktop-only tính năng + đóng gói

### Task 15: Ẩn toàn bộ upload trên mobile + download path

> **SCOPE mobile (user chốt):** KHÔNG có upload — ẩn UploadButton, DropZone, upload folder/file, upload session UI. Code desktop upload GIỮ NGUYÊN (không xoá) — chỉ gate hiển thị/active bằng IS_MOBILE.

**Files:**
- Đọc trước: `src/ui/components/UploadButton.tsx:88,122` (upload file/folder), `src/ui/components/DropZone.tsx:3,176` (drag-drop), `src/ui/Sidebar/SidebarHeader.tsx` + `Sidebar.tsx` (nút upload), `src/ui/MainContent/MainContent.tsx` (chỗ mount UploadButton/DropZone), `src/hooks/useMenuDownload.ts` + `src/utils/diskFs.ts` (download path)
- Modify: gate IS_MOBILE ẩn: UploadButton (mọi nơi mount), DropZone (đã guard drag — thêm ẩn luôn trên mobile), menu item upload (MoreMenu nếu có), Settings mục upload session (nếu có); download path: mobile ẩn chọn folder — download về app dir (`@tauri-apps/plugin-fs` mobile path theo pattern) + thông báo

**Behavior contract:**
- Desktop: 100% y hệt (upload + download path đầy đủ)
- Android: không thấy bất kỳ UI upload nào; download không có chọn path — về thư mục app, hiện thông báo nơi lưu
- Upload command Rust (`register_upload_path` lib.rs:117-153) KHÔNG bị xoá — desktop dùng; mobile không gọi

- [ ] **Step 1:** đọc các file + liệt kê chính xác điểm mount/ẩn (report file:dòng)
- [ ] **Step 2:** implement (test đỏ → xanh cho logic chọn hành động download; ẩn UI qua IS_MOBILE — test render mock IS_MOBILE assert không có upload button)
- [ ] **Step 3: Verify** tsc + vitest + eslint
- [ ] **Step 4: Commit** `feat(android): hide upload on mobile, downloads to app dir (desktop unchanged)`

### Task 16: Keepawake + các invoke desktop-only còn lại

**Files:**
- Modify: `src/hooks/usePlayer.ts:8,122,132` (keepAwake trên Android: plugin `tauri-plugin-keepawake` KHÔNG hỗ trợ Android — giữ catch warn hiện có, hoặc thay `@tauri-apps/plugin-wakelock`-style mobile — tra cứu theo Luật 3; nếu phức tạp → giữ nguyên catch, ghi N/A)
- Verify: `src/App.tsx:232` invoke `update_minimize_to_tray` (đã .catch — OK, không sửa)

**Behavior contract:** desktop y hệt; Android: không giữ màn hình sáng (chấp nhận — background playback không cần wakelock vì ExoPlayer foreground service giữ CPU).

- [ ] **Step 1:** đọc usePlayer keepAwake block + quyết định (tra cứu plugin thay thế — 30 phút tối đa; không có kết quả → giữ nguyên + ghi N/A lý do)
- [ ] **Step 2:** implement nếu có hướng; verify tsc/vitest
- [ ] **Step 3: Commit** phù hợp (hoặc `chore(android): keepawake no-op on Android — documented`)

### Task 17: Build APK release + kiểm thử cuối

**Files:**
- Modify: `src-tauri/tauri.conf.json` (identifier/bundle nếu cần), icons android (đã sinh ở Task 1 — kiểm tra kích thước đúng)
- Create: `docs/android-qa-checklist.md` (danh sách test tay)

**Interfaces:** —
- [ ] **Step 1:** `npm run tauri android build -- --apk` — Expected: APK tại `src-tauri/gen/android/app/build/outputs/apk/...`
- [ ] **Step 2:** cài lên device: `adb install -r <apk>` — chạy full QA theo checklist: login, browse, play (foreground), lock screen (background), seek, playlist, likes, download, upload file, back button, theme/i18n
- [ ] **Step 3:** kiểm tra `adb logcat` lỗi đỏ (crash/exception) — ghi report
- [ ] **Step 4:** full suite desktop lần cuối: `npx vitest run` + `npm run build` + `npm run tauri build` (Windows) — xanh
- [ ] **Step 5: Commit** + báo cáo tổng kết cho user

---

## Lưu ý phụ thuộc & thứ tự khuyến nghị

1. **Bắt buộc trước:** Task 1 → 3 → 4 (có build Android mới test được)
2. **GATE:** Task 2 (sau 3+4) — mọi task Phase 4 phụ thuộc
3. **Độc lập chạy song song được:** Task 7 (keyring) song song Task 5-6 (OAuth); Task 14 (virtual scroll) song song Task 11-12 (UI)
4. **Phụ thuộc user:** Task 5 cần Google Console OAuth client Android (package + SHA-1) — chuẩn bị sớm
5. **Defer có điều kiện:** Task 12 nếu nhánh cover chưa merge
6. **Kiểm tra thiết bị:** nếu không có emulator/device → Task 2, 8, 17 giảm xuống verify compile-only + báo user
7. **Scope mobile (nhắc lại):** mọi task UI kiểm tra — không upload, không metadata display, virtual scroll toàn bộ (xem Goal)
