# NOWPLAYING-VISUAL-POLISH-REPORT

Phase: NowPlaying visual polish — solid black empty state · smooth collapse · intentional hidden-video state.
Renderer: **không đổi** — libmpv Render API + DirectComposition + WebView2/React.

> **Phương pháp verify**: lần chạy subagent bị abort giữa chừng nên **mất log RED→GREEN gốc**. Báo cáo này dựa trên **code review trực tiếp + chạy lại toàn bộ gate** (tsc / eslint / vitest / cargo). Các mục cần pixel video thật **không thể** verify trên máy này (xem §9).

---

## 1. Root cause — HomeTab lọt qua nền

Chuỗi nguyên nhân, xác nhận từ code:

1. `src/App.css` có luật trong suốt theo class `<html>.drplay-host-visible`: `html`, `body`, `.drplay-host-clear` (chính overlay NowPlaying), `aside`, `#content-area`, và `#content-area *` đều bị ép `background-color: transparent`.
2. Class đó do `VideoSurface` bật theo `active` = `shouldShowVideoHost(...)` (`src/lib/videoHost.ts`), mà hàm này chỉ cần `hasTrack && isVideo && isOpen ...` — **bật ngay khi track được CHỌN, trước khi mpv có frame nào**.
3. Trong cửa sổ đó, `drplay-player-bg` cũng bị khoét lỗ trong suốt tại rect video (`HOST_HOLE_CLIP_PATH`), mà chưa có pixel nào ở đó ⇒ toàn bộ tầng HomeTab phía sau lộ ra.
4. Trạng thái "không có media" lại còn vẽ `bg-gray-100 dark:bg-[#121212]` — xám ở light mode, **không phải đen**.

Trước đây **không có tín hiệu "frame đầu tiên"** nào từ Rust → React, nên app không có cách nào phân biệt "đã chọn track" với "đã có frame dùng được". Đây là gốc rễ thật.

## 2. Black empty-state implementation

Ba trạng thái, không có trạng thái trung gian (`VideoSurface.tsx:363-382`):

| Trạng thái | Paint |
|---|---|
| host ẩn | gradient placeholder cũ (không đổi) |
| host hiện, **chưa có frame** | `bg-black` — đục hoàn toàn |
| host hiện, **đã có frame** | không vẽ gì → DComp visual hiện xuyên qua |

- Empty state (`!currentTrack`): `<main className="flex-1 bg-black …">` (`NowPlayingView.tsx:237`) — `bg-gray-100` đã bị bỏ.
- Cổng khoét lỗ tách riêng: `const videoReady = showVideoHost && hasVideoFrame` (`NowPlayingView.tsx:189`); `clipPath` chỉ gắn khi `videoReady` (`:304-307`). ⇒ Chưa có frame thì **không khoét lỗ**, nền vẫn đục.
- Không fake frame, không test pattern, không loading image, không đổi init engine. Không đụng vào độ trong suốt toàn cục (`[0,0,0,0]`, App.css, `shouldShowVideoHost`).

### Tín hiệu first-frame (thay đổi Rust duy nhất, tối thiểu)
- `render/mod.rs`: event một-lần `video-first-frame`, cờ `first_frame_emitted: AtomicBool`, guard `take_first_frame_signal()` bằng `swap`.
- **Chỉ phát khi `outcome.presented == true`** (`mod.rs:1382-1390`) — mà `presented:true` chỉ đạt được khi mpv báo có frame mới (`MPV_RENDER_UPDATE_FRAME`) **và** render + present + unlock đều `Ok`; mọi lỗi trả `presented:false`. ⇒ Đúng nghĩa "frame dùng được", **không** phải "renderer đã init" hay "đã gọi Present".
- Re-arm mỗi `loadfile` (`engine.rs:503`), reset khi surface được (tái)tạo (`mod.rs:470`) ⇒ không bao giờ hụt tín hiệu cho item mới.
- Frontend `useVideoFirstFrame.ts`: reset theo `mediaKey` **ngay trong render** (không phải trong effect) ⇒ frame cũ không thể lộ 1 frame dưới danh nghĩa item mới; bỏ qua tín hiệu race; có `captureError` khi listen fail.

