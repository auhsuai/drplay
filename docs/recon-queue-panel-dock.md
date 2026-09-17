### BÁO CÁO RECON — QueuePanel overlay → docked same-level

Repo: E:\drplay (Tauri + React 19 + TS + Tailwind 4). Ngày điều tra: 2026-09-17. Chỉ đọc code — không sửa file nào ngoài file doc này.

---

## 1. Hiện trạng render + positioning

**Ai render / state:**
- `src/App.tsx:170` — `const [isQueueOpen, setIsQueueOpen] = useState(false);` (state duy nhất giữ open/close; KHÔNG persist localStorage — chỉ `isSidebarOpen` mới persist qua `src/utils/sidebarState.ts`).
- `src/App.tsx:240-245` — toggle/close wrappers (stable identity, functional update; giữ nguyên cho memo PlayerBar):
```ts
const stableHandleToggleQueue = useCallback(() => { setIsQueueOpen((prev) => !prev); }, []);
const stableHandleCloseQueue = useCallback(() => { setIsQueueOpen(false); }, []);
```
- `src/App.tsx:370-372` truyền xuống AppShell; `src/ui/layouts/AppShell.tsx:121-126` render QueuePanel; `AppShell.tsx:146-147` truyền `isQueueOpen/onToggleQueue` xuống PlayerBar.
- Nút toggle: `src/ui/PlayerBar/PlayerBar.tsx:202-220` — nút `List` nằm trong prop `leading` của `VolumeSlider`, `aria-expanded={isQueueOpen}`.
- Phím tắt: `src/ui/PlayerBar/useKeyboardShortcuts.ts:42-50` — Ctrl/Cmd+Q (guard input/textarea/contentEditable + `e.repeat` ở :25-37).

**Class container thật (toàn bộ block):**
`src/ui/PlayerBar/QueuePanel.tsx:241-254`:
```tsx
<aside
  ref={paneRef}
  data-testid="queue-panel"
  role="complementary"
  aria-label={t("queue.title")}
  aria-hidden={!open}
  inert={!open}
  style={{ top: topOffset }}
  className={`absolute right-0 bottom-0 w-[400px] flex flex-col bg-white dark:bg-[#121212] border-l border-gray-200/50 dark:border-gray-800/50 transition-transform duration-300 ease-in-out ${
    open ? "translate-x-0" : "translate-x-full"
  }`}
>
```
- `position: absolute` là thứ tạo overlay; `translate-x-full` là trạng thái nghỉ ngoài mép phải; row cha `overflow-hidden` clip nó.
- KHÔNG phải dialog: không `role="dialog"`, không `aria-modal`, không backdrop/overlay (`data-testid="queue-overlay"` không tồn tại — test khẳng định null).
- Comment nguồn: `QueuePanel.tsx:42-48` — "drawer docked to the right edge ... Rendered inline (no portal/overlay) ... matching the sidebar's 300ms rhythm."

**Mobile branch:** không có. Grep `IS_MOBILE|isMobile|is_mobile` trong `src/` → 0 match (chỉ có 2 comment unrelated). Trên mọi kích thước cửa sổ render y hệt (panel 400px đè lên list).

**Chiều rộng:** duy nhất `w-[400px]` (QueuePanel.tsx:251). Không có hằng số width nào cho panel; hằng số gần nhất là `QUEUE_ROW_HEIGHT = 84` (`QueueRow.tsx:15-21`, dùng cho virtualizer).

---

## 2. Layout cha & điểm chèn sibling

