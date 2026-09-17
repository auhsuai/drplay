# BÁO CÁO RECON — skeleton folder luồng move quá to so với folder thật

> Ngày: 2026-09-17 · Repo: E:\drplay · Người thực hiện: subagent RECON (chỉ đọc code)
> Phạm vi: điều tra + đề xuất; KHÔNG sửa code sản xuất.

## TL;DR
- **ĐÚNG** — nghi ngờ của user chính xác: trong lúc load danh sách folder của picker Move, mỗi item skeleton CAO HƠN RẤT NHIỀU so với folder card thật trên cửa sổ >= 1024px (3 cột).
- Nguyên nhân: `FolderGrid.tsx:51` truyền `containerClassName` có ` h-full auto-rows-fr`, còn grid thật (`FolderGrid.tsx:66` và `:100`) **không có** 2 class này. `auto-rows-fr` = `grid-auto-rows:minmax(0,1fr)` (bằng chứng CSS đã build trong `dist/assets/index-BPpQO6tT.css`: `.auto-rows-fr{grid-auto-rows:minmax(0,1fr)}` + `.h-full{height:100%}`) -> 6 skeleton (2 hàng x 3 cột) bị kéo giãn chia đôi chiều cao vùng list (~75vh); mỗi hàng ~240px ở cửa sổ 1080p, so với card thật 80px -> cao gấp ~3 lần.
- Fix tối thiểu: xoá đúng ` h-full auto-rows-fr` khỏi `FolderGrid.tsx:51` (1 dòng) + cập nhật 1 test class-assert. KHÔNG đụng `Skeleton.tsx` (tránh ảnh hưởng HomeTab/Trash/MyDrive).

---

## 1. Luồng move

Có 3 entry point cùng render `FolderSelectionScreen` (1 screen duy nhất cho mọi picker):

| Entry point | File:line | Cơ chế |
|---|---|---|
| Per-row (menu ...) | `src/ui/components/MoreMenu.tsx:136` (destructure hook) + portal tại `MoreMenu.tsx:453-481` | Menu item "Move to..." (`src/ui/components/MoreMenu/DefaultMenuItems.tsx:101`, label `drive.move_to`) -> `setShowMoveScreen(true)`; state ở `src/ui/components/MoreMenu/useMenuMove.ts:35`; chọn đích -> `handleMove` (`useMenuMove.ts:38-93`) |
| Bulk move (selection toolbar) | `src/ui/MainContent/MainContent.tsx:161-163` (`handleBulkMoveClick`) + render `MainContent.tsx:200-216` | state `showBulkMoveScreen`; đích đến -> `explorer.handleBulkMove` -> `src/hooks/useDriveBulkOps.ts:193-274` |
| First-run setup gate | `src/ui/FolderSelectionGate.tsx:31` | cùng screen (không phải move nhưng dùng chung nên hưởng cùng fix) |

- Component hiển thị danh sách folder đích: `FolderSelectionScreen.tsx:339-348` render `<FolderGrid isLoading={...} ... />`.
- State loading: `isLoading` trong `src/ui/FolderSelection/useFolderPicker.ts:52` (khởi tạo `true`). Bật loading tại: `fetchFolders` (`useFolderPicker.ts:131`), `handleOpenFolder` (`:289`), `popFolderHistory` (`:314`), `navigateToParentFolder` (`:336`), `handleBreadcrumbClick` (`:417`, `:430`). Tắt tại `finally` của fetch (`useFolderPicker.ts:163-168`).
- Rẽ nhánh skeleton: `FolderGrid.tsx:42` — `isLoading && !isSearchingApi` -> render skeleton; hết load -> render `FolderCard` thật trong grid (`FolderGrid.tsx:66` hoặc `:100`).
- Tái dùng: `FolderGrid` (`src/ui/FolderSelection/FolderGrid.tsx`) + `FolderCard` (`src/ui/FolderSelection/FolderCard.tsx`) + skeleton chung `SkeletonRowList variant="folder"` (`src/ui/components/Skeleton.tsx:158-194`).

## 2. Skeleton hiện tại

`src/ui/FolderSelection/FolderGrid.tsx:47-53` (trích nguyên văn):

```tsx
<div role="status" aria-label={t("loading")} className="p-6 h-full">
  <SkeletonRowList
    rows={6}
    variant="folder"
    containerClassName="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 h-full auto-rows-fr"
  />
</div>
```

