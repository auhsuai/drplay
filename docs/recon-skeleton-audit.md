# BÁO CÁO AUDIT — skeleton sai kích thước toàn repo

- Repo: `E:\drplay` (Tauri + React 19 + TS + Tailwind 4). Ngày audit: 2026-09-17.
- Phạm vi: chỉ ĐỌC `src/`; working tree đang có thay đổi uncommitted của task khác — không revert, không đụng.
- Phương pháp: grep `Skeleton|animate-pulse|shimmer|isLoading|loading|placeholder` → đọc từng call site + item thật render cùng grid/list cha; quy đổi Tailwind 1u = 4px. KHÔNG đo bằng browser thật (xem mục 4 — điểm mù).
- Xác nhận bug vừa fix: `auto-rows-fr` KHÔNG còn trong code sản xuất — chỉ còn trong comment `FolderGrid.tsx:44` + assertion test `FolderSelectionScreen.test.tsx:406`. FolderGrid hiện sạch.

## TL;DR
- **[BUG rõ] = 1**: TrashScreen skeleton dùng `stretch` (`flex-1` rows trong container `h-full`) → hàng skeleton bị kéo cao hơn hàng thật 64px, lên tới **~2x trên màn 1440p** (cùng class bug với FolderGrid vừa fix, chỉ khác cơ chế `flex-1` thay vì `auto-rows-fr`).
- **[NGHI VẤN] = 2**:
  - F2: Home `SkeletonCardGrid` khối text thấp hơn thật 16px/card (gap cover→text 8px vs `mb-4` 16px) + card cuối "View all" thật không có text nhưng skeleton vẫn vẽ 2 dòng.
  - F3: FolderGrid skeleton bị **double padding** `p-6` (wrapper nằm trong root đã `p-6`) → card hẹp hơn thật 48/cols px (~7-8%), chiều cao đúng.
- **[OK] = phần còn lại**: MainContent (hàng 72px = SongCard thật), Jump Back In (lệch dung sai 4px đã ghi nhận trong code), CacheManagerModal (khớp), FolderGrid (đã fix), greeting/section title bars (lệch 4px chấp nhận). Các màn không có skeleton: LikedSongs, PlaylistView, QueuePanel/QueueList, NowPlaying, Sidebar/StorageQuotaCard, FullRecentView, AppShell (spinner Suspense), ErrorLogSection (text), Login (spinner nút).

## 1. Danh sách usage skeleton ĐẦY ĐỦ