**Render tree thực tế (chỉ phần layout):**
```
src/App.tsx:296        div.relative flex flex-col h-screen overflow-hidden
└─ AppShell.tsx:77-80  div.flex flex-1 overflow-hidden transition-all ...        (shell, blur khi locked)
   ├─ Sidebar.tsx:34   aside.${isSidebarOpen ? "w-64" : "w-20"} ... shrink-0 transition-all duration-300 overflow-hidden
   └─ AppShell.tsx:92  div#content-area.flex-1 relative overflow-hidden flex flex-col
      ├─ AppShell.tsx:100  div.flex-1 min-h-0 relative overflow-hidden flex     ← ROW (queue nằm ở đây)
      │  ├─ AppShell.tsx:101  div.flex-1 min-w-0 min-h-0 flex flex-col          ← cột tab content (list file)
      │  │  └─ Suspense → TabContentRouter → MainContent.tsx:196 <main className="flex-1 ... overflow-y-auto overscroll-none relative">
      │  └─ AppShell.tsx:121  <QueuePanel .../>                                  ← sibling CUỐI trong row
      └─ AppShell.tsx:129  div (PlayerBar wrapper, h-0 khi NowPlaying mở) → PlayerBar.tsx:176 h-20 ...
```
- Comment cũ xác nhận thiết kế overlay: `AppShell.tsx:96-99` — "The drawer is an absolutely-positioned sibling (overlays the right side, the list does NOT shrink); the row's overflow-hidden clips its off-screen translate-x-full resting state."

**Điểm sửa "cùng cấp":** cấu trúc sibling ĐÃ có sẵn trong flex row; chỉ cần QueuePanel từ `absolute` → in-flow (static) với width transition. Cột tab content `flex-1 min-w-0` (AppShell.tsx:101) sẽ tự thu hẹp — không cần thêm wrapper hay state mới.

