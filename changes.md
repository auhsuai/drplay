# CHANGES — Các quyết định của Main Agent (session 2026-08-15)

> File này ghi lại MỌI quyết định tôi (Main Agent) tự chốt trong lúc user vắng,
> kèm lý do tham khảo từ app lớn / tài liệu chính thức. Branch: `feature/android-port`.

---

## A. Batch polish bản v2 (11 task — đã gửi APK 15:28)

| # | Quyết định | Lý do / tham khảo |
|---|---|---|
| 1 | Mobile không gọi: SW register, keepawake, invoke tray → log sạch | SW chết trên Tauri Android (GATE B đã đo); plugin không tồn tại trên Android → gọi = lỗi vô ích |
| 2 | Ẩn import metadata trong Settings (mobile) | Scope mobile đã chốt: không metadata — không hiện chức năng chết |
| 3 | Toggle "Chạy nhạc nền" thay minimize-to-tray (mobile); OFF = pause khi app ra nền | Tray không tồn tại mobile; Android user quen khái niệm "background playback" (Spotify/YTM đều có tùy chọn này) |
| 4 | Download + đổi thư mục qua **SAF** (plugin Kotlin riêng, staged fs-write) | `tauri-plugin-dialog` xác minh KHÔNG hỗ trợ folder picker Android (Cargo.toml plugin) → SAF là chuẩn Android (developer.android.com document-provider). JNI_OnLoad bị chiếm → không dùng bridge Rust↔Kotlin; `run_mobile_plugin` không chở được bytes → staging qua fs-write |
| 5 | PlayerBar mobile 5 nút: (back bài)(-5s)(play)(+5s)(next bài) + SeekBar kéo full-width | **User chốt bố trí nút**; tua ±5s giữ nguyên (không 15s như YTM — user chọn 5s); root cause drag = thiếu `touch-action:none` trên row (đọc code + test) |
| 6 | File hiện icon Music, folder hiện icon Folder (mobile) | Fix bug Task 12 gate nhầm cả icon file — user báo "folder có icon, file không" |
| 7 | Home sections: có ViewAll giữ grid, không ViewAll → lướt ngang snap | YTM/Spotify Home đều cho section lướt ngang, mục "See all" giữ lưới riêng |
| 8 | Font mobile giảm 1 nấc (ternary IS_MOBILE, KHÔNG media query root) | Media query `html{font-size}` scale cả icon/padding/gap + ảnh hưởng desktop window hẹp → loại (đã phân tích blast radius) |
| 9 | Double-back-to-exit: toast + cửa sổ **2 giây** (chuẩn Android "Press back again to exit" — geeksforgeeks/Android convention, 2000ms) | |
| 10 | Search mobile: icon-only → tap expand từ mép trái (slide-in-left), breadcrumb compact | Pattern search bar mobile của Google/Material: icon thu gọn, expand khi focus |
| 11 | Sidebar default CLOSED trên mobile | Fix back bị nuốt (sidebar ẩn vẫn nuốt back đầu); desktop giữ OPEN |

## B. Batch fix lỗi user báo (Task 12-15 — bản APK kế tiếp)

### 12. Fix refresh token (bug chết sau ~50 phút)
- **Root cause (tự điều tra):** `refresh_google_token` hardcode client DESKTOP (wa_credential.json + secret) nhưng token trên Android do client ANDROID (public, không secret) cấp → `invalid_grant` → hết hạn là chết, phải xóa data.
- **Fix:** `build_token_client(use_android_client)` — Android dùng `ANDROID_CLIENT_ID` + secret None (đúng RFC 8252 public client — đã xác minh oauth2 4.4.2 source: secret None → không gửi client_secret); desktop byte-identical.
- **Quyết định:** dùng `cfg!(target_os)` runtime để test được cả 2 nhánh trên host.

### 13. Settings mobile hiện tên + avatar
- **Quyết định:** extract `UserAvatar` từ UserProfileSection (DRY, byte-identical) + mobile-only header trong Settings; desktop y hệt. Nguồn dữ liệu duy nhất: `useAuth` → `userProfile` (không viết lại logic lấy user).

### 14. Back chain chuẩn LIFO (fix back cứng nhắc)
- **Vấn đề user báo:** vào Recent hoặc folder con My Drive → back nhảy thẳng tới "thoát app".
- **Quyết định (chuẩn Android navigation — LIFO stack, đã search predictive back docs):** chain đầy đủ:
  1. Overlay (rate-limit → trash → folder-selection → sidebar)
  2. **FullRecentView → đóng** (handler đặt trong HomeTab — state local, child-effect order đảm bảo LIFO)
  3. **My Drive folder → lên cha 1 cấp** (reuse `useDriveNavigation.handleBack`; fallback history rỗng → root)
  4. NowPlaying → đóng
  5. tab ≠ Home → Home
  6. Home root → double-back-to-exit (2s, giữ nguyên)
- **Quyết định nhỏ:** KHÔNG đưa search-expanded vào chain (state local trong TopNavigationBar — nâng lên App xâm lấn > lợi ích).