| # | file:line | Variant/Component | Dùng ở đâu |
|---|---|---|---|
| 1 | `src/ui/components/Skeleton.tsx:23` / `:45` / `:74` / `:158` | Định nghĩa `Skeleton` / `SkeletonText` / `SkeletonCardGrid` / `SkeletonRowList` (variant audio/folder/trash) | — (SkeletonText chỉ có trong test, không dùng sản xuất) |
| 2 | `src/ui/HomeTab/HomeTab.tsx:137-140` | `Skeleton` base: `h-8 w-64`, `h-4 w-40` | Greeting header khi `recent === null` |
| 3 | `HomeTab.tsx:156-160` | `Skeleton` (`h-4 w-32 mb-4`) + `SkeletonCardGrid rows=1 cols=visibleCount` | Quick Access / Recent Files loading |
| 4 | `HomeTab.tsx:182-186` | `SkeletonCardGrid rows=1 cols=visibleCount` | Recently Added loading |
| 5 | `HomeTab.tsx:216-224` | `SkeletonRowList rows=4 variant="folder" containerClassName="grid grid-cols-2 md:grid-cols-4 gap-4"` | Jump Back In loading |
| 6 | `HomeTab.tsx:240-244` | `SkeletonCardGrid` | Heavy Rotation loading |
| 7 | `HomeTab.tsx:252-256` | `SkeletonCardGrid` | Discover loading |
| 8 | `src/ui/MainContent/MainContent.tsx:278-287` | `SkeletonRowList` variant mặc định `audio`, `rows=useSkeletonRows()`, `stretch`, `className="flex-1"` | MyDrive file list loading (search results dùng chung list này) |
| 9 | `src/ui/Settings/TrashScreen.tsx:320-331` | `SkeletonRowList rows=6 variant="trash" stretch containerClassName="flex flex-col gap-2 h-full"` | Trash list loading |
| 10 | `src/ui/FolderSelection/FolderGrid.tsx:42-52` | `SkeletonRowList rows=6 variant="folder" containerClassName="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"` | Folder picker loading (đã fix — xác nhận sạch) |
| 11 | `src/ui/Settings/components/CacheManagerModal.tsx:225-242` | Custom `animate-pulse w-14 h-3.5` (không dùng Skeleton.tsx) | Cột size mỗi category khi `sizes[id] === null` |
| 12 | `src/ui/layouts/AppShell.tsx:107-119` | Suspense fallback `LoaderCircle h-10 w-10` (spinner, không phải skeleton) | Lazy tab chunk chưa load |
| 13 | `src/ui/Login/LoginScreen.tsx:131-132` | `LoaderCircle w-6 h-6 animate-spin` trong nút Google | Đang login |
| 14 | `src/ui/Settings/components/ErrorLogSection.tsx:227-229` | Text `t("loading")` (không phải skeleton) | `logs === undefined` |
| 15 | Spinner lẻ (không phải skeleton, chỉ liệt kê): `TrashItemRow.tsx:88-92` (LoaderCircle w-3.5 thay RefreshCw w-3.5), `TrashScreen.tsx:416,432,462`, `MoreMenu/MoreMenuTrigger.tsx:51-52`, `DownloadDialog.tsx:138-139`, `DeleteConfirmDialog.tsx:109`, `TransportControls.tsx:63-64`, `NowPlayingControls.tsx:69-70`, `DefaultMenuItems.tsx:78` | — | Trạng thái đang xử lý |
| 16 | `SkeletonRowList` default `rows=8` | — | Không call site sản xuất nào dùng default (mọi call site đều truyền `rows`) — chỉ test |

Không có skeleton (đã kiểm tra bằng grep, "không áp dụng"): `LikedSongs.tsx` (không có loading UI), `PlaylistView.tsx:53-56` (render nothing khi loading), `QueuePanel.tsx`/`QueueList.tsx`/`QueueRow.tsx`, `NowPlayingView.tsx`/`NowPlayingOverlay.tsx` (chỉ spinner nút play), `StorageQuotaCard.tsx:117-149` (chỉ render khi quota có sẵn), `FullRecentView.tsx`, `Sidebar.tsx`/`PlaylistSection.tsx`, `HomeSection.tsx:49-55` (chỉ là wrapper layout).

## 2. Findings

### F1: [BUG rõ] TrashScreen — skeleton rows bị stretch to hơn hàng thật (tới ~2x)
- **Skeleton**: `src/ui/Settings/TrashScreen.tsx:324-330` — wrapper `p-4 h-full`, list `flex flex-col gap-2 h-full` + prop `stretch` → mỗi row nhận `flex-1`; chrome row trash = `p-3` (12px×2) + icon `w-10 h-10` (40px) → tối thiểu 64px NHƯNG bị chia đều chiều cao vùng.
- **Item thật**: `src/ui/Settings/TrashItemRow.tsx:35` (`p-3 … rounded-xl`), icon `w-10 h-10` tại `:64-72` → **64px cố định**; list thật `TrashScreen.tsx:340` (`flex flex-col gap-2`, không stretch), item render `:386-396`.
- **Lệch** — dialog `h-[70vh]` (`TrashScreen.tsx:275`), header ≈86px (`px-6 py-5` + icon 40), footer ≈72px (`px-6 py-4` + button 40), list `p-4`, wrapper `p-4`, 6 rows × gap-2 (8px) → row = `(0.7×V − 230) / 6`:
  - V=900: 66,7px (1,04x — gần đúng)
  - V=1080: 87,7px (**1,37x**)
  - V=1200: 101,7px (**1,59x**)
  - V=1440: 129,7px (**2,03x**)
  - V=768: công thức 51,3px < min-content 64px → flex không co được (min-height:auto) → hàng giữ 64px nhưng tổng 424px > vùng ~276px → skeleton bị scroll/cắt hàng cuối.
  - Ngang: double `p-4` (list + wrapper) → hàng skeleton rộng 608px vs hàng thật 640px trên dialog `max-w-2xl` (**−32px ≈ −5%**).
