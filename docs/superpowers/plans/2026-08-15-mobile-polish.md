# Mobile Polish — Implementation Plan (2026-08-15)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) hoặc executing-plans. Steps dùng checkbox `- [ ]`.

**Goal:** 9 cải tiến UX + dọn log lỗi cho bản Android DrPlay (nhánh feature/android-port — login + playback đã chạy).

**Architecture:** Mọi thay đổi gate bằng `IS_MOBILE` — desktop 100% giữ nguyên. Settings/App/PlayerBar/HomeTab/MainContent nằm trong danh sách file nhánh `refactor/cover-image-and-tags` (đang làm dở, uncommitted) → **chấp nhận conflict khi merge cover sau** (đã chấp nhận từ Task 10/12 — ghi nhận, không chặn).

**Tech Stack:** React 19 + Tailwind 4, Tauri 2.11, vitest.

## Global Constraints
- **Desktop bất biến:** mọi thay đổi sau `if (IS_MOBILE)` / `!IS_MOBILE` — test desktop path cũ phải xanh
- **i18n:** translation.json bị nhánh cover chiếm → key mới DÙNG `t("key", { defaultValue })` (pattern đã dùng Task 14/15), KHÔNG sửa file JSON
- **TDD:** logic mới test đỏ → xanh; UI thuần verify bằng tsc + vitest file đụng + playwright (nếu nhanh)
- **CẤM vitest full suite mỗi task** — chỉ file test đụng (full suite + build chỉ 1 lần cuối session)
- **Tránh đụng file đã gate:** native audio engine (`src/lib/nativeAudioBridge.ts`), token_store.rs, auth_android.rs
- Cảnh báo: các file có thể cover-conflicted: `src/App.tsx`, `src/App.css`, `src/ui/Settings/SettingsTab.tsx`, `src/ui/PlayerBar/PlayerBar.tsx`, `src/ui/HomeTab/HomeTab.tsx`, `src/ui/MainContent/MainContent.tsx`, `src/locales/*/translation.json`

---

### Task 1: Dọn log lỗi trên mobile (3 invoke desktop-only fail)

**Files:**
- Modify: `src/hooks/useServiceWorker.ts` (SW register — GATE B: vô ích trên Android)
- Modify: `src/hooks/usePlayer.ts:129-145` (keepAwakeStart/Stop — plugin bị cfg loại khỏi Android → ACL fail)
- Modify: `src/App.tsx:232-241` (invoke update_minimize_to_tray — command không tồn tại trên Android)

**Behavior contract:**
- Mobile: KHÔNG gọi register SW (skip hẳn — không log lỗi), KHÔNG gọi keepawake (skip khi !IS_MOBILE), KHÔNG invoke update_minimize_to_tray (skip)
- Desktop: byte-identical (register SW vẫn chạy, keepawake vẫn chạy, tray invoke vẫn chạy)
- Log sau fix: không còn 3 lỗi (SW registration failed / keep-awake-release-failed / minimize-to-tray-failed) trên mobile
- Test: test mới assert IS_MOBILE → không gọi (mock IS_MOBILE pattern `vi.hoisted`); test cũ desktop xanh

- [ ] Step 1: đọc 3 file + xác định điểm gate (report file:dòng)
- [ ] Step 2: gate IS_MOBILE từng chỗ (test đỏ → xanh)
- [ ] Step 3: `npx tsc --noEmit` + `npx vitest run` (file đụng) + `npx eslint` file đụng
- [ ] Step 4: commit `fix(android): stop desktop-only invoke calls on mobile (clean logs)`

### Task 2: Ẩn import metadata trong Settings (mobile)

**Files:**
- Modify: `src/ui/Settings/SettingsTab.tsx:114-141` (Seed offline import section — import_metadata_seed)

**Behavior contract:** desktop y hệt (seed import vẫn hiện + chạy); mobile: section ẩn (không gọi invoke import_metadata_seed)

- [ ] Step 1: đọc section (report cấu trúc JSX)
- [ ] Step 2: gate `!IS_MOBILE` render (test: render mock IS_MOBILE → không có section; desktop test cũ xanh)
- [ ] Step 3: tsc + vitest file đụng + eslint
- [ ] Step 4: commit `feat(android): hide metadata import section in settings on mobile`

### Task 3: Minimize-to-tray → "Chạy nhạc nền" toggle (mobile)

**Files:**
- Modify: `src/App.tsx:195-241,450` (minimizeToTray state + invoke — mobile thay bằng background playback state)
- Modify: `src/ui/Settings/SettingsTab.tsx` (mục tray → mobile hiện toggle "Chạy nhạc nền")
- Modify: `src/hooks/usePlayer.ts` hoặc `src/lib/nativeAudioBridge.ts` (pause-on-background khi tắt toggle)
- Modify: `src/appUiState.ts` (LS key background playback — pattern LS_MINIMIZE_TO_TRAY)