- Số item: **6** (`rows={6}`, `FolderGrid.tsx:49`).
- Container skeleton: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3` + `h-full auto-rows-fr` (`FolderGrid.tsx:51`).
- Row chrome (dùng chung theo `variant="folder"`), `Skeleton.tsx:128-134`:
  `folder: "flex items-center gap-4 p-4 bg-[#F8F9FA] dark:bg-[#202124] rounded-xl"` (`Skeleton.tsx:132`)
- Icon box: `"w-12 h-12 rounded-lg shrink-0 ring-1 ring-black/5 dark:ring-white/10"` (`Skeleton.tsx:145-146`) = 48px.
- Text lines: title `h-4 w-3/4` (`Skeleton.tsx:154`, 16px) + sub `h-3 w-1/3` (`Skeleton.tsx:168`, 12px), gap `space-y-1` 4px.
- **Chiều cao tự nhiên khi KHÔNG bị stretch** = p-4 (16x2 = 32) + max(icon 48, title 16 + 4 + sub 12 = 32) = **80px** (trùng khít FolderCard).
- **Nhưng** container có `h-full auto-rows-fr`: grid là con của `div role="status" p-6 h-full` nằm trong `FolderGrid` root `flex-1` của dialog `h-[75vh] flex-col` (`FolderSelectionScreen.tsx:271`), nên `h-full` resolve; `grid-auto-rows:minmax(0,1fr)` kéo mỗi hàng grid giãn chia nhau chiều cao vùng list. Với 3 cột -> 6 item = 2 hàng -> mỗi hàng = `(H_grid - 12)/2`.

## 3. Folder card thật

- Card: `src/ui/FolderSelection/FolderCard.tsx:24` (trích nguyên văn):
  `className="p-4 rounded-xl bg-[#F8F9FA] dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f] hover:shadow-md hover:-translate-y-1 transition-all duration-300 cursor-pointer group flex items-center gap-4"`
- Icon `w-12 h-12` (48px) tại `FolderCard.tsx:26`; text: h3 `text-base` (line-height 24px) + p `text-xs` (16px).
- Container grid thật: `FolderGrid.tsx:66` (nhánh search) và `FolderGrid.tsx:100` (nhánh thường):
  `className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"` — **KHÔNG có `h-full`, KHÔNG có `auto-rows-fr`**.
- Quy đổi px: card cao = 32 (p-4) + 48 (icon) = **80px**. Rộng tại lg = (dialog `max-w-3xl` 768px - p-6x2 48px - gap 12x2)/3 = **232px**.
- Skeleton row tự nhiên cũng 232px x 80px (row chrome copy verbatim FolderCard, xem comment `Skeleton.tsx:120-127`).

## 4. Kết luận mức chênh

Chênh lệch nằm ở CHIỀU CAO (rộng bằng nhau vì cùng grid columns/gap). Grid auto-rows 1fr chia đôi chiều cao vùng list nên hàng skeleton phình theo cửa sổ:

Công thức tại >= 1024px (3 cột, 2 hàng): `row = (0.75 * H_window - 330) / 2` px.

| Chiều cao cửa sổ H | Skeleton row (tính toán) | FolderCard thật | Tỉ lệ |
|---|---|---|---|
| 768px  | ~123px | 80px | 1.5x |
| 900px  | ~173px | 80px | 2.2x |
| 1080px | ~240px | 80px | **3.0x** |
| 1440px | ~375px | 80px | **4.7x** |

Trong đó hằng số 330 = 12 (gap) + 318 (vùng grid sau khi trừ chrome dialog ~222px + p-6 của FolderGrid 48px + p-6 của wrapper status 48px). Chrome ước lượng từ class Tailwind: header `px-6 py-5` + h1 `text-xl` (28) + subtitle `text-xs mt-1` (20) = 88px; toolbar `px-6 py-3` + input `py-2 text-sm` + border = 62px; footer `px-6 py-4` + button `py-2.5 text-sm` = 72px (các file: `FolderSelectionScreen.tsx:274`, `:310`, `:351`; `FolderSearchInput.tsx:27`). Sai số vài px không đổi kết luận.

- Tại breakpoint sm (2 cột, 3 hàng) chênh giảm (~1.4-2x); tại mobile 1 cột hàng skeleton bị bóp NHỎ hơn card thật (~37px ở H=800) — cũng sai nhưng ngược hướng.
- Đúng như user quan sát: "to hơn rất nhiều" = cao gấp ~3 lần trên desktop chuẩn.