- **Bản chất**: cùng cơ chế với bug FolderGrid vừa fix — container có chiều cao xác định + row `flex-1` chia đều chiều cao thay vì giữ cao cố định 64px. Khác là `flex-1` thay vì `auto-rows-fr`.
- **Fix đề xuất tối thiểu (chỉ call site, KHÔNG đụng Skeleton.tsx)**:
  - `TrashScreen.tsx:324`: `className="p-4 h-full"` → `className="h-full"` (bỏ double padding; giữ `h-full` để test hiện có vẫn đọc được).
  - `TrashScreen.tsx:325-330`: bỏ `stretch`; `containerClassName="flex flex-col gap-2 h-full"` → `"flex flex-col gap-2"`.
  - Kết quả: rows = 64px, gap 8px = khớp hàng thật. Màn rất cao sẽ có band trống dưới — đúng như triết lý fix FolderGrid (band trống cũng xuất hiện khi list thật ít item).
  - Phương án B (giữ fill): cần tính `rows` theo chiều cao vùng đo runtime để mỗi row ≈64px — không còn là "fix 1 class", không đề xuất.
- **Test bị ảnh hưởng**: `src/ui/Settings/TrashScreen.test.tsx:217-239` (assert `h-full` wrapper + từng row `flex-1` và container `h-full`) — phải cập nhật assertion theo class mới. Các test `:141-149`, `:188-215` dùng testid/số lượng, không đổi.
- **Rủi ro dùng chung**: prop `stretch` vẫn được `MainContent.tsx:286` dùng; chỉ sửa call site TrashScreen nên không ảnh hưởng màn khác. `Skeleton.test.tsx:171-182,215-252` test prop `stretch` của component — không đổi vì không sửa `Skeleton.tsx`.

### F2: [NGHI VẤN — lệch nhỏ, skeleton NHỎ hơn thật] Home `SkeletonCardGrid` — khối text thấp hơn thật 16px/card
- **Skeleton**: `src/ui/components/Skeleton.tsx:82-92` — card `flex flex-col gap-2` (8px) + khối text `space-y-1.5` (6px) + bar `h-3.5` (14px) + `h-3` (12px) → khối dưới cover = 40px.
- **Item thật**: `src/ui/HomeTab/components/PremiumCard.tsx:83-85` cover `aspect-square … mb-4` (**16px**) + `:116-123` title `text-sm` (line-height 20px) + `mb-1` (4px) + artist `text-xs` (line-height 16px) → khối dưới cover = **56px**.
- **Lệch**: skeleton thấp hơn **16px/card** = gap cover→text 8 vs 16 (−8) + khối text 32 vs 40 (−8). Trên card 5 cột (~250px) ≈ **−6%**; card thấp hơn chút ít khi load xong section nhảy nhẹ.
- **Phụ**: card cuối khi `isOverlayBtn` ("View all") thật KHÔNG render khối text (`PremiumCard.tsx:115-124`), skeleton vẫn luôn vẽ 2 dòng.
- **Fix đề xuất tối thiểu (1 class)**: `Skeleton.tsx:85` `className="flex flex-col gap-2"` → `className="flex flex-col gap-4"` (khớp `mb-4`; lệch còn 8px do bar mảnh hơn line-height thật — chấp nhận). Muốn khớp card overlay cần thêm prop `showText` — không tối thiểu, cân nhắc bỏ qua.
- **Test bị ảnh hưởng**: không (`Skeleton.test.tsx:47-64` chỉ assert grid class + số bar/`.aspect-square`).
- **Rủi ro dùng chung**: `SkeletonCardGrid` chỉ được HomeTab dùng (grep toàn repo) → sửa an toàn; nhưng nằm trong file chung `Skeleton.tsx` nên chỉ sửa trong nhánh `SkeletonCardGrid`.