**Behavior contract:**
- Desktop: minimize-to-tray y hệt (state + invoke + UI giữ nguyên)
- Mobile: toggle "Chạy nhạc nền" (default ON): ON = native audio tiếp tục khi app ra background (hiện trạng — foreground service); OFF = khi `visibilitychange` → hidden → engine.pause() (nếu đang chơi), visible → resume (nếu trước đó playing)
- State lưu localStorage (pattern hiện có); invoke update_minimize_to_tray KHÔNG gọi trên mobile (Task 1)
- i18n: `settings.background_playback` defaultValue en+vi (KHÔNG sửa JSON)
- Test: logic visibility handler (mock IS_MOBILE + toggle off → pause gọi, resume khi visible); desktop path cũ xanh

- [ ] Step 1: đọc App.tsx (state + settings props), SettingsTab tray section, usePlayer visibility handlers (grep visibilitychange — đã có useProSyncPoller:56, tránh đụng)
- [ ] Step 2: implement (TDD từng phần)
- [ ] Step 3: tsc + vitest file đụng + eslint
- [ ] Step 4: commit `feat(android): background playback toggle replaces minimize-to-tray on mobile`

### Task 4: FIX download + đổi thư mục hoạt động trên mobile (SAF — không ẩn)

> **User chốt:** KHÔNG ẩn nút đổi thư mục — phải FIX cho dùng được. Nguyên nhân lỗi hiện tại: `tauri-plugin-dialog` 2.7.1 KHÔNG hỗ trợ folder picker trên Android (đã xác minh Cargo.toml plugin: `notes = "Does not support folder picker"`) → dialog fail → lỗi. Giải pháp chuẩn Android: **Storage Access Framework (SAF)** — `ACTION_OPEN_DOCUMENT_TREE` + `takePersistableUriPermission` + ghi qua `DocumentFile`.

**Files:**
- Create: `src-tauri/gen/android/app/src/main/java/com/drplay/app/` — SAF launcher + write (Kotlin; gắn vào MainActivity.kt hoặc plugin nhỏ — subagent RESEARCH trước: pattern Tauri v2 plugin Kotlin + activity result, context7/duckduckgo "tauri plugin android activity result ACTION_OPEN_DOCUMENT_TREE", tài liệu tauri mobile plugin — ghi nguồn)
- Create: `src-tauri/src/download_android.rs` (hoặc tương đương): commands `pick_android_download_folder() -> { uri, name }`, `save_file_to_android_folder(uri, fileName, bytes)` — bridge Rust ↔ Kotlin (JNI_OnLoad pattern đã có sẵn cho VM — reuse nếu cần); gate `#[cfg(target_os = "android")]`; error-handling chuẩn Luật 4
- Modify: `src-tauri/src/lib.rs` (register commands)
- Modify: `src-tauri/capabilities/default.json` (permissions nếu cần)
- Modify: `src/utils/downloadPath.ts` (mobile: lưu {uri, displayName} thay cho path tuyệt đối — pattern hiện có)
- Modify: `src/hooks/useMenuDownload.ts` (mobile: tải bytes → invoke save_file_to_android_folder → toast "Đã lưu vào <tên thư mục>")
- Modify: `src/ui/Settings/SettingsTab.tsx:309-337` (nút Change path TRÊN MOBILE gọi pick_android_download_folder — HOẠT ĐỘNG, không ẩn)

**Behavior contract:**
- Desktop: y hệt (dialog folder picker + register_download_path)
- Mobile: bấm "Đổi thư mục" → mở SAF picker Android (chọn folder bất kỳ) → quyền ghi persist → từ đó download về folder đã chọn; path row hiển thị tên folder (display name)
- Fallback: chưa chọn folder → download về app dir (hiện trạng) + thông báo; user hủy picker → không đổi
- Quyền: SAF cần `takePersistableUriPermission(READ|WRITE)` — persist qua các lần mở app (uri lưu localStorage)

**Device test (bắt buộc):** emulator — mở Settings → đổi thư mục → SAF picker hiện → chọn Downloads → download 1 bài → verify file tồn tại (`adb shell run-as com.drplay.app ls ...` hoặc `adb shell ls /sdcard/Download/` nếu chọn thư mục Downloads) → ghi log

