# VIDEO-PLAYER-UIUX-REPORT

Phase: Player UI/UX (true fullscreen · floating bar · auto-hide · unified menus)
Renderer: **không thay đổi** — vẫn libmpv Render API + DirectComposition + WebView2/React.

---

## 1. Current UI behavior before the change

| Hạng mục | Thực trạng trước đây (đã kiểm chứng bằng đọc code) |
|---|---|
| Fullscreen | **Giả.** `isPlayerFullscreen` chỉ đổi padding `p-0` vs `pt-14 px-3 pb-2` (`NowPlayingView.tsx:337-339`). Không có bất kỳ lệnh fullscreen nào tới Tauri/OS. |
| Player bar | Một **row layout thật** (`shrink-0 w-full`) nằm **dưới** video trong `flex flex-col` (`VideoPlayerBar.tsx:77`). |
| Auto-hide | Không tồn tại. |
| Nút thừa | `AudioLines` + `Subtitles` đứng riêng trong bar (`VideoPlayerBar.tsx:111-130`). |
| More / right-click | Cả hai đều là **Win32 native HMENU** (`nativeMenu.ts` → `show_context_menu` → `context_menu.rs:347`) — vi phạm yêu cầu "không dùng Windows stock menu". |
| Right-click | **Chết** trong renderer hiện tại: event `video-context-menu` chỉ do `video_host.rs:52` phát ra, mà HWND cũ không còn tồn tại dưới kiến trúc libmpv. |
| Hạ tầng DrPlay menu | **Đã có sẵn và đủ**: `MoreMenu.tsx` (portal + APG keyboard nav), `MoreMenuItem.tsx`, `menuPositioning.ts`, `PlaylistsSubmenu.tsx`, `menuFocus.ts`, `MENU_ITEM_BASE_CLASS`; tiền lệ pointer-anchor: `SongCard.tsx:237` (`forceOpen` + `anchorPoint`). |

## 2. Fullscreen implementation