### F3: [NGHI VẤN nhỏ] FolderGrid — skeleton double padding, card hẹp hơn thật ~7-8%
- **Skeleton**: `FolderGrid.tsx:46-51` — wrapper `p-6 h-full` nằm TRONG root đã `p-6` (`FolderGrid.tsx:41`) → grid hụt thêm 48px bề ngang.
- **Thật**: `FolderGrid.tsx:65` và `:99` — grid render trực tiếp trong root, không padding thêm.
- **Lệch bề ngang card** = 48/cols px: 3 cột **−16px** (~−7%), 2 cột −24px, 1 cột mobile −48px. Dialog `max-w-3xl` 768px (`FolderSelectionScreen.tsx:271`) → card 3 cột skeleton 216px vs thật 232px. **Chiều cao hàng đúng** (folder variant `p-4` + icon 48 = 80px = `FolderCard.tsx:24-28` 80px) → không phải bug "to hơn thật", chỉ lệch ngang.
- **Fix tối thiểu**: `FolderGrid.tsx:46` `className="p-6 h-full"` → `className="h-full"`.
- **Test bị ảnh hưởng**: không — `FolderSelectionScreen.test.tsx:390` assert `h-full` vẫn pass; `:381-408` vẫn pass.
- **Rủi ro dùng chung**: wrapper này chỉ thuộc FolderGrid → an toàn.

### F4: [OK kèm điểm mù] MainContent — hàng skeleton 72px = SongCard thật; `stretch` ở đây không kéo giãn
- **Skeleton**: `MainContent.tsx:278-287` (wrapper `minHeight: calc(100% - 140px)` + `stretch` → container `h-full`, rows `flex-1`); số rows = `max(4, ceil((innerHeight−140)/72))` (`useSkeletonRows.ts:9-23`).
- **Thật**: `SongCard.tsx:159` `p-3` (12×2) + icon `w-12 h-12` 48px = **72px**; list thật bọc row trong `pb-3` 12px (`VirtualizedSongList.tsx:8-11,116-119`).
- **Phân tích**: wrapper `height:auto` → `h-full` của container không resolve → container cao auto → rows `flex-1` giữ nguyên min-content 72px; công thức số rows đã overfill vùng (`rows×72 + (rows−1)×12 ≥ innerHeight−140`) nên không có band trống. Khớp hàng thật.
- **Điểm mù**: nếu WebView2 resolve `minHeight: calc(100% - 140px)` (comment `MainContent.tsx:273-277` kỳ vọng vậy, nhưng parent `[data-drop-region]` chỉ có `min-height` nên % lẽ ra KHÔNG resolve), rows sẽ bị nén còn ~58px (**0,8x** so với thật). jsdom không có layout nên không kiểm chứng được bằng test — muốn chốt phải đo browser thật (playwright).
- **Ghi chú phụ**: rows tính theo `window.innerHeight` trong khi vùng thật còn bị trừ PlayerBar (~80-90px) → skeleton có thể cao hơn vùng hiển thị ~90px → scrollbar nhẹ khi loading (không phải lỗi size item).

### F5: [OK] CacheManagerModal — khớp cả 2 chiều
- Skeleton: `CacheManagerModal.tsx:231-236` `w-14 h-3.5` (56×14px) trong slot cố định `w-14 h-5` (`:225`).
- Thật: `:238-240` `text-sm leading-none` (glyph 14px) trong cùng slot, căn phải. Slot cố định → không nhảy. Chiều rộng text thật ngắn hơn 56px (căn phải) nhưng cột giữ nguyên — đúng chủ ý. OK.

### F6: [OK] Home — Jump Back In lệch 4px đã ghi nhận
- Skeleton folder = `p-4` + icon 48 = **80px**, `rounded-xl`; thật `RecentFolderCard.tsx:29` `p-3.5` (14px) + icon 48 = **76px**, `rounded-2xl` → +4px (5%), comment `Skeleton.tsx:124-127` đã ghi "accepted 2px/2px skew". Số rows 4 = cap thật `MOST_VISITED_FOLDERS_LIMIT = 4` (`history.ts:15,328`). Chấp nhận, không cần sửa.
- Ghi chú: comment `Skeleton.tsx:126` trỏ `HomeTab.tsx:269` đã lỗi thời (card giờ ở `RecentFolderCard.tsx:29`) — không phải bug size.