## 3. Root cause — collapse bị giật

Chẩn đoán từ code: overlay đóng bằng
`transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]`.

Tailwind v4 dịch `transition-transform` thành **`transform, translate, scale, rotate`** — tức là animate 4 property, trong đó chỉ `translate` thực sự đổi — trong **500 ms**, cộng thêm một bộ easing tuỳ biến. Đây là nguyên nhân được chứng minh: chuyển động dài gấp ~2.5 lần mức hợp lý cho một slide UI, trên một container `fixed inset-0` toàn màn hình.

## 4. Collapse/expand transition changes

`NowPlayingOverlay.tsx`:

```
- transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]
+ transition-[translate] duration-200 ease-out motion-reduce:transition-none
```

- **Đúng 1 property** (`translate`) thay vì 4.
- **200 ms** — nằm trong khoảng mục tiêu 180–250 ms.
- `motion-reduce:transition-none` cho người bật reduced-motion.
- Không animate width/height/position/opacity cùng lúc.

## 5. Hidden-video state behavior

- Trong lúc collapse: `isOpen=false` → `showVideoHost=false` → cổng lỗ đóng lại ngay, `VideoSurface` chuyển sang gradient placeholder, class `drplay-host-visible` được gỡ trong cùng commit ⇒ HomeTab trở lại đục ngay khi bắt đầu lộ ra, không có khe trong suốt.
- Host DComp được ẩn ngay frame đầu của transition (không có grace period). **Đây là ràng buộc kiến trúc, không phải lỗi bỏ sót**: video chỉ hiển thị được khi cả trang trong suốt, còn HomeTab chỉ render đúng khi trang đục — hai điều kiện loại trừ nhau trong cùng một khung hình. Giữ video trượt ra sẽ buộc HomeTab hiện trong suốt. Xem §9.
- Collapse **không** đổi trạng thái playback (không stop / close / unload / pause) — không có thay đổi nào như vậy trong diff.
- Regression guard: transition loop trong `VideoSurface` vẫn gửi lại rect mỗi frame khi có translate (đúng cho chiều **expand** — panel đen/video trượt lên cùng nhau, video đi theo rect).

## 6. Fullscreen regression

Không có thay đổi nào chạm vào đường fullscreen trong task này. Các bất biến đã verify ở task trước vẫn nguyên trong code:

- `useFullscreenChrome.ts` — một timer 3000 ms, một owner, clear khi exit/unmount.
- Overlay fullscreen: bar `position: absolute` neo đáy; `video-area` cao bằng trọn cửa sổ (không trừ 65 px).
- Nút fullscreen trên bar + `f` + menu vẫn còn (assert bởi `VideoPlayerBar.test.tsx:194,205`, `commands.test.ts:125`, `menuModel.test.ts:308`).
- **Chưa chạy runtime lần này** — không claim.

## 7. Runtime verification evidence

**Không chạy trong session này** (subagent bị abort; người dùng yêu cầu bỏ qua script runtime).

Bằng chứng runtime từ CSS/DOM đã đo được trước đó vẫn còn giá trị tham chiếu cho layout bar/fullscreen, nhưng **các mục dưới đây KHÔNG được verify runtime cho task này**:

- Nền đen khi mở NowPlaying không media.
- Không bleed-through khi track đã chọn nhưng chưa có frame.
- Độ mượt collapse/expand nhìn bằng mắt.
- Không còn dư không gian layout sau collapse.

## 8. Automated test results