### 15. NowPlaying mobile polish
- **Quyết định (tham khảo YTM/Spotify full player):** thêm 2 nút tua ±5s vào nhóm controls mobile (đồng bộ PlayerBar — cùng engine `seekRelative`, cùng aria-label); safe-area top cho back button + title (notch — pattern `env(safe-area-inset-top)`, nhất quán BottomNav); 360px layout check không tràn (chuyển `gap-6` → `gap-2 px-2` mobile).
- Desktop byte-identical (aria-label thêm vào 3 nút cũ — visual không đổi).

---

## B2. Batch tối ưu lần 2 (user test bản v3 — Task 16-20)

### 16. Media notification có điều khiển (chuẩn app lớn)
- **Root cause (đọc code plugin):** race service-vs-session (play gọi startService trước ensure → window bỏ lỡ → manager không tạo) + `onUpdateNotification` rỗng → media3 fallback notification TRẦN (không nút) — đúng triệu chứng user báo; action cũ sai (rew/FF thay vì prev/next).
- **Fix:** ensure() trong lock trước startService; 3 actions prev/play-pause/next + compact [play-pause, next] (media3 1.4.1 API chuẩn — setUsePreviousAction/NextAction/PlayPauseActions + InCompactView); icon play/pause tự swap theo state; tap mở app (launch intent đã đúng); artwork bỏ (scope mobile không metadata — large icon = app icon).
- **Quyết định:** xin POST_NOTIFICATIONS ở cả initialize + play (đơn giản, notification chắc hiện — app lớn xin lúc play, chấp nhận lệch nhẹ); swipe-dismiss → service dừng nhưng playback tiếp tục (đúng YT Music/Spotify).

### 17. Toast/error không tràn màn hình
- Toast: `max-w-[85vw] break-words line-clamp-3` + title tooltip full message; ErrorToast banner: max-w-full + truncate + title. Chỉ UI hiển thị — captureError/log không đụng.

### 18. Khôi phục heart + MoreMenu trên mobile
- Root cause: wrapper `hidden lg:flex` (desktop-pattern cũ) — mobile mất cả 2. Fix: mobile luôn hiện, compact 32px → 28px (Task 19 giảm tiếp); desktop byte-identical. Vị trí: phải TrackInfo, sát transport row.

### 19-20. Compact đợt 2 (user: "vẫn to quá")
- Nút: transport 36→30px, play 40→34px, heart/menu 32→28px, BottomNav h-16→h-14 + icon 24→20px. Lý do số liệu: mini-player app lớn ~32px (Spotify) / ~36px (YTM) — user muốn nhỏ hơn nữa → 30/34; floor chạm 28px giữ.
- Font: NowPlaying 20→18, HomeTab greeting 24→20, Settings h1 24→20, Settings rows 14→13. Floor 12px giữ. BottomNav label 10px giữ (floor).
- **Ghi chú:** NowPlayingView empty-state text-xl (màn hiếm — không có track) giữ nguyên — ghi nhận, không tốn 1 vòng dispatch.

---

## C. Quyết định kỹ thuật xuyên suốt
- **Desktop bất biến tuyệt đối** — mọi thay đổi sau `IS_MOBILE`; test desktop path phải xanh từng task.
- **i18n:** translation.json bị nhánh cover `refactor/cover-image-and-tags` chiếm → mọi key mới dùng `t(key, {defaultValue})`; merge cover xong sẽ thay bằng key thật.
- **Conflict cover branch:** App.tsx / SettingsTab / PlayerBar / HomeTab / MainContent / SongCard / translation.json đều nằm trong nhánh cover (đang làm dở, có uncommitted) — sửa thẳng trên nhánh này, resolve conflict 1 lần khi merge (đã chấp nhận từ đầu).
- **Emulator:** AVD dùng image Android 17 preview (sdk_gphone16k) — WebView bị SIGILL khi low-memory (lỗi image, không phải code, backtrace trong webview native); cần smoke test trên device thật.
- **APK:** luôn build `--target aarch64` (chỉ arm64 — user chỉ dùng 1 máy, không build 4 ABI lãng phí), ký debug keystore (production sau này đổi keystore riêng).
- **Lỗi môi trường đã gặp (nhớ):** gradle daemon bị giết nếu shell timeout → build chạy detached + poll; stale `%TEMP%\com.drplay.app-server-addr` gây ConnectionRefused; PowerShell `Set-Content` làm hỏng UTF-8 (bẫy 5C.8 — đã restore từ git).

## D. Còn lại (follow-up)
- Merge nhánh cover → thay i18n defaultValue bằng key thật + dọn 3 mục cũ (TrashScreen virtual, folder_cap_reached, pagination chrome) + gate SettingsTab change-path nếu cover đổi.
- Smoke test device thật: login → phát nhạc liên tục > 50 phút (xác nhận refresh token fix), download qua SAF, back chain đầy đủ, notch safe-area.
- wry#1710 (SW qua https://tauri.localhost) — nếu ship, re-test SW (có thể bỏ native audio path webview).