### F7: [OK] FolderSelection — xác nhận đã sạch sau fix
- `FolderGrid.tsx:46-52`: container `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3` (khớp 2 nhánh thật `:65`/`:99`); folder variant `p-4` + icon 48 = **80px** = `FolderCard.tsx:24-28` **80px**.
- `auto-rows-fr` không còn trong `src/` (chỉ comment + test assertion `FolderSelectionScreen.test.tsx:406`). Test chống tái phát: `FolderSelectionScreen.test.tsx:381-408`.

### F8: [OK] Home — greeting/section title bars
- `h-8` (32px) vs `text-3xl` line-height 36px; `h-4` (16px) vs `text-sm` line-height 20px → lệch 4px, chấp nhận. `SkeletonCardGrid cols={visibleCount}` = đúng số card thật (`slice(0, visibleCount)`, `useResponsiveItems` 2/4/5).

## 3. Đã OK (không cần sửa)
- MainContent skeleton (F4 — hàng 72px khớp thật; chỉ còn 1 điểm mù đo browser).
- CacheManagerModal (F5), Jump Back In (F6), FolderSelection (F7 — đã fix), greeting/title bars (F8).
- Không có skeleton → "không áp dụng": LikedSongs (không có loading UI; test `LikedSongs.test.tsx:117` chỉ khẳng định empty state giữ nguyên khi đang load), PlaylistView (`:53-56` render nothing khi loading), QueuePanel/QueueList/QueueRow, NowPlayingView/NowPlayingOverlay (chỉ spinner nút play), StorageQuotaCard (chỉ render khi có quota), FullRecentView, Sidebar/PlaylistSection, AppShell (spinner Suspense h-10 w-10, không mirror item), ErrorLogSection (text), Login (spinner w-6 h-6 = icon Google 24px — khớp).
- Số lượng rows skeleton vs thực tế (chỉ ghi chú, không phải bug size): Home quick/recently/heavy/discover = `cols=visibleCount` rows=1 → đúng bằng số card thật; Jump Back In 4 = cap thật 4; MainContent rows theo viewport (có thể nhiều hơn/ít hơn số item thật — bản chất loading); Trash/FolderGrid 6 rows cố định — ước lượng, không đối chiếu được với dữ liệu chưa tải.

## 4. Rủi ro / điểm mù
1. **Chưa đo bằng browser thật**: toàn bộ px quy đổi từ class + phân tích CSS; jsdom không có layout. Riêng F4 phụ thuộc hành vi resolve `% min-height` của WebView2 — cần playwright đo nếu muốn chốt 72px hay 58px.
2. **Tradeoff fill-vùng**: fix F1 theo đề xuất sẽ mất "fill toàn vùng loading" trên màn cao (có band trống) — đúng tradeoff đã chọn ở FolderGrid. Nếu user muốn vừa fill vừa đúng 64px thì phải tính `rows` theo chiều cao vùng đo runtime (thay đổi lớn hơn 1 class, cần task riêng).
3. **F2 card overlay**: skeleton luôn vẽ 2 dòng text cho card "View all" trong khi thật không có — muốn khớp cần thêm prop vào `SkeletonCardGrid` (thay đổi API component dùng chung), cần user xác nhận trước.
4. **Skeleton.tsx là file dùng chéo 3 variant**: F2 sửa trong nhánh `SkeletonCardGrid` (chỉ HomeTab dùng), F1 sửa ở call site TrashScreen — không đụng `ROW_CLASS`/`stretch` nên không ảnh hưởng MainContent. Tuyệt đối không sửa `ROW_CLASS.folder` để vá F6 (sẽ đổi luôn FolderSelection).
5. **Thứ tự ưu tiên đề xuất**: (1) F1 TrashScreen — bug rõ, cùng class bug vừa fix; (2) F3 FolderGrid double padding — 1 class, rủi ro ~0; (3) F2 Home card gap — 1 class, thuần thẩm mỹ; (4) đo lại F4 bằng browser nếu muốn chắc.
6. Working tree đang có thay đổi uncommitted của task khác — báo cáo này chỉ đọc, không xác minh trạng thái commit; số dòng có thể lệch nếu có ai sửa tiếp.