| Lệnh | Kết quả thật |
|---|---|
| `npx tsc --noEmit` | **clean** |
| `npx eslint` trên các file đụng | **0 errors** |
| `npx vitest run src/ui/NowPlaying src/player src/App.test.tsx src/App.hostTransparency.test.ts` | **21 files / 372 tests passed** (trước task: 17 files / 326) |
| `cargo test --no-default-features` | **236 passed, 0 failed, 15 ignored** |
| doctest `src/player/render/composition.rs:25` | **FAIL — PRE-EXISTING**. Doc-comment module-level chứa khối ASCII thụt lề nên rustdoc cố biên dịch (`expected one of '!' or '::', found '='`). File này **không thuộc task**, không bị sửa. |

Test mới của task: `NowPlayingView.videoBackdrop.test.tsx` — **10 test**, phủ: empty state đen · track đã chọn chưa frame (đen + KHÔNG khoét lỗ) · có frame thì mở lỗ + bỏ đen · đổi media reset (không lộ frame cũ) · audio không dính backdrop/lỗ · listener được gỡ khi surface biến mất.

Đường thoát sau khi xoá chevron được assert bởi `useNowPlayingShortcuts.test.ts` (Escape đóng overlay; Escape trong fullscreen peel 1 lớp trước) + registry `f`.

**Thiếu**: log RED→GREEN gốc của task (mất khi abort). Gate đã được chạy lại đầy đủ nhưng đó là **GREEN-only**, không phải bằng chứng đỏ→xanh.

## 9. Remaining limitations

1. **Không pixel-verify được trên máy này**: hardware decode hỏng (`h264: Failed setup for format cuda: hwaccel initialisation returned error`, `h264: no frame!`, AV1 không hỗ trợ) ⇒ **0 frame giải mã**. Pre-existing, ngoài phạm vi (§2 cấm đổi hwdec). Mọi check cần pixel video thật → **NOT TESTED**.
2. **Red→Green gốc bị mất** — chỉ còn GREEN.
3. **Collapse ẩn video ngay frame đầu** (§5). Có thể làm "video trượt ra" chỉ bằng cách phá tính đục của HomeTab — nên để nguyên. Nếu muốn khác, cần bàn lại semantics.
4. Trong lúc collapse, surface hiển thị **gradient placeholder** (look "chưa chọn media") chứ không phải đen. Có thể đổi thành đen trong 1 dòng nếu muốn cảm giác "đóng video" hơn — chưa làm vì chưa có bằng chứng runtime rằng nó gây khó chịu.
5. `onFocusChanged`/`onScaleChanged` (từ task trước) vẫn là trigger dự phòng chưa chứng minh cần thiết trên Windows.

---

## Verdicts

| # | Hạng mục | Kết quả |
|---|---|---|
| 1 | Empty NowPlaying background | **PASS (code)** — `bg-black` khi không media; chưa runtime |
| 2 | No HomeTab bleed-through | **PASS (code)** — lỗ chỉ khoét khi `videoReady`; chưa runtime |
| 3 | No stale frame during media changes | **PASS (code+test)** — reset theo `mediaKey` trong render + re-arm Rust |
| 4 | Smooth collapse | **PASS (code)** — translate-only 200ms ease-out; chưa quan sát bằng mắt |
| 5 | Smooth expand | **PASS (code)** — cùng cơ chế; chưa quan sát bằng mắt |
| 6 | No leftover layout space | **NOT TESTED** — cần runtime |
| 7 | Correct hidden-video behavior | **PASS (code)** — không khe trong suốt; xem §9.3 |
| 8 | Correct playback state preservation | **PASS** — collapse không đổi playback state |
| 9 | Fullscreen bar behavior preserved | **PASS (code+test)** — không đụng; chưa runtime lần này |
| 10 | Bottom controls unchanged | **PASS (test)** — full set assert; 2 nút audio/subtitle vẫn đã xoá |
| 11 | No engine/rendering regression | **NOT TESTED** — 0 frame do hwdec cuda pre-existing, không do slice này |
| 12 | Runtime verified | **FAIL** — không chạy runtime trong session này |