- Gọi `setFullscreen` thật qua `@tauri-apps/api/window`, thêm capability `core:window:allow-set-fullscreen` + `core:window:allow-is-fullscreen` vào `src-tauri/capabilities/default.json`.
- Đồng bộ **hai chiều**: React → window, và window → React.
- **Phát hiện khi tra cứu**: Tauri v2 **không có** event đổi fullscreen. Đã xác minh trên `@tauri-apps/api` 2.11.1 (`window.d.ts` liệt kê event: `onCloseRequested`, `onDragDropEvent`, `onFocusChanged`, `onMoved`, `onResized`, `onScaleChanged`, `onThemeChanged`) và qua DuckDuckGo MCP + context7 (tauri#4519). Vì vậy window→React sync **đọc lại `isFullscreen()`** trên `onResized`/`onFocusChanged`/`onScaleChanged`; lần đọc đầu luôn báo cáo, các lần sau giá trị không đổi thì bỏ qua để không re-render theo cơn resize.
- Lỗi IPC: `captureError` (warn, chỉ module+action+error, không log token/PII) + toast cho người dùng, trả `false`, không throw.
- Không recreate engine, không reset playback khi vào/ra fullscreen.

## 3. Floating player-bar implementation

- Ở fullscreen, bar chuyển thành `absolute inset-x-0 bottom-0` **trong cùng cột `relative` sẵn có** → không còn `shrink-0`, tách khỏi flow.
- Cột video giữ nguyên chiều cao đầy đủ ⇒ bar **không còn chiếm không gian layout**.
- Chỉ có scrim `bg-black/60 backdrop-blur-sm` cho khả năng đọc trên nền sáng/tối, và `transition-opacity duration-200` (đúng ngôn ngữ animation ngắn sẵn có của app).
- Ẩn = `opacity-0 pointer-events-none` — **không** dùng `display:none`, không có vùng chặn chuột vô hình.
- **Normal window mode không đổi** (xác nhận runtime: bar vẫn `position: static`, nằm dưới video).
- Không nhân bản bar: presentation tách khỏi logic, một nguồn sự thật cho mọi player action.

## 4. Auto-hide và reveal state flow

Một hook duy nhất `src/player/useFullscreenChrome.ts` sở hữu toàn bộ chính sách:

```
ENTER FULLSCREEN → chromeVisible = true, arm timer 3000ms
      ↓
activity (pointermove / pointerdown / player command / open menu) → reveal + reset 3000ms
      ↓
menu mở  → clear timer, giữ hiện (suspend)
menu đóng → đếm lại 3000ms MỚI (không dùng phần dư)
      ↓
idle 3000ms → ẩn (opacity-0 + pointer-events-none)
      ↓
EXIT FULLSCREEN / unmount → clear timer + gỡ listener, reset state
```

- Hằng số `3000` có tên, **một timer duy nhất**, một owner.
- Auto-hide **chỉ chạy ở fullscreen**; normal mode không arm timer, không gắn listener.
- Trạng thái lưu dạng **phủ định** (`hidden`) và derive ra: `chromeVisible = !isFullscreen || !hidden` → rời fullscreen không thể để lại state cũ.
- **Coalesce chuột**: 50 event pointermove → đúng **1** `requestAnimationFrame`, 1 state update (có test assert).
- **Paused không giữ bar sáng**: `isPlaying` **không phải input** của hook → không thể vô tình ghim.
- Tích hợp command: `runPlayerCommand` gọi `ctx.onActivity?.()` **một lần, trước** khi dispatch ⇒ shortcut vẫn chạy **đúng một lần**, không nuốt/đôi/thay đổi lệnh.

## 5. Timer và event-listener cleanup

| Tình huống | Kết quả (test) |
|---|---|
| Rời fullscreen | `getTimerCount() === 0`; +30000ms không có callback nào chạy |
| 5 vòng enter/exit | 10 pointer add, tất cả đều remove, `getTimerCount() === 0` |
| Unmount | 0 timer, rAF đã cancel |
| Normal mode | 0 listener gắn, chuỗi class windowed **byte-identical** |
| Menu đóng bằng throw | `.finally()` → vẫn resume policy |

## 6. Removed redundant controls

Chỉ gỡ **2 nút** `AudioLines` + `Subtitles` khỏi `VideoPlayerBar` (mất luôn import). Giữ nguyên:
`VolumeSlider` + nút volume, `TransportControls`, title + `SeekBar`, nút fullscreen, nút More.
`VideoBarMenuSection` vẫn giữ `"audio"`/`"subtitle"`, menu entries và logic chọn track **không bị xóa** — chức năng vẫn truy cập qua More và right-click. Không thêm nút thay thế.

## 7. More menu integration

- Menu **không còn là native popup**: không còn `showContextMenu` / `invoke("show_context_menu")` trên đường video.
- `VideoMenu.tsx` render `menuModel.buildContextMenuModel("full", …)` bằng đúng primitive của app: `MoreMenuItem` làm item renderer, `MENU_ITEM_BASE_CLASS` cho row, `getContextMenuStyle`/`shouldOpenUpwards` cho positioning đã clamp, `useMoreMenuEvents` cho dismissal, `menuFocus` cho roving focus. Panel class **giống hệt** dropdown của `MoreMenu` (`w-60 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-lg p-1.5 … duration-200`).
- **`menuModel.ts` giữ nguyên làm nguồn sự thật duy nhất** — không viết lại định nghĩa item, không thêm icon field vào model. Icon resolve trong **một** map id→Lucide + map prefix, ngay trong `VideoMenu`.
- Submenu 3 tầng dùng open-chain (`[audio, audio-track]`), ArrowRight mở, ArrowLeft/Escape đóng từng cấp, tự mở sang trái khi sắp tràn mép phải.
- Có đánh dấu `checked` (ô tick), `disabled`, separator, `aria-haspopup`, `role=menuitem`/`menuitemcheckbox`.

## 8. Right-click menu integration

- `NowPlayingView.tsx:387` thêm `onContextMenu` trực tiếp trên vùng video: `preventDefault()` + `stopPropagation()`.
- Đây là **cùng một** component `VideoMenu` và cùng `useVideoMenu` hook như nút More; khác biệt duy nhất là **anchor** (`{kind:"point"}` vs `{kind:"button"}`).
- Không mở menu Windows, không menu trình duyệt (`useAppGlobalEvents.ts:39` đã chặn sẵn ở document, ta `preventDefault` thêm ở handler).
- **Không** tái tạo overlay nhập native nào — React sở hữu pointer input như thiết kế.
- Đường cũ `useVideoContextMenu` (listener Rust `video-context-menu`) **giữ nguyên trong cây** vì §17 cấm dọn code legacy.

## 9. Responsive và fullscreen-exit

- Menu clamp trong viewport qua `getContextMenuStyle`; flyout tự đảo chiều khi tràn mép phải (`right-full`).
- Rời fullscreen: cột video trở lại `p-0` → `pt-14 px-3 pb-2`, bar trở lại `position: static`. Timer + listener fullscreen bị hủy, state visibility được reset. Vòng lặp enter/exit idempotent (test 5 vòng).
- **Chưa verify runtime** ở cửa sổ hẹp — cần người dùng kiểm tra.

## 10. Automated test results

| Lệnh | Kết quả |
|---|---|
| `npx vitest run src/ui/NowPlaying src/player src/App.test.tsx` (Slice 1) | baseline **294 passed / 15 files** → sau: **326 passed / 17 files** |
| `npx vitest run src/player src/ui/NowPlaying src/ui/components` (Slice 2) | **565 passed / 31 files** |
| `npx tsc --noEmit` | **clean** (0 output) |
| `npx eslint` trên 13 + 8 file đã sửa | **0 error** (1 warning `react-hooks/exhaustive-deps` có sẵn ở `useMoreMenuEvents.ts:96`) |

RED→GREEN có bằng chứng log cho Slice 1 (VD: `expected 'w-full flex flex-nowrap items-center …' to contain 'absolute'`, `expected <button …> to be null`). **Slice 2 không có log RED→GREEN** vì subagent bị abort giữa chừng, mất report — đã bù bằng cách tự chạy lại toàn bộ gate ở trên (tsc + eslint + 565 test) và review code thật.

Không có test nào bị làm yếu; không sửa test ngoài phạm vi để đi xanh.

## 11. Actual runtime verification

Đã lái app thật qua CDP (`--remote-debugging-port=9222`, Node + WebSocket), **không** dùng synthetic click Win32.

**Các mục ĐÃ xác nhận runtime:**
- Normal mode: window 1024x768, video `y=56..695`, bar `position: static` `y=695 h=65` → layout cũ giữ nguyên.
- **2 nút thừa đã mất**: bar chỉ còn `Playback mode, Previous track, Play, Next track, Fullscreen video, More options`. Không có audio/subtitle.
- **Volume còn nguyên**: `volume-bar` hiện trong bar.
- **True fullscreen**: window `1024x768 → 1920x1080`; không có lỗi permission trong log.
- **Video lấp đầy fullscreen**: `video-area = 1920x1080 @ (0,0)`.
- **Bar float**: `position: absolute`, neo đáy `y=1015 h=65` → `1015+65 = 1080`.
- **Không dời layout**: `video-area` cao **1080** = trọn cửa sổ (không bị trừ 65px của bar).

**Các mục KHÔNG xác nhận được runtime:**
- **Video không hiển thị** → không thể xác nhận bằng mắt "video lấp đầy" hay "không còn dải đen". Xem mục 12.
- Auto-hide: thử bằng synthetic `pointermove` — `pointer-events` có phản ứng (`none`→`auto`, tức đường reveal **có** bắt event) nhưng `opacity` **không bao giờ xuống 0** trong 3.4s idle. Test không kết luận được; cần kiểm bằng mắt.
- Mở menu (More/right-click), submenu, phím tắt, fullscreen lặp lại, cửa sổ hẹp: **chưa** xác nhận runtime (chỉ có test).

## 12. Remaining limitations

1. **BLOCKER — không có video, chỉ có tiếng.** Log mpv:
   ```
   ffmpeg/video: av1: Your platform doesn't support hardware accelerated AV1 decoding
   ffmpeg/video: h264: Failed setup for format cuda: hwaccel initialisation returned error
   ffmpeg/video: h264: no frame!
   ```
   `hwdec=auto-safe` chọn **cuda** nhưng khởi tạo thất bại → **0 frame giải mã**. Đây là vấn đề **engine/hardware-decoding có sẵn, không do thay đổi UI/UX này**, và §2 cấm đổi hwdec nên **chưa sửa**. Cần một task riêng.
2. Báo cáo của subagent Slice 2 bị mất khi tool abort → không có log RED→GREEN cho menu; đã tự verify lại bằng gate chạy thật.
3. Các mục runtime ở mục 11 chưa xác nhận cần người dùng kiểm bằng mắt.
4. Scrim `bg-black/60 backdrop-blur-sm` là lựa chọn phán đoán, chưa nhìn thấy bằng mắt trên footage sáng.
5. `onFocusChanged`/`onScaleChanged` là trigger dự phòng, chưa chứng minh là cần thiết trên Windows.

---

## Verdicts

| # | Hạng mục | Kết quả |
|---|---|---|
| 1 | True fullscreen | **PASS** (runtime: 1024x768→1920x1080) |
| 2 | Floating player bar | **PASS** (runtime: absolute, neo đáy) |
| 3 | No layout shift | **PASS** (runtime: video-area 1080 = trọn cửa sổ) |
| 4 | Auto-hide ~3s | **NOT CONFIRMED** (test pass; runtime opacity không xuống 0 khi idle) |
| 5 | Mouse reveal | **PARTIAL** (runtime `pointer-events` phản ứng đúng; chưa quan sất bằng mắt) |
| 6 | Keyboard reveal | **PASS (unit)** — chưa runtime |
| 7 | Keyboard command chạy đúng 1 lần | **PASS (unit)** — chưa runtime |
| 8 | Redundant audio button removed | **PASS** (runtime) |
| 9 | Redundant subtitle button removed | **PASS** (runtime) |
| 10 | Volume controls retained | **PASS** (runtime) |
| 11 | More menu dùng DrPlay design | **PASS (code)** — chưa mở thử runtime |
| 12 | Right-click dùng custom DrPlay menu | **PASS (code)** — chưa mở thử runtime |
| 13 | More và right-click dùng chung hạ tầng | **PASS** (cùng component + hook + `menuModel`) |
| 14 | Audio-player layout unchanged | **PASS** (test AUDIO byte-identical) |
| 15 | Không tái tạo native overlay | **PASS** (không HWND/Rust mới) |
| 16 | No rendering-engine regression | **NOT CONFIRMED** — video 0 frame do hwdec cuda (mục 12.1), không do slice này |
| 17 | No timer/listener leak | **PASS (unit)** — chưa runtime |
| 18 | Runtime verified | **PARTIAL** — 7/18 mục PASS runtime, phần còn lại chưa |