- [ ] Step 0: RESEARCH pattern (context7/duckduckgo): Tauri v2 plugin Kotlin activity result / SAF; JNI bridge Rust↔Kotlin (reuse JNI_OnLoad pattern token_store.rs); ghi nguồn
- [ ] Step 1: Kotlin SAF launcher + write
- [ ] Step 2: Rust commands + register
- [ ] Step 3: frontend downloadPath + useMenuDownload + SettingsTab (TDD test đỏ → xanh)
- [ ] Step 4: tsc + vitest file đụng + eslint
- [ ] Step 5: device test (trên)
- [ ] Step 6: commit `fix(android): working folder picker + download via SAF (was dialog fail)`

### Task 5: PlayerBar mobile — 5 nút điều khiển + SeekBar kéo full-width (fix drag)

> **User chốt (đã ghi ADR 2026-08-15):** giữ vị trí SeekBar hiện tại (bỏ ý "dính mép trên"); SeekBar kéo ngang TOÀN BỘ PlayerBar; FIX bug hiện tại: chỉ ấn (tap) được, KHÔNG kéo được. Nút điều khiển mobile thành 5 nút đúng thứ tự: **(back bài)(tua về 5s)(play/pause)(tua lên 5s)(next bài)** — tua 5s thay vị trí cạnh play, next/back ra 2 bên ngoài cùng.

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` (layout controls — mobile 5 nút; desktop byte-identical)
- Modify: `src/ui/components/SeekBar.tsx` (nếu cần — đọc trước: lỗi drag do đâu — pointer events/touch-action/width container; fix tối thiểu đúng root cause)
- Modify: `src/lib/nativeAudioBridge.ts` + `src/lib/AudioController.ts` (nếu cần seekRelative(±5) — kiểm tra: audio.currentTime += 5 đủ? đọc interface thật)
- i18n: aria-label `player.rewind_5s`/`player.forward_5s` defaultValue (KHÔNG sửa JSON — cover chiếm)

**Behavior contract:**
- Desktop: 0 thay đổi (layout cũ giữ nguyên)
- Mobile: 5 nút đúng thứ tự user chốt; tua 5s = seek(current ± 5) clamp 0..duration; SeekBar kéo được ngang hết bề rộng bar (fix drag — điều tra useSeekDrag pointer events + touch-action)
- Test: render 5 nút đúng thứ tự (mock IS_MOBILE); tua ±5 gọi seek đúng giá trị; drag simulation → seek theo vị trí

- [ ] Step 1: đọc PlayerBar controls + SeekBar (useSeekDrag/useSeekHover) + engine seek API — report root cause lỗi drag (file:dòng)
- [ ] Step 2: fix drag + full-width + 5 nút (TDD đỏ → xanh từng món)
- [ ] Step 3: tsc + vitest file đụng + eslint + playwright viewport mobile (kéo seek thử)
- [ ] Step 4: commit `feat(android): 5-button transport (prev/-5s/play/+5s/next), full-width seek drag fix`

### Task 6: Mobile — ẩn placeholder cover trong danh sách file (chỉ tên)

> **User chốt:** file không có cover → KHÔNG hiện hình mặc định (placeholder) — chỉ hiện tên.

**Files:**
- Modify: nơi render placeholder cover trên mobile: `src/ui/MainContent/components/SongCard.tsx` (Task 12 đã gate cover box — kiểm tra còn placeholder nào hiện), `src/ui/LikedSongs/LikedSongs.tsx`, `src/ui/Playlist/PlaylistView.tsx`
- Đọc trước: grep placeholder/icon box trong các list (Task 12 đã ẩn cover — còn icon mặc định nào hiện không)

**Behavior contract:** desktop y hệt; mobile: item FILE hiện tên + size (+date) — KHÔNG có khối hình placeholder; folder: GIỮ icon folder (cần phân biệt folder/file — Main Agent chốt giữ)

- [ ] Step 1: grep + đọc các list (report từng placeholder file:dòng)
- [ ] Step 2: gate ẩn (test đỏ → xanh: render mobile không có img/icon box cho file)
- [ ] Step 3: tsc + vitest file đụng + eslint
- [ ] Step 4: commit `feat(android): no placeholder cover for files in lists (name only)`

### Task 7: Recent sections — ViewAll cố định, phần khác lướt ngang

**Files:**
- Modify: `src/ui/HomeTab/HomeTab.tsx` (các section recent — grep ViewAll/See all + grid hiện tại)

**Behavior contract:** desktop y hệt; mobile: section nào CÓ nút ViewAll/See all → giữ nguyên grid cố định; các section recent khác (không ViewAll) → horizontal scroll snap (lướt qua lại chọn nhanh) — pattern: overflow-x-auto + snap-x (Tailwind), giữ item kích thước phù hợp touch

- [ ] Step 1: đọc HomeTab — liệt kê section nào có ViewAll, section nào không (report)
- [ ] Step 2: implement mobile-only (test: cấu trúc class/scroll theo IS_MOBILE; desktop snapshot cũ xanh)
- [ ] Step 3: tsc + vitest file đụng + eslint
- [ ] Step 4: commit `feat(android): horizontal snap scroll for non-viewall home sections`

### Task 8: Giảm font chữ (mobile)

**Files:**
- Modify: các file UI chính (grep `text-lg|text-xl|text-2xl|text-3xl` trong src/ui — PlayerBar, BottomNav, SongCard, HomeTab sections, Settings rows)
- Có thể thêm class base trong `src/App.css` cho mobile (tối thiểu)

**Behavior contract:** desktop y hệt; mobile: giảm 1 nấc (~0.875x) cho title/body chính

- [ ] Step 1: audit font sizes (report bảng file:dòng → nấc hiện tại)
- [ ] Step 2: giảm mobile-only (class conditional IS_MOBILE hoặc media query — chọn cách ít đụng nhất, tránh cover file nhiều)
- [ ] Step 3: tsc + vitest file đụng + eslint + playwright screenshot so sánh
- [ ] Step 4: commit `style(android): reduce font sizes on mobile`

### Task 9: Back — tab → Home + double-back-to-exit (toast, 2s)

**Files:**
- Modify: `src/App.tsx` (chỗ exit trong back chain — Task 10 đã có chain)
- Modify: `src/hooks/useHardwareBack.ts` (hoặc App.tsx handler)
- Modify: `src/ui/components/` — toast (kiểm tra showErrorToast/showInfoToast hiện có — dùng chung)

**Behavior contract (chuẩn Android — nguồn: geeksforgeeks/Android docs "Press back again to exit", 2000ms):**
- Mobile: back ở Home (sau khi overlay/NowPlaying/tab đã xử lý xong) → KHÔNG thoát ngay → toast "Nhấn back lần nữa để thoát" + timer 2s; back lần 2 trong 2s → exit(0) (plugin-process — đã có); quá 2s → reset trạng thái (back lần sau lại toast)
- Tab Liked/Settings → back về Home (chain hiện tại đã có tab≠Home → Home — VERIFY hoạt động, nếu chưa → fix; kiểm tra Settings là tab nên chain đã phủ)
- Desktop: không đổi
- Test: fake timer (vi.useFakeTimers) — back → toast + exit chưa gọi; back lần 2 trong 2s → exit gọi; quá 2s → reset
- i18n: `back.press_again_to_exit` defaultValue

- [ ] Step 1: đọc useHardwareBack + App.tsx chain hiện tại (report hành vi hiện: back ở Home thoát ngay — đúng không)
- [ ] Step 2: implement double-back (TDD fake timers)
- [ ] Step 3: tsc + vitest file đụng + eslint
- [ ] Step 4: commit `feat(android): double-back-to-exit with toast (2s window)`

### Task 10: Search bar thu gọn + path compact (mobile)

**Files:**
- Modify: `src/ui/MainContent/MainContent.tsx` (search input + breadcrumb — grep searchQuery/path)

**Behavior contract:** desktop y hệt; mobile: search mặc định chỉ icon (kích thước = SVG); tap → expand full-width từ mép TRÁI, animation direction từ phải sang (user: "tràn từ mép trái, chiều từ phải sang vị trí bên trái" — diễn giải: mở rộng về phải từ mép trái, nội dung điền từ phải qua trái — implement transition width/animation + ghi chú); path/breadcrumb thu gọn (chỉ folder hiện tại, che overflow)

- [ ] Step 1: đọc MainContent search + breadcrumb (report cấu trúc + classes)
- [ ] Step 2: implement mobile-only (test render + class theo IS_MOBILE; animation CSS thuần)
- [ ] Step 3: tsc + vitest file đụng + eslint + playwright viewport mobile (mở app, tap search, chụp)
- [ ] Step 4: commit `feat(android): collapsed search bar expands from left, compact breadcrumb`

---

## Thứ tự + phụ thuộc
1. Task 1 → 2 → 3 (Task 3 phụ thuộc Task 1: không gọi invoke tray)
2. Task 8 độc lập (chạy giữa các task UI)
3. Task 4-7, 9 độc lập — tuần tự trên cùng tree (5C.4: không song song)
4. Cuối session: full vitest + build + APK arm64 → ký → gửi `G:\My Drive\tess`
5. Conflict ghi nhận: App.tsx/SettingsTab/PlayerBar/HomeTab/MainContent cover-conflicted — resolve khi merge cover sau (KHÔNG chặn bây giờ)

## Verify cuối (1 lần duy nhất)
`npx vitest run` full + `npm run build` + `cargo check` desktop + build APK release arm64 + ký + cài emulator + smoke test (login đã có client, phát nhạc, download, back double, search expand) + gửi APK mới.