## 5. Nguyên nhân + phạm vi ảnh hưởng

- Nguồn gốc: commit `76fc6b6` "feat(ui): skeleton loading for HomeTab, My Drive, Trash and folder picker" (`git show 76fc6b6:src/ui/FolderSelection/FolderSelectionScreen.tsx`, dòng 360) đã có `containerClassName="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 h-full auto-rows-fr"`; commit split module `064a1d8` chuyển nguyên văn sang `FolderGrid.tsx:51` (`git log -S "auto-rows-fr"` xác nhận 2 commit này).
- Ý đồ ghi trong comment `FolderGrid.tsx:43-46`: "fills the whole region instead of leaving a blank band (RC-C)" — muốn skeleton phủ kín vùng list. Nhưng với list dạng GRID nhiều cột, `auto-rows-fr` kéo giãn TỪNG HÀNG thay vì chỉ phủ nền -> méo kích thước item.
- `SkeletonRowList` là component dùng chung, các chỗ render:
  - `FolderGrid.tsx:48` — variant folder + container `... h-full auto-rows-fr` -> **BUG**.
  - `HomeTab.tsx:219-223` — variant folder + container `grid grid-cols-2 md:grid-cols-4 gap-4` (không h-full/auto-rows) -> không bị.
  - `TrashScreen.tsx:325-330` — variant trash + `stretch` + container `flex flex-col gap-2 h-full` -> hàng cũng giãn (chủ ý RC-C cho list 1 cột), ngoài scope.
  - `MainContent.tsx:286` — variant audio + `stretch className="flex-1"` cho MyDrive -> ngoài scope.
- Vì fix chỉ sửa containerClassName tại `FolderGrid.tsx:51` nên ảnh hưởng đúng phạm vi picker folder: per-row move, bulk move, setup gate. `Skeleton.tsx` giữ nguyên -> HomeTab/Trash/MainContent không đổi.

## 6. Fix tối thiểu đề xuất

File duy nhất: `src/ui/FolderSelection/FolderGrid.tsx`, dòng 51.

- Trước: `containerClassName="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 h-full auto-rows-fr"`
- Sau: `containerClassName="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"`

Tức xoá đúng cụm ` h-full auto-rows-fr` — class còn lại trùng khít grid thật tại `FolderGrid.tsx:66` và `FolderGrid.tsx:100`. Kết quả: mỗi skeleton row = 80px = FolderCard thật (row chrome đã copy đúng p-4/gap-4/w-12 h-4 h-3).

- Wrapper `<div role="status" className="p-6 h-full">` (`FolderGrid.tsx:47`) giữ nguyên không sao (không còn kéo giãn con); muốn sạch có thể bỏ `h-full` ở wrapper nhưng không bắt buộc.
- Nên cập nhật comment `FolderGrid.tsx:43-46` (đang nói h-full/stretch) cho khỏi stale.
- KHÔNG cần tạo size chung/hằng số. (Tùy chọn refactor ngoài scope: export 1 hằng `FOLDER_GRID_CLASS` dùng cho cả skeleton + grid thật để chống lệch lại — chỉ làm nếu user muốn.)

## 7. Tests cần sửa

Test đang assert đúng class sai:
- `src/ui/FolderSelection/FolderSelectionScreen.test.tsx:381-407` — test "grid: the loading skeleton mirrors the real folder grid (3-col, h-full, auto-rows-fr)":
  - `:404` `expect(container.className).toContain("auto-rows-fr")` -> XOÁ.
  - `:405` `expect(container.className).toContain("h-full")` (trên container grid) -> XOÁ hoặc đảo thành `not.toContain`.
  - `:390` assert status region `h-full` -> giữ nếu wrapper giữ nguyên.
  - `:393-395` comment stale trỏ `FolderSelectionScreen.tsx:393` -> sửa thành `FolderGrid.tsx:66/:100`; đổi tên test bỏ "(3-col, h-full, auto-rows-fr)".