**Pattern flex-row + width transition có sẵn trong repo (chính là "UI UX sẵn"):**
`src/ui/Sidebar/Sidebar.tsx:35`:
```tsx
className={`${isSidebarOpen ? "w-64" : "w-20"} bg-[#F8F9FA] dark:bg-[#121212] h-full flex flex-col shrink-0 transition-all duration-300 overflow-hidden border-r border-gray-200/50 dark:border-gray-800/50`}
```
Content-area là `flex-1` sibling (AppShell.tsx:92-95) → khi sidebar mở rộng, list file thu hẹp đúng UX user mô tả. Nội dung bên trong sidebar dùng `max-w-0`↔`max-w-[...]` để chữ không đè (NavItem.tsx:40, SidebarHeader.tsx:31, PlaylistSection.tsx:97, UserProfileSection.tsx:66).

**PLAN-queue-panel.md:** không có docked — `PLAN-queue-panel.md:27` chốt "Modal giữa màn hình"; sau đó `git log` cho thấy `24c5ba6 feat(player): dock queue panel as right-edge slide drawer` mới đổi thành overlay drawer (commit message: "move queue open state to App; AppShell renders the pane in the tab-content row; 400px wide, fully hidden by default; slide right-to-left"). Không có bản docked in-flow nào trong lịch sử (75c3ff9 modal trong PlayerBar → 24c5ba6 absolute drawer → 491894f rework → eae96c9 thêm top-offset).

**Các panel/drawer khác trong repo (grep `fixed right-0|absolute right-0|translate-x|drawer`):**
- `NowPlayingOverlay.tsx:30-35` — `fixed inset-0 z-[9999] ... translate-y-full` full-screen (không tái dùng cho dock).
- Dropdown: `SortDropdown.tsx:238`, `ThemeDropdown.tsx:75`, `LanguageDropdown.tsx:78`, `TrashScreen.tsx:369` — `absolute right-0 top-full` (menu nhỏ, không phải panel).
- `MoreMenu.tsx:342/411/431/456` — render qua `createPortal` (quan trọng: dropdown row queue KHÔNG bị clip bởi `overflow-hidden` của panel khi dock).
- CacheManagerModal — modal giữa màn hình.
→ Kết luận: không có component/prop docked nào khác; pattern gần nhất và đúng nhất là Sidebar.

---

## 3. "UI UX sẵn" để tái sử dụng

Không có `variant`/`docked`/`inline` prop, không có component `Panel`/`Drawer` (glob `*Panel*/*Drawer*` chỉ ra QueuePanel + Sidebar). Tái sử dụng gồm 2 phần:
1. **Khung same-level + list thu hẹp:** y hệt cơ chế Sidebar — `shrink-0` + width class có điều kiện (`w-64`/`w-20`, Sidebar.tsx:35) + `transition-all duration-300 overflow-hidden`, sibling `flex-1 min-w-0` (AppShell.tsx:92-101). QueuePanel đã tự ghi chú "matching the sidebar's 300ms rhythm" (QueuePanel.tsx:47) và duration-300 (QueuePanel.tsx:251) → giữ 300ms cho khớp.
2. **Toàn bộ nội dung panel** (header X, search, select, folder drill-down, rows, menus, live regions) giữ nguyên — chỉ đổi shell ngoài.

---

## 4. Behavior contract phải giữ (test hiện tại)

`src/ui/PlayerBar/QueuePanel.test.tsx` (1168 dòng, jsdom, mock react-i18next + @tanstack/react-virtual + db/kv + playlists; ResizeObserver stub riêng):

| Nhóm | file:line | Assert cốt lõi |
|---|---|---|
| Drawer shell (layout — SẼ PHẢI SỬA) | :210-248 | closed: `pane.className` chứa `translate-x-full`, aria-hidden=true, inert, `queryByTestId("queue-overlay")` null, không render content; open: `translate-x-0`, aria-hidden=false, `not.toContain("backdrop-blur")`, title hiện; đóng sau khi mở: content VẪN mount + `translate-x-full` + aria-hidden/inert |
| Top offset (layout — SẼ PHẢI SỬA/XOÁ) | :250-319 | `style.top` = "80px"/"0px"/"112px"/"70px" theo header `[data-view-header]` đo runtime (ResizeObserver + MutationObserver) |
| Content | :322-433 | 3 row render; row current `aria-current="true"`, click current không gọi onSelectTrack; search accent-insensitive "co"→"Có", "dan"→"Đàn"; empty vs no_results |
| Không còn 4 nút mode | :382-399 | queryByRole button {Normal/Shuffle/Repeat all/Repeat one} null; search + select_multiple vẫn hiện |
| Selection | :401-421, :903-1104 | checkbox chỉ row không-current; bulk remove giữ current; select-all theo scope visible; prune khi auto-advance; focus restore QST-2 |
| Escape | :435-511 | Escape window khi open → onClose 1 lần; pane closed → không; click trong pane không đóng; Escape trong input non-empty → clear query không đóng (`QueueSearchInput.tsx:23-28` stopPropagation); menu/download dialog mở → Escape chỉ đóng lớp trên |
| Grid + keyboard | :514-598 | role=grid name queue.title, aria-rowcount/colcount, mỗi row 1 gridcell, row current aria-selected=true; Arrow/Home/End + aria-activedescendant `queue-option-N` + `scrollToIndex`; Enter activate; click sync anchor |
| Close button | :600-607 | đúng 1 button tên `en.settings.close` (X), không nút footer |
| Row visual | :609-622 | card `bg-[#F8F9FA]`, `hover:shadow-md`, `group-hover:-translate-y-1`, row height 84px |
| Folder drill-down | :625-900 | root 1 folder row (name+count), click→3 child + back, remove folder, menu Navigate/Remove folder, containsCurrent `text-brand-text!` |
| Live regions | :1107-1167 | queue-search-status role=status debounce 400ms; selection toolbar role=status |

`QueueList.test.tsx` chỉ test focus-ring modality (B1-B4, :94-143) — không phụ thuộc layout. `AppShell.test.tsx:81-97` assert pane là anh em tab content trong row (row className chứa `relative` + `overflow-hidden`, `row.contains(tab-content)`=true, `row.contains(player-bar)`=false) — các assert này vẫn đúng khi docked, chỉ tiêu đề test "không co list" là sai ngữ nghĩa.

**Hành vi đóng panel (đủ, không có gì khác):** nút X (QueuePanel.tsx:328-335), Escape (QueuePanel.tsx:230-239), Ctrl+Q toggle (useKeyboardShortcuts.ts:42-50), nút List trong PlayerBar (PlayerBar.tsx:204-219). KHÔNG có click-outside/backdrop-close trong code (và test :435-443 xác nhận không có overlay). KHÔNG auto-open khi play. KHÔNG persist panel open (mở app mặc định đóng — App.tsx:170).

---

## 5. Vùng file list & resize

- `MainContent.tsx:196-199` — `<main ref={mainRef} className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto overscroll-none relative ...">` là scroll container của CHÍNH NÓ, và được truyền làm `scrollElementRef` cho list (`MainContent.tsx:298`).
- `VirtualizedSongList.tsx:66-74`:
```ts
const rowVirtualizer = useVirtualizer({
  count: items.length,
  getScrollElement: () => scrollElementRef.current,
  estimateSize: () => ROW_ESTIMATED_SIZE_PX,   // 92
  overscan: 15,
  getItemKey: (index) => items[index]?.id ?? index,
  useFlushSync: false,
  directDomUpdates: true,
});
```
  (TanStack Virtual 3.14.5, `package.json`). Mỗi row gắn `ref={rowVirtualizer.measureElement}` + `data-index` (:276-277); container width 100% (:261-265).
- **An toàn khi width đổi:** row content truncate cả title (SongCard.tsx:107 `truncate`; QueueRow.tsx:149 `truncate`) → chiều cao row không đổi khi list hẹp lại, không phá measurement. TanStack tự observe resize scroll element (internal); không có logic width nào trong code repo phụ thuộc (`useVirtualizer` không nhận width param). `scrollToIndex` chỉ chạy theo currentIndex (QueueList.tsx:87-90) — không chạy lại khi resize.
- Rủi ro nhỏ: trong 300ms animate width, ResizeObserver/reflow chạy liên tục — chấp nhận được; jsdom không test được animation thật (test chỉ assert class).

---

## 6. Tests phải sửa

| File | Vị trí | Sửa gì |
|---|---|---|
| `src/ui/PlayerBar/QueuePanel.test.tsx` | :210-248 (3 test "QueuePanel drawer shell") | Đổi assert `translate-x-full`/`translate-x-0` → width contract (`w-0` khi đóng / `w-[400px]` khi mở); giữ nguyên aria-hidden/inert/no-overlay/exit-mount |
| `src/ui/PlayerBar/QueuePanel.test.tsx` | :250-319 (5 test "top offset") + harness :104-145 (`ResizeObserverStub`, `triggerResize`, `mountHeader`) + :192-197 stub | XOÁ nếu bỏ machinery topOffset (khuyến nghị); nếu giữ thì test pass nhưng assert vô nghĩa (style.top trên element static) |
| `src/ui/layouts/AppShell.test.tsx` | :81-97 | Assert hiện tại vẫn pass; đổi title "không co list" → "list co lại" và có thể thêm assert cột tab có `flex-1 min-w-0`, pane có `shrink-0` |
| `src/ui/layouts/AppShell.test.tsx` | :113-121 | Giữ nguyên (pane mount khi closed cho exit animation vẫn đúng) |
| `src/App.test.tsx:149`, `src/App.stableHandlers.test.tsx:158` | | Mock `QueuePanel: () => null` — không đụng |
| `src/ui/PlayerBar/PlayerBar.test.tsx:2030-2088` | | Chỉ test nút + Ctrl+Q, không phụ thuộc layout — không đụng |
| `QueueList.test.tsx`, MainContent tests | | Không phụ thuộc layout — không đụng |

**Test setup chung:** `vitest.config.ts:5-10` — env mặc định `node`, file React tự thêm `// @vitest-environment jsdom`; `setupFiles: src/test-setup.ts` (chỉ jest-dom + IS_REACT_ACT_ENVIRONMENT); QueuePanel.test mock ResizeObserver bằng class stub (:113-124) — nếu xoá top-offset thì xoá luôn stub. Pattern render: seed state bằng `usePlayerStore.setState` (:162-169), mock virtualizer render mọi item (:70-90).

---

## 7. Kế hoạch fix đề xuất (mức file/dòng, không code)

1. **`src/ui/PlayerBar/QueuePanel.tsx`**
   - Bỏ `absolute right-0 bottom-0`, `style={{ top: topOffset }}` (:250), `ref={paneRef}` (:244), `useLayoutEffect` + ResizeObserver/MutationObserver + `topOffset` state (:172-228) — toàn bộ machinery này tồn tại chỉ để căn absolute drawer dưới sticky header; in-flow thì vô dụng. Đổi import `useLayoutEffect` (:1).
   - Class aside (:251-253) → in-flow width contract kiểu Sidebar: `shrink-0 h-full overflow-hidden` + `transition-all duration-300 ease-in-out` + `${open ? "w-[400px]" : "w-0"}`; GIỮ `bg`, `border-l`, `data-testid`, `role="complementary"`, `aria-label`, `aria-hidden={!open}`, `inert={!open}` (tests shell dựa vào các attr này).
   - `QueuePanelDialog` root (:323) thêm width cố định (`w-[400px] shrink-0`) để nội dung không bị bóp/reflow trong lúc animate width (nếu không, child width = container width = 0 → chữ wrap giật khi mở/đóng).
   - Cân nhắc `motion-reduce:transition-none` (repo đã dùng ở Skeleton.tsx:11) — tùy chọn.
2. **`src/ui/layouts/AppShell.tsx`** — chỉ sửa comment :96-99 cho đúng thiết kế mới; class row/column giữ nguyên (`relative`/`overflow-hidden` vô hại, giữ để AppShell.test :89-90 không phải sửa). List tự thu hẹp nhờ `flex-1 min-w-0` ở :101.
3. **Tests** — theo bảng mục 6 (QueuePanel shell tests đổi sang width; xoá describe top-offset + harness; AppShell.test đổi title/thêm assert shrink).
4. **Không đụng:** App.tsx, PlayerBar.tsx, useKeyboardShortcuts.ts, QueueList/QueueRow/QueueFolderRow, MainContent/VirtualizedSongList, locales.
5. Alignment thị giác (tùy chọn, cần user chốt): header panel hiện `p-6` (:323, 24px) vs header view `px-8 pt-8 pb-4` (MainContent.tsx:221, 32px) — sau khi docked, tiêu đề "Play Queue" sẽ cao hơn tiêu đề list ~8px; có thể chỉnh `pt-8` cho panel nếu muốn thẳng hàng.

---

## 8. Rủi ro / điểm mù

- **Inner width bắt buộc pin:** aside `w-0 + overflow-hidden` mà child không có width cố định → content bị squish thay vì reveal; phải set `w-[400px]` cho QueuePanelDialog (đã nêu mục 7).
- **`overflow-hidden` trên aside:** che shadow/ring tràn ra ngoài panel. MoreMenu đã dùng `createPortal` (MoreMenu.tsx:342/411/431/456) nên dropdown row không bị clip; ring keyboard là `ring-inset` (QueueList.tsx:100) nên không mất. Shadow hover của row card sát mép panel có thể bị cắt (đã bị cắt tương tự ở row `overflow-hidden` hiện tại).
- **Bỏ topOffset là đổi layout có chủ đích** (không còn absolute); 5 test top-offset phải xoá — cần ghi rõ trong report để reviewer không coi là mất coverage: đây là xoá test theo layout cũ, không phải nới test.
- **Cửa sổ hẹp:** 400px panel + sidebar 256px có thể bóp list còn rất nhỏ; repo không có breakpoint/responsive nào cho panel (không có IS_MOBILE). User chưa yêu cầu xử lý → để nguyên, nhưng nêu khi báo cáo.
- **Focus khi đóng bằng X:** focus có thể rơi về body (hành vi hiện tại, `inert` khi closed) — không đổi.
- **`data-view-header` sẽ thành attribute chết** (MainContent.tsx:220, FullRecentView.tsx:160) sau khi xoá machinery — để nguyên trong task này, không lan scope.
- **Không persist `isQueueOpen`** — giữ nguyên (không thuộc yêu cầu).
- **NowPlayingOverlay** `fixed inset-0 z-[9999]` phủ toàn bộ khi mở — không tương tác với docked panel; PlayerBar wrapper chỉ h-0 khi NowPlaying mở (AppShell.tsx:129-132), row vẫn nguyên.
- **Branch `feature/android-port`** tồn tại nhưng ngoài scope (worktree khác, không đụng).
- **jsdom không có layout thật:** không test được width animation/reflow; chỉ assert class contract — cần user verify thị giác khi chạy app.