- Các test skeleton khác trong file (`:287-345`, `:347-379`, `:597-719`) chỉ đếm/không assert container class -> không phải sửa.
- `src/ui/components/Skeleton.test.tsx:89-213` — assert row chrome theo variant (p-4, gap-4, w-12 h-12, đủ 2 dòng). Không assert containerClassName -> không phải sửa nếu chỉ đổi container. (Nếu đụng ROW_CLASS thì phải chạy file này + test HomeTab.)
- `src/ui/MainContent/MainContent.windowing.test.tsx:436-457` — bulk move nhưng mock hẳn `FolderSelectionScreen` (`:65-70`) -> không ảnh hưởng.
- `src/ui/components/MoreMenu.test.tsx:783-868` — chỉ test hook `useMenuMove`, không render picker -> không ảnh hưởng.
- `src/ui/FolderSelection/FolderSelectionScreen.backspace.test.tsx` — keyboard, không assert skeleton.
- Grep toàn repo `auto-rows-fr`: chỉ có `FolderGrid.tsx:51` + test `:404`. Không còn test nào khác bám class này.

Mock setup cho sub fix (luồng move / FolderSelectionScreen):
- `react-i18next` mock resolve key thật từ `src/locales/en/translation.json` (`test:16-35`); `lucide-react` stub icons (`:37-49`).
- Mock `utils/driveApi` (listFolderChildren/searchFolders/getFileParents/getFileName), `utils/drivePagination`, `apiClient.getValidToken`, `utils/simpleToast`, `utils/errorLog` (`:51-75`).
- Mock `db/db` bằng chain Dexie giả (where/equals/filter/toArray) — KHÔNG cần fake-indexeddb (`:76-83`).
- Deferred promise cho `listFolderChildren` để ghim `isLoading=true` (`:93-103`, helper `renderScreen` `:133-142`). Đây là cách tái hiện skeleton: render + chờ `deferredCalls` có 1 phần tử là skeleton đang hiện.

## 8. Rủi ro/điểm mù

- jsdom không tính layout -> test chỉ verify class, KHÔNG bắt được "cao gấp 3 lần". Cần verify thị giác: dùng DEV trigger có sẵn Ctrl+Shift+D -> "Loading / MainContent" target `folders` (`FolderSelectionScreen.tsx:65-75`, set `debugForceLoading`) ở cửa sổ >= 1024px, chụp trước/sau. Hoặc thử Playwright nếu môi trường cho phép.
- Responsive: sau fix khớp ở mọi breakpoint; trước fix tại mobile 1 cột skeleton lại thấp hơn thật — fix giải quyết luôn cả 2 hướng.
- "Phủ kín vùng trống": sau fix skeleton chỉ cao bằng nội dung, chừa nền trắng phía dưới khi ít hàng — GIỐNG HỆT trạng thái đã load xong (grid thật cũng vậy), nên không phải regression thị giác; ngược lại là khớp hơn.
- Không nên sửa `Skeleton.tsx` (variant folder/stretch) vì `TrashScreen.tsx:325-330` và `MainContent.tsx:286` đang chủ ý dùng stretch/flex-1 (comment RC-C) — ngoài scope user hỏi, dễ gây regression màn khác.
- Số lượng: skeleton render 6 item, folder thật có thể ít/nhiều hơn — không nằm trong vấn đề kích thước đang báo, nhưng nếu fix xong vẫn thấy "khác" thì đây là lý do thứ hai (số hàng), không phải size từng item.
- Điểm mù chưa đo bằng browser thật: các con số px ở mục 4 là suy ra từ class Tailwind (line-height mặc định) + giả định chrome dialog; sub fix nên xác nhận nhanh bằng mắt/Playwright sau khi sửa.

---

## Phụ lục — Bằng chứng thô

- CSS build: `dist/assets/index-BPpQO6tT.css` chứa `.auto-rows-fr{grid-auto-rows:minmax(0,1fr)}` và `.h-full{height:100%}`.
- `FolderGrid.tsx:42-53` skeleton branch; `:51` là dòng chứa class gây lỗi.
- `FolderGrid.tsx:66` và `:100` real grid class (nguồn so sánh chuẩn).
- `FolderCard.tsx:24,26` card + icon thật.
- `Skeleton.tsx:128-134` ROW_CLASS; `:143-148` icon; `:152-156` text lines; `:158-194` SkeletonRowList.
- `FolderSelectionScreen.tsx:271` dialog `h-[75vh]`; `:339-348` truyền isLoading xuống FolderGrid.
- `useFolderPicker.ts:52` isLoading mặc định true; `:125-169` fetchFolders; `:163-168` finally tắt loading.
- Git: `76fc6b6` (nguồn class), `064a1d8` (split chuyển vào FolderGrid.tsx), `2de2035` (chỉ đổi empty state, không liên quan).