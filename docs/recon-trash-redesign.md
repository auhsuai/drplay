# BÁO CÁO RECON — Redesign màn Trash

> Repo: `E:\drplay` (Tauri + React 19 + TS + Tailwind 4). Điều tra ngày 2026-09-17.
> LƯU Ý: working tree đang có thay đổi uncommitted của các task khác — báo cáo mô tả ĐÚNG cây làm việc hiện tại (KHÔNG phải HEAD). Không sửa/revert bất kỳ file code nào.
> Mọi kết luận đều kèm `file:line` + trích code thật.

## §0 Trạng thái working tree liên quan Trash (đọc trước khi implement)

`git status --short` cho thấy các file đã đổi (uncommitted):
- `src/ui/Settings/TrashScreen.tsx` — diff nhỏ: skeleton bỏ `stretch`, container bỏ `h-full` (wrapper `role=status` vẫn `h-full`); comment cập nhật (dòng 320-331).
- `src/ui/Settings/TrashScreen.test.tsx` — test skeleton đổi tên + assert mới (dòng 217-240).
- `src/ui/components/Skeleton.tsx` — diff nằm ở `SkeletonCardGrid` (gap-2 → gap-4, dòng 85), KHÔNG đụng variant `trash`.
- `src/locales/{en,vi}/translation.json` — xóa `metadata_fetch_desc` (task khác, không liên quan).
→ Implementer làm tiếp TRÊN cây hiện tại, không revert các thay đổi này.

## TL;DR — Data availability

| Câu hỏi | Kết luận | Bằng chứng |
|---|---|---|
| `size` có sẵn để hiển thị? | KHÔNG (hiện tại). `getTrashedFiles` chỉ xin `id,name,mimeType` | `drivePagination.ts:124` |
| `trashedTime` (ngày xóa) có sẵn? | Chỉ populate cho file trong SHARED DRIVE; My Drive luôn rỗng | Google Drive API docs (delete guide): "The following fields are only populated for files located within a shared drive: `trashedTime`, `trashingUser`" |
| App có tự lưu thời điểm xóa? | KHÔNG. Không bảng Dexie/localStorage nào lưu | `db.ts` (không có bảng trash); grep `deletedAt|trashTime` = 0 match |
| Fallback khả thi | Thêm `size,modifiedTime` (tùy chọn `trashedTime`) vào fields mask → cột Size = `formatBytes`, cột Ngày = `trashedTime ?? modifiedTime` (ước tính), "còn 30 ngày" = ngày + 30d | `driveTypes.ts:8,11-12`; `formatBytes.ts:8` |
| Selection/bulk tái dùng? | Có `selectedIds:Set` + 2 bulk handlers + `runBulkOperation`; PHẢI thay UI chọn (div giả → checkbox thật) + entry (menu Ellipsis → checkbox) | `TrashScreen.tsx:49-51,187-251,253-260`; `TrashItemRow.tsx:53-63` |
| Skeleton variant `trash` dùng ở đâu? | CHỈ `TrashScreen` → được phép sửa variant | grep `variant="trash"`: `TrashScreen.tsx:328` + `Skeleton.test.tsx` |

---

## 1. Cấu trúc hiện tại (cây render + class thật + px)

File chính: `src/ui/Settings/TrashScreen.tsx` (476 dòng), `src/ui/Settings/TrashItemRow.tsx` (98 dòng).

### 1.1 Cây render (số dòng theo file TrashScreen.tsx)

```
<div overlay>                                             :262-270
  class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
  role="presentation"; click backdrop (e.target === e.currentTarget) → onClose

  <div role="dialog" aria-modal="true" aria-labelledby="trash-title">   :271-276
    class="bg-white dark:bg-[#121212] w-full max-w-2xl h-[70vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"

    ├─ HEADER :278-316
    │   class="px-6 py-5 flex items-center justify-between shrink-0 bg-gray-50/50 dark:bg-[#1a1b1e]/50"
    │   ├─ icon box :280-295  class="w-10 h-10 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0"
    │   │   (SVG trash inline 20px, stroke-width 2 — copy của icon Trash2)
    │   ├─ title :297-302  <h1 id="trash-title" class="text-lg font-bold text-gray-900 dark:text-white"> {settings.trash}
    │   ├─ subtitle :303-305  <p class="text-xs text-gray-500 mt-0.5"> {settings.trash_desc}
    │   └─ close :308-315  <button ref=closeButtonRef aria-label={common.close}
    │       class="p-2 text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-full transition-colors"> <X class="w-5 h-5">
    │
    ├─ LIST AREA :319   class="flex-1 overflow-y-auto p-4 bg-white dark:bg-[#121212]"   ← scroll container duy nhất
    │   ├─ LOADING :320-331
    │   │   <div role="status" aria-label={t("loading")} class="h-full">
    │   │     <SkeletonRowList rows={6} variant="trash" containerClassName="flex flex-col gap-2" />
    │   ├─ EMPTY :332-338
    │   │   <div class="text-center py-20 text-gray-500 flex flex-col items-center">
    │   │     <Trash2 class="w-16 h-16 mb-4 opacity-20" />
    │   │     <h3 class="text-lg font-medium text-gray-900 dark:text-gray-200"> {settings.trash_empty}
    │   └─ LIST :339-398  <div class="flex flex-col gap-2">
    │       ├─ WARNING + MENU ROW :341-385  class="flex items-center justify-between px-1 py-3 mb-2"
    │       │   ├─ warning :342-345  class="flex items-center gap-2 text-sm text-brand-text font-medium"
    │       │   │   <TriangleAlert class="w-5 h-5 shrink-0" /> <p>{settings.trash_warning}</p>
    │       │   └─ Ellipsis menu :346-384
    │       │       button class="p-1.5 text-gray-500 ... rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
    │       │       dropdown class="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-... p-1 z-50"
    │       │       item "menu.select_multiple" (:370-381) → setIsSelectionMode(true)
    │       └─ ROWS :386-396  <TrashItemRow item isSelected isSelectionMode isRestoring onToggle onRestore />
    │
    └─ FOOTER :402-472  class="px-6 py-4 flex items-center justify-between bg-gray-50/50 dark:bg-[#1a1b1e]/50 shrink-0"
        ├─ SELECTION MODE :403-440
        │   ├─ count :405-407  "{selectedIds.size} {common.selected}" (class text-sm font-medium — KHÔNG có role=status)
        │   ├─ Restore :409-424  class="px-4 py-2.5 bg-brand-primary text-white rounded-xl text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
        │   │   <RefreshCw|LoaderCircle w-4 h-4> + <span class="hidden sm:inline">{settings.restore}
        │   └─ Delete :425-438  class="px-4 py-2.5 bg-red-500 text-white rounded-xl ..." + <Trash2 w-4 h-4> + {common.delete}
        └─ NORMAL :441-471
            ├─ count :443-447  "{items.length} {settings.items_in_trash}" (class text-xs text-gray-500 hidden sm:block)
            ├─ Cancel :449-454  {folder_selection.cancel}
            └─ Empty Trash :455-468  class="flex items-center justify-center gap-2 bg-red-500 hover:bg-red-600 text-white px-5 py-2.5 rounded-xl ... w-full sm:w-auto"
```

### 1.2 Row hiện tại (`TrashItemRow.tsx`)

- Container :32-51 — `role="button"` + `tabIndex={0}` CHỈ khi `isSelectionMode` (:33-34); class :35-41:
  `flex items-center justify-between p-3 rounded-xl transition-colors` + selected `bg-brand-primary/10 border border-brand-primary/30` + thường `bg-gray-50 dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f] border border-transparent`.
- Chiều cao thực: `p-3` (12+12) + icon box `w-10 h-10` (40) = **64px**; cộng `gap-2` (8px, TrashScreen.tsx:340) giữa các row → bước lưới 72px. Xác nhận bằng comment: `TrashScreen.tsx:321-324` ("p-3 + w-10 icon = 64px") và `Skeleton.tsx:127`.
- Left cluster :52-78 `flex items-center gap-3 overflow-hidden`:
  - "checkbox" GIẢ :53-63 — `<div class="w-5 h-5 rounded-md border ...">` + `<Check class="w-3.5 h-3.5 text-white" />`; **không phải `<input type=checkbox>`**, chỉ hiện khi selection mode.
  - icon box :64-72 `w-10 h-10 rounded-lg` (Folder amber / FileHeadphone brand-primary).
  - tên :73-77 `text-sm font-semibold text-gray-900 dark:text-gray-100 truncate max-w-[250px] sm:max-w-sm`.
- Restore button :79-95 (LUÔN hiện, không hover) — `px-4 py-1.5 text-xs font-semibold text-green-600 bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40 rounded-lg` + `RefreshCw`/`LoaderCircle` (spinner khi `isRestoring`); label `hidden sm:inline`.
- Row click :42-50: chỉ toggle khi selection mode; Enter/Space toggle.

### 1.3 Trạng thái loading/empty/error

- Loading: `isLoading` khởi tạo `true` (useTrashedFiles.ts:20) → skeleton (TrashScreen.tsx:320). Debug event `DEBUG_EVENTS.SKELETON target="trash"` ép `setIsLoading(true)` (:125-133).
- Empty: `items.length === 0` (:332); debug event `DEBUG_EVENTS.TRASH_EMPTY` → `setItems([]); setIsLoading(false)` (:111-118).
- Error: chỉ có toast `settings.trash_load_error` (useTrashedFiles.ts:38-46); KHÔNG có inline error state — list giữ nguyên (rỗng hoặc dữ liệu cũ).
- Không có search/filter, không virtualization; `overflow-y-auto` nằm ở list area (:319).
---

## 2. Dữ liệu khả dụng (QUAN TRỌNG NHẤT)

### 2.1 Chuỗi fetch thật

1. Query: `useTrashedFiles.ts:25-27`

```ts
const q =
  "trashed=true and appProperties has { key='deletedByDrPlay' and value='true' }";
const files = await getTrashedFiles(token, q, signal);
```

2. `getTrashedFiles` — `drivePagination.ts:116-129`:

```ts
export async function getTrashedFiles(
  token: string, query: string, signal?: AbortSignal,
): Promise<DriveFileItem[]> {
  return fetchAllPages<DriveFileItem>(
    token, query,
    "nextPageToken,files(id,name,mimeType)",   // <-- fields mask, dòng 124
    "fetch trashed files", signal, "folder,name",
  );
}
```

URL thật (fetchAllPages, `drivePagination.ts:29`):
`${DRIVE_FILES_URL}?q=...&fields=...&orderBy=folder,name&pageSize=${PAGINATION_PAGE_SIZE}` — `DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"` (`driveFiles.ts:13`).

3. Mapping trong hook — `useTrashedFiles.ts:31-37` (CHỈ giữ 3 field):

```ts
setItems(
  files.map((f: TrashedItem) => ({ id: f.id, name: f.name, mimeType: f.mimeType })),
);
```

### 2.2 Kiểu dữ liệu có sẵn

`driveTypes.ts:4-15` — `DriveFileItem` ĐÃ có sẵn các field optional (chỉ thiếu ở fields mask):

```ts
export interface DriveFileItem {
  id: string; name: string; mimeType: string;
  size?: string;            // :8
  parents?: string[];
  trashed?: boolean;
  createdTime?: string;     // :11
  modifiedTime?: string;    // :12
  md5Checksum?: string;
  capabilities?: Record<string, boolean>;
}
```

`useTrashedFiles.ts:8-12` — `TrashedItem` nội bộ chỉ có `{ id; name; mimeType }` → phải mở rộng nếu hiển thị size/ngày.

### 2.3 Ngày xóa — sự thật cần biết

- **`trashedTime` có tồn tại trong Drive API v3 nhưng CHỈ populate cho file thuộc shared drive** (official docs "Trash or delete files and folders": *"The following fields are only populated for files located within a shared drive: `trashedTime`, `trashingUser`"*). App này dùng My Drive (`deletedByDrPlay` appProperties) → sẽ **rỗng**.
- **Không có nơi nào trong app lưu thời điểm xóa**: không bảng Dexie (xem `db.ts` danh sách bảng), không localStorage, không appProperties timestamp. `deleteFile` chỉ PATCH `trashed:true` + `appProperties.deletedByDrPlay:"true"` — `driveFiles.ts:142-164`:

```ts
const metadata = {
  trashed: true,
  appProperties: { deletedByDrPlay: "true" },
};
```

- Grep toàn repo `deletedAt|trashTime|trashedTime`: 0 match (ngoài `deletedByDrPlay`).

### 2.4 Kết luận + fallback đề xuất

| Cột spec | Dữ liệu thật | Cách làm |
|---|---|---|
| Dung lượng | Cần thêm `size` vào fields mask. `DriveFileItem.size?: string` đã có; folders không có size (Google trả `size` chỉ cho file binary) | `formatBytes(Number(size))`; folder → hiển thị `"—"` |
| Ngày xóa | Chính xác: KHÔNG. Xấp xỉ: `modifiedTime` (DrPlay xóa bằng PATCH metadata `trashed:true` — thực tế Drive bump `modifiedTime`; NHƯNG không có gì bảo đảm hợp đồng, nên ghi nhãn "ước tính" hoặc chỉ hiện ngày sửa đổi). `trashedTime` chỉ có với shared drive | `trashedTime ?? modifiedTime`; format `new Date(x).toLocaleDateString()` |
| Thời gian còn lại | Suy ra từ ngày xóa + 30 ngày (chính sách Drive tự xóa sau 30 ngày, key `settings.trash_warning` cũng nói vậy) | `Math.max(0, 30 - Math.floor((Date.now() - t)/86400000))` hiển thị "còn {{count}} ngày" |

Tùy chọn chính xác hơn (nhiều việc, KHÔNG bắt buộc cho redesign): lưu `deletedAt` ISO vào `appProperties` lúc `deleteFile` (`driveFiles.ts:147-152`) — chỉ áp dụng cho file xóa SAU này; file cũ vẫn thiếu. Không có yêu cầu test nào cho việc này.

### 2.5 Helper format có sẵn

- `formatBytes(bytes: number, fractionDigits = 1): string` — `formatBytes.ts:8-28`; caller hiện có: `StorageQuotaCard.tsx:124,184-197`, `CacheManagerModal.tsx:239`, `QueueRow.tsx:209`, `SongCard.tsx:215`. Dùng cái này cho cột Size (nhất quán toàn app).
- **KHÔNG có helper format ngày/giờ hiển thị.** Grep `formatDate|toLocaleDateString|Intl.DateTimeFormat` chỉ thấy `errorLog.ts:252` (dùng `toLocaleDateString()` làm group key, không phải UI). Cách so sánh ngày hiện có: `new Date(modifiedTime).getTime()` (`useDriveListing.ts:47-54`). → Cho cột ngày, dùng `new Date(...).toLocaleDateString()` (mặc định locale) hoặc thêm helper nhỏ; chưa có precedent UI nên không có ràng buộc style.
- `formatTime(seconds)` (`formatTime.ts`) là duration, KHÔNG dùng cho ngày.

---

## 3. Selection/bulk hiện có

### 3.1 Machinery (tái dùng được gần như toàn bộ)

`TrashScreen.tsx`:
- State: `isSelectionMode` (:49), `selectedIds: Set<string>` (:50), `isBulkActioning` (:51); `restoringIds: Set<string>` cho spinner per-row (:38-46).
- `toggleItem(id)` (:253-260) — thêm/xóa id khỏi Set.
- `handleBulkRestore` (:187-218) — `runBulkOperation(ids.map(id => () => restoreFile(token, id)), ids, "bulk-restore-item-failed")`; xóa succeeded khỏi list; partial → toast `settings.bulk_restore_error_count` + prune selection bằng `removeIdsFromSelection`; full success → clear selection + tắt selection mode; catch → `captureError` + `restore_error`.
- `handleBulkDelete` (:220-251) — guard `selectedIds.size === 0 || isBulkActioning`; `window.confirm(t("settings.confirm_bulk_delete"))`; tương tự restore nhưng toast `settings.bulk_delete_error_count` / `empty_trash_error`.
- `handleEmptyTrash` (:153-185) — confirm `settings.confirm_empty_trash`, chạy bulk, partial → xóa succeeded + toast `empty_trash_error_count`; full → `setItems([])` + `empty_trash_success` + `onClose()`.
- `handleRestore(id)` (:135-151) — per-row restore, dispatch `window` CustomEvent `"refresh-drive"` sau khi thành công (bulk restore cũng dispatch :198).
- `removeIdsFromSelection` + `runBulkOperation` — `trashBulkOps.ts:15-52` (concurrency 5, `BULK_CONCURRENCY` :10; log lỗi format `"{prefix} for fileId={id}: {reason}"` :36).

### 3.2 UI selection hiện tại — KHÁC spec

- **Không có checkbox `<input>` nào** trong Trash. Cái trông như checkbox là `<div>` (TrashItemRow.tsx:53-63).
- **Entry point**: menu Ellipsis ở góc phải hàng warning (TrashScreen.tsx:358-365) → item `menu.select_multiple` (:370-381) → `setIsSelectionMode(true)`. Khi đang ở selection mode, nút Ellipsis được thay bằng nút "Cancel" (`common.cancel`, :348-356).
- Chọn item: click CẢ ROW (TrashItemRow.tsx:42-44) hoặc Enter/Space (:45-50); row có `role="button"` + `tabIndex=0` (:33-34) → tests click `getByRole("button", { name: "Track 1" })`.
- Bulk toolbar: nhánh footer :403-440 — text "{n} {common.selected}" (:405-407) + nút restore (:409-424) + nút delete (:425-438). Không có `role=status` trên count (chỉ skeleton wrapper mới có, :325). `role="status"` mà spec nhắc có thể là của `QueueSelectionToolbar.tsx:37-43` (màn Queue, không phải Trash).
- Thoát selection: nút Cancel header-list (:348-356) hoặc tự thoát khi bulk thành công (:204-207, :237-240).

### 3.3 Tái dùng gì / thay gì

| Giữ nguyên | Thay |
|---|---|
| `selectedIds`, `toggleItem`, `handleBulkRestore`, `handleBulkDelete`, `runBulkOperation`, `removeIdsFromSelection`, `isBulkActioning` | Fake checkbox div → `<input type="checkbox">` thật (pattern CacheManagerModal, xem §5) |
| Per-row restore handler + `restoringIds` spinner | Entry point: bỏ menu Ellipsis (và `isMoreMenuOpen`, `moreMenuRef`, `useClickOutside`, import `Ellipsis`/`SquareCheckBig`) → checkbox hiện luôn mỗi row |
| Confirm `window.confirm` hiện tại (tests spy) | Thêm per-row permanent delete handler (hiện chỉ có bulk/empty — row chỉ có Restore) |
| Count "{n} selected" (nếu giữ label cũ, tests đỡ phải sửa) | Labels toolbar mới "Restore selected"/"Delete selected" → tests phải sửa + keys i18n mới |
| | Select-all (chưa tồn tại ở Trash) + trạng thái indeterminate (chưa có precedent nào trong repo — grep `indeterminate` = 0) |
---

## 4. Behavior contract + test mapping

Nguồn: `TrashScreen.test.tsx` (718 dòng), `trashBulkOps.test.ts` (97), `useTrashedFiles.test.tsx` (159), `Skeleton.test.tsx` (269), `driveApi.test.ts` (getTrashedFiles 1106-1244), `TrashGate.test.tsx`, `App.test.tsx:395-408`.

### 4.1 TrashScreen.test.tsx — bảng giữ/sửa

| # | Test / assert nguyên văn | Dòng | Kết luận |
|---|---|---|---|
| 1 | `rowFor()` helper: `screen.getByText(name).closest("div.p-3")` | 95-99 | **SỬA** — row mới sẽ không còn `p-3`; đổi selector (vd `data-testid="trash-row"` thêm vào row) |
| 2 | `enterSelectionMode()`: tìm nút `className.includes("p-1.5")` rồi `fireEvent.click(screen.getByText("menu.select_multiple"))` | 101-110 | **SỬA/XÓA** — nếu bỏ menu Ellipsis, mọi test gọi helper này (bulk restore/delete, Escape-in-flight, row semantics) phải chuyển sang click checkbox |
| 3 | `it("shows 6 skeleton rows inside a status region instead of the spinner while loading")` — `rows toHaveLength(6)` + `getByRole("status", { name: "loading" })` + `.animate-spin` null | 141-151 | **GIỮ** (miễn giữ 6 rows + role=status wrapper) |
| 4 | `it("renders the real item list after loading finishes")` — `findByText("Track 1")` | 153-169 | **GIỮ** |
| 5 | `it("keeps the empty state when no items are returned")` — `findByText("settings.trash_empty")` | 171-186 | **GIỮ** |
| 6 | `it('never flashes the "Trash is empty" state before the skeleton...')` — Profiler markers | 188-215 | **GIỮ** (contract: isLoading init true) |
| 7 | `it("keeps the loading skeleton rows at their natural height...")` — `status.className` contains `h-full`; wrapper contains `"flex flex-col gap-2"`; rows NOT `flex-1` | 217-240 | **SỬA 1 phần** — nếu container list đổi từ `gap-2` sang divider `divide-y`/`gap-0`, assert wrapper phải đổi theo. Assert `h-full` + no `flex-1` giữ |
| 8 | bulk restore: `fireEvent.click(screen.getByRole("button", { name: "Track 1" }))` ×2; `expect(screen.getByText("2 common.selected"))`; click `screen.getByText("settings.restore")`; partial: còn `"1 common.selected"` + `"common.delete"` | 255-287 | **SỬA** — row role/checkbox + toolbar label mới; phần assert toast/captureError giữ |
| 9 | bulk delete: click `"common.delete"`; `window.confirm` mock; partial → `"settings.bulk_delete_error_count"` + `"1 common.selected"` | 289-323 | **SỬA** target click; assert logic giữ |
| 10 | bulk delete confirm cancelled: `confirmSpy` called with `"settings.confirm_bulk_delete"`; no delete; selection kept | 325-344 | **GIỮ** behavior (contract: confirm trước khi xóa vĩnh viễn), sửa selector click |
| 11 | empty trash partial: click `"settings.empty_trash"`; no onClose; toast `"settings.empty_trash_error_count"`; log `"empty-trash-item-failed"` | 346-381 | **GIỮ** (footer Empty Trash không đổi) |
| 12 | per-row restore state (P2-05-7): `getAllByRole("button", { name: "settings.restore" })` length **2**; `rowFor("Track 1").querySelector("button")` disabled; `.animate-spin` present | 396-455 | **SỬA rowFor**; phần còn lại GIỮ NẾU per-row restore vẫn là `<button aria-label/label settings.restore>` + spinner. CẢNH BÁO: nếu thêm nút Delete trong row, `querySelector("button")` có thể bắt nhầm nút đầu — nên đổi sang query theo tên cụ thể |
| 13 | a11y dialog: `getByRole("dialog", { name: "settings.trash" })`, `aria-modal=true`, `aria-labelledby="trash-title"`, `#trash-title` text = `settings.trash` | 620-629 | **GIỮ BẮT BUỘC** — header mới phải giữ `id="trash-title"` trên title text |
| 14 | focus: `getByRole("button", { name: "common.close" })` là `document.activeElement` khi mở | 631-636 | **GIỮ BẮT BUỘC** — nút X phải giữ `ref=closeButtonRef`, `aria-label={common.close}`, và effect focus :73-89 |
| 15 | Escape close / ignored while bulk delete in flight / unmount removes listener | 638-680 | **GIỮ** (không đụng effect :95-105) |
| 16 | row semantics P2-05-8: ngoài selection mode row KHÔNG role/tabindex (:694-703); trong selection mode row role=button tabindex=0, click row → "1 common.selected" (:705-717) | 683-717 | **SỬA theo contract mới** — checkbox hiện luôn mỗi row thay đổi entry; cần chốt: row còn là role=button khi "selection mode" không? (spec mới không còn selection mode tường minh) |
| 17 | debug TRASH_EMPTY (3 test) + debug SKELETON target trash (4 test) | 458-606 | **GIỮ** — giữ listener `DEBUG_EVENTS.TRASH_EMPTY`/`SKELETON` (:111-133) |

### 4.2 Test khác

| File | Assert | Dòng | Kết luận |
|---|---|---|---|
| `trashBulkOps.test.ts` | log format `"bulk-delete-item-failed for fileId=abc123: Drive 404"`; concurrency ≤5 | 16-96 | **GIỮ** — không phụ thuộc layout |
| `useTrashedFiles.test.tsx` | stale-token guard, abort; `type FileItem = { id; name; mimeType }` | 27-158 | **GIỮ** nếu field mới là optional (nên để optional) |
| `driveApi.test.ts` | getTrashedFiles pagination, `orderBy=folder,name` (1186-1192), error message `"Failed to fetch trashed files (404)"` (1199) | 1106-1244 | **GIỮ** — KHÔNG có assert nào trên `fields=` của trash (chỉ `drivePagination.listAudio.test.ts:55` assert fields của `listFolderAudioFiles`). Đổi mask an toàn; nên thêm 1 assert mới khóa contract |
| `Skeleton.test.tsx` | variant trash: `gap-3` + `p-3` + `.w-10.h-10` + đúng 1 line `h-3.5`, 0 `h-4`/`h-3` (129-142); row bg `bg-gray-50 dark:bg-[#202124]` + `rounded-xl` (162-169); ring trên icon (184-203, trash dùng `.w-10.h-10`); stretch `flex-1` (171-182) | 129-203 | **SỬA** theo row mới (bỏ rounded/card, có thể thêm line date/size); stretch generic giữ |
| `TrashGate.test.tsx` | render/null theo token | 16-40 | **GIỮ** |
| `App.test.tsx` | SKELETON target `"trash"` không đụng store chính | 395-408 | **GIỮ** |

### 4.3 Assert "dễ vỡ nhất" khi làm redesign (ưu tiên sửa trước)

1. `rowFor` (TrashScreen.test.tsx:95-99) — dùng class `div.p-3`; row phẳng gần như chắc chắn đổi padding.
2. `enterSelectionMode` (:101-110) — phụ thuộc menu Ellipsis + `menu.select_multiple`; spec mới thay bằng checkbox + select-all.
3. 6 test bulk/per-row click row qua `getByRole("button", { name })` (:261-262, :295-296, :331, :654) — nếu row không còn role=button.
4. Assert text toolbar footer `"2 common.selected"`, `"settings.restore"`, `"common.delete"` (:263, :269, :282, :305, :318, :341) — nếu đổi label sang "Restore selected/Delete selected".
5. Skeleton asserts (:129-142, :162-169) — bắt buộc đổi cùng variant.

---

## 5. Pattern tái sử dụng trong repo

### 5.1 List phẳng chia dòng (border-b) / hover nền

Repo KHÔNG có `divide-y` (grep 0 match) và gần như không có list phẳng — chủ đạo là card `rounded-xl bg-...`. Precedent gần nhất:

- **`ErrorLogSection.tsx:41-43`** — divider thủ công + `last:border-b-0`:

```tsx
className="border-b border-gray-200 dark:border-[#2A2A2A] pb-3 last:border-b-0 last:pb-0"
```

- **`ImageCropperModal.tsx:125`** — header divider: `"flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800"`.

Lưu ý spec ghi `border-b border-neutral-800` — đó là màu tối, sẽ vô hình ở light mode. Repo convention: `border-gray-200 dark:border-[#2A2A2A]` (ErrorLogSection) hoặc `border-gray-100 dark:border-gray-800` (ImageCropperModal). Đề xuất dùng 1 trong 2 cho nhất quán theme sáng/tối.

### 5.2 Action ẩn/hiện khi hover + a11y focus

- **`LikedSongs.tsx:241`** — precedent chuẩn nhất (có cả `group-focus-within`):

```tsx
<div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
```

  Parent row (:200) có `group`; test khóa contract: `LikedSongs.test.tsx:174-188` assert `"group-focus-within:opacity-100"`.
- `SongCard.tsx:225` — `opacity-0 group-hover:opacity-100` (menu 3 chấm, giữ hiện khi menu mở).
- `PlaylistView.tsx:405` — `opacity-0 group-hover:opacity-100 focus:opacity-100 ...` (nút xóa track).
- A11y: dùng `group-focus-within:opacity-100` (LikedSongs) để keyboard focus bên trong row vẫn nhìn thấy action; thêm `focus-visible:opacity-100` nếu muốn chắc. Không có tooltip component — repo dùng `title=` + `aria-label` (MoreMenuTrigger.tsx:46-49, LikedSongs.tsx:247).

### 5.3 Checkbox (pattern thật đang dùng)

- **`CacheManagerModal.tsx:207-219`** (label + peer + Check overlay):

```tsx
<input type="checkbox" checked={selected.has(id)} onChange={...}
  className="peer appearance-none w-4 h-4 rounded border-2 border-gray-400 dark:border-gray-500 bg-white dark:bg-[#2a2b2f] checked:bg-brand-primary checked:border-brand-primary cursor-pointer transition-colors" />
<Check className="absolute inset-0 m-auto w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" strokeWidth={3} />
```

- **`QueueRow.tsx:36-64`** — `QueueRowCheckbox` (cùng class, có `aria-label={label}` + `e.stopPropagation()` để click checkbox không kích hoạt row :51-55).
- **KHÔNG có `indeterminate` ở bất kỳ đâu** (grep `indeterminate` = 0 match) → select-all "partial" phải tự làm: hoặc (a) dùng icon trạng thái thay vì input native (`Square` / `SquareCheckBig` như SelectionToolbar), hoặc (b) native input + `ref` set `el.indeterminate = true`. Lucide có sẵn `square-minus`, `minus-square`, `minus` trong `node_modules/lucide-react/dist/esm/icons/`.

### 5.4 Header modal tối giản (title + X)

- **`CacheManagerModal.tsx:183-198`** — mẫu sát spec nhất:

```tsx
<div className="flex items-center justify-between">
  <h3 id="cache-manager-title" className="text-lg font-bold text-gray-900 dark:text-white">{...}</h3>
  <button onClick={onClose} disabled={clearing} aria-label={t("settings.close")}
    className="text-gray-400 hover:text-gray-900 dark:hover:text-white p-1 rounded-full transition-colors disabled:opacity-50">
    <X className="w-5 h-5" />
  </button>
</div>
```

- `DownloadDialog.tsx:84-98` (title + X, cùng class), `DeleteConfirmDialog.tsx:83-93` (title + desc).
- Trash phải giữ `id="trash-title"` + `aria-label={t("common.close")}` + `closeButtonRef` (xem §4.1 #13-14) — title spec 18-20px ≈ `text-lg` (18px) hoặc `text-xl` (20px), repo chuộng `text-lg font-bold`.

### 5.5 Icon buttons nhỏ

- **`MoreMenuTrigger.tsx:46-54`** — nút icon chuẩn:

```tsx
aria-label={t("common.more_actions")}
className="relative p-2 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-brand-primary/40 text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#33343a]"
```

- `LikedSongs.tsx:242-250` — `p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-all text-brand-text hover:scale-110` + `title=`.
- `CacheManagerModal.tsx:190-197` — `p-1 rounded-full` (X).
- Không có nút `w-8 h-8` cố định; kích thước ~32px đạt được bằng `p-2` + icon `w-4 h-4`. Icons khả dụng cho hàng mới: `RotateCcw`/`ArchiveRestore` (khôi phục), `Trash2` (xóa vĩnh viễn) — tất cả có trong lucide-react@^1.22.0.

### 5.6 Select-all + bulk toolbar (mẫu để copy)

- **`SelectionToolbar.tsx:35-46`** — nút select-all với icon `Square`/`SquareCheckBig` + `drive.select_all` (có `aria-label`).
- **`QueueSelectionToolbar.tsx:28-60`** — cụm: nút X thoát + count `role="status" aria-atomic` (:37-43) + nút select-all (:47-60) + nút hành động đỏ (:62-71); class nút: `flex items-center gap-2 px-3 py-1.5 text-sm font-medium ... rounded-lg transition-colors shadow-sm active:scale-95 disabled:opacity-50`.
- Count hiện tại của Trash footer đơn giản hơn: `<p class="text-sm font-medium ...">{selectedIds.size} {common.selected}</p>` (TrashScreen.tsx:405-407).
---

## 6. Skeleton variant `trash` — dùng ở đâu + class cần đổi

- **Chỉ TrashScreen dùng variant này**: grep toàn `src/` cho `variant="trash"` → duy nhất `TrashScreen.tsx:328` (ngoài ra là các test trong `Skeleton.test.tsx`). → ĐƯỢC PHÉP sửa variant `trash` cho khớp row mới.
- Hiện trạng class variant `trash` (`Skeleton.tsx`):
  - `ROW_CLASS.trash` — dòng 133: `"flex items-center gap-3 p-3 bg-gray-50 dark:bg-[#202124] rounded-xl"`
  - `ROW_ICON_CLASS.trash` — dòng 147: `"w-10 h-10 rounded-lg shrink-0 ring-1 ring-black/5 dark:ring-white/10"`
  - `TITLE_LINE_CLASS.trash` — dòng 155: `"h-3.5 w-1/2 rounded"`; nhánh 1-line riêng — dòng 166-168 (`lineClasses = variant === "trash" ? [1 dòng] : [title, sub]`).
- Sau redesign row 40-48px, cần đổi tối thiểu:
  - `ROW_CLASS.trash` → row phẳng khớp (vd `"flex items-center gap-3 h-12 px-3 border-b border-gray-200 dark:border-[#2A2A2A] bg-transparent"` — bỏ `rounded-xl`, bỏ nền card).
  - `ROW_ICON_CLASS.trash` → khớp icon mới (nếu giữ icon 40px thì giữ; nếu thu nhỏ còn 32px thì `w-8 h-8`).
  - `TITLE_LINE_CLASS.trash` + nhánh 1-line (:166-168) → nếu row có nhiều cột (tên/ngày/size), thêm line skeleton cho cột phụ hoặc đổi sang layout `flex` với các thanh ngang.
- Skeleton container do caller truyền: `containerClassName="flex flex-col gap-2"` (TrashScreen.tsx:329) → nếu list thật đổi sang divider (không gap), đổi cả container này (gap-2 → xấp xỉ 0) + cập nhật test TrashScreen.test.tsx:217-240.
- **Diff uncommitted gần đây (giữ nguyên, không revert)**: TrashScreen.tsx:320-331 đã bỏ `stretch` + bỏ `h-full` container để row không bị kéo cao ~2x; `stretch` prop vẫn tồn tại trong Skeleton.tsx:180 cho variant khác.

## 7. i18n

### 7.1 Keys hiện có (en / vi) — ai dùng

| Key | en | vi | Dùng ở |
|---|---|---|---|
| `settings.trash` | en:223 "Trash" | vi:219 "Thùng rác" | TrashScreen.tsx:301; SettingsTab.tsx:240 |
| `settings.trash_desc` | en:224 | vi:220 | TrashScreen.tsx:304 (subtitle — spec mới có thể bỏ) |
| `settings.trash_empty` | en:236 | vi:232 | TrashScreen.tsx:336 |
| `settings.trash_warning` | en:237 "Items in trash are permanently deleted after 30 days." | vi:233 "Các mục trong thùng rác sẽ bị xóa vĩnh viễn sau 30 ngày." | TrashScreen.tsx:344 — **TÁI DÙNG ĐƯỢC làm dòng note xám** (spec #6) |
| `settings.restore` | en:238 | vi:234 | TrashItemRow.tsx:93; TrashScreen.tsx:422 |
| `settings.empty_trash` | en:239 | vi:235 | TrashScreen.tsx:467 |
| `settings.items_in_trash` | en:240 | vi:236 | TrashScreen.tsx:445 |
| `settings.confirm_empty_trash` | en:241 | vi:237 | TrashScreen.tsx:154 |
| `settings.confirm_bulk_delete` | en:243 | vi:239 | TrashScreen.tsx:222 |
| `settings.empty_trash_success/_error` | en:244-245 | vi:240-241 | TrashScreen.tsx:172,181 |
| `settings.restore_error` | en:246 | vi:242 | TrashScreen.tsx:147,214 |
| `settings.empty_trash_error_count` (+_one/_other) | en:247-249 | vi:243-245 | TrashScreen.tsx:168 |
| `settings.bulk_restore_error_count` (+_one/_other) | en:250-252 | vi:246-248 | TrashScreen.tsx:201 |
| `settings.bulk_delete_error_count` (+_one/_other) | en:253-255 | vi:249-251 | TrashScreen.tsx:234 |
| `settings.trash_load_error` | en:274 | vi:270 | useTrashedFiles.ts:46 |
| `settings.open_trash` | en:235 | vi:231 | SettingsTab.tsx:251 |
| `common.selected` | en:15 "selected" | vi:15 "đã chọn" | TrashScreen.tsx:406 |
| `common.cancel` / `common.delete` / `common.close` | en:14,16,22 | vi:14,16,22 | nút Cancel selection / nút Delete bulk / aria-label X |
| `menu.select_multiple` | en:200 | vi:196 | TrashScreen.tsx:379; **vẫn dùng ở MoreMenu/DefaultMenuItems.tsx:66** → bỏ khỏi Trash không làm mồ côi key |

Chưa có key `settings.select_all`; key `select_all` hiện có nằm ở namespace khác: `drive.select_all` (en:80), `queue.select_all`/`queue.unselect_all` (en:159-160). `queue.selected_count` (en:161, plural) là pattern đặt tên tốt để tham chiếu.

### 7.2 Keys mới đề xuất (snake_case theo convention, namespace `settings`)

| Key | en | vi |
|---|---|---|
| `settings.trash_select_all` | "Select all" | "Chọn tất cả" |
| `settings.trash_unselect_all` | "Unselect all" | "Bỏ chọn tất cả" |
| `settings.trash_restore_selected` (+_one/_other) | "Restore selected ({{count}})" | "Khôi phục mục đã chọn ({{count}})" |
| `settings.trash_delete_selected` (+_one/_other) | "Delete selected ({{count}})" | "Xóa vĩnh viễn mục đã chọn ({{count}})" |
| `settings.trash_col_name` | "Name" | "Tên file" |
| `settings.trash_col_deleted` | "Deleted" | "Ngày xóa" |
| `settings.trash_col_size` | "Size" | "Dung lượng" |
| `settings.trash_days_left` (+_one/_other) | "{{count}} days left" | "Còn {{count}} ngày" |
| `settings.trash_delete_confirm` (nếu thêm xóa lẻ per-row) | "Permanently delete this item?" | "Xóa vĩnh viễn mục này?" |

Ghi chú: nếu toolbar giữ label cũ (`settings.restore`, `common.delete`), các test bulk hiện tại đỡ phải sửa — nhưng spec yêu cầu nhãn rõ "Khôi phục đã chọn / Xóa vĩnh viễn đã chọn" nên nhiều khả năng phải đổi + sửa test. Dòng note xám dùng lại `settings.trash_warning` (không cần key mới). Nếu bỏ subtitle thì `settings.trash_desc` thành unused (không test nào assert) — có thể xóa hoặc giữ.

## 8. Kế hoạch implement đề xuất (file-level)

Thứ tự an toàn (mỗi checkpoint nên chạy test liên quan):

1. **`src/utils/driveTypes.ts`** — thêm `trashedTime?: string;` vào `DriveFileItem` (sau `modifiedTime`, dòng 12).
2. **`src/utils/drivePagination.ts:124`** — đổi fields mask:
   `"nextPageToken,files(id,name,mimeType,size,modifiedTime,trashedTime)"`.
   (Tùy chọn: thêm 1 test assert `urls[0]` chứa `size,modifiedTime` trong `driveApi.test.ts` describe getTrashedFiles.)
3. **`src/ui/Settings/useTrashedFiles.ts`** — mở rộng interface `TrashedItem` (:8-12) thêm `size?: string; modifiedTime?: string; trashedTime?: string;` và map pass-through (:31-37).
4. **`src/ui/Settings/TrashItemRow.tsx`** — redesign:
   - Row: `group flex h-12 items-center gap-3 px-3 border-b border-gray-200 dark:border-[#2A2A2A] hover:bg-gray-50 dark:hover:bg-white/[0.03] transition-colors` (bỏ `rounded-xl`, bỏ nền card; commit divider dùng convention §5.1).
   - Checkbox thật đầu row: copy nguyên class `CacheManagerModal.tsx:207-219`, `aria-label={item.name}`, `onClick stopPropagation` như `QueueRow.tsx:51-55`.
   - Cột: name (flex-1 truncate) + ngày (`text-xs text-gray-500 tabular-nums`, `trashedTime ?? modifiedTime`) + size (`formatBytes(Number(size))`, folder → "—").
   - Actions `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity` chứa 2 icon button (Restore `RotateCcw`/`RefreshCw`, Delete `Trash2`) — thêm prop `onDelete` mới; giữ spinner `isRestoring` trong nút restore.
   - Lưu ý tests: giữ nút restore là `<button>` với label/aria-label `settings.restore`; nếu thêm nút Delete trước nó, sửa test #12 (§4.1) tìm đúng nút.
   - Quyết định contract row: bỏ `role="button"` cả-row (checkbox đã thay) HOẶC giữ cho click row — phải chốt vì test #16.
5. **`src/ui/Settings/TrashScreen.tsx`**:
   - Header: bỏ icon box :280-295; giữ `<h1 id="trash-title">` (:297-302) + nút X (:308-315, giữ ref/aria-label/effect focus); thêm dòng note xám `text-xs text-gray-500` = `settings.trash_warning` ngay dưới title.
   - Bỏ warning banner + menu Ellipsis (:341-385) → xóa state/refs/import liên quan: `isMoreMenuOpen`, `moreMenuRef`, `useClickOutside` (:54-66), `Ellipsis`, `SquareCheckBig`, `TriangleAlert` (nếu không dùng nơi khác).
   - Header list: checkbox select-all (reuse §5.6) + 3 nhãn cột (hoặc select-all + text 2 bên).
   - Giữ nguyên `selectedIds`/`toggleItem`/`handleBulkRestore`/`handleBulkDelete` (:187-260); giữ `window.confirm` hiện tại.
   - Bulk toolbar khi `selectedIds.size > 0` (có thể vẫn đặt ở footer để tận dụng slot Empty Trash): count + nút Restore selected + Delete selected (keys §7.2); empty-trash footer giữ nguyên khi không chọn.
   - `isSelectionMode` có thể bỏ hẳn (checkbox luôn hiện) — khi đó xóa nhánh Cancel :348-356 và điều kiện row; HOẶC giữ với nghĩa "selectedIds.size > 0". Chốt sớm vì ảnh hưởng tests #2/#8/#9/#16.
6. **`src/ui/components/Skeleton.tsx`** — sửa `ROW_CLASS.trash` (:133), `ROW_ICON_CLASS.trash` (:147), `TITLE_LINE_CLASS.trash` (:155) + nhánh 1-line (:166-168) khớp row mới; cập nhật `Skeleton.test.tsx:129-142,162-169,184-203`; cập nhật container class ở TrashScreen.tsx:329 + test TrashScreen.test.tsx:217-240 nếu list đổi gap.
7. **`src/locales/en/translation.json` + `vi/translation.json`** — thêm keys §7.2 (giữ nguyên các key cũ đang dùng).
8. **Tests**: cập nhật `TrashScreen.test.tsx` theo bảng §4.1 (đổi `rowFor`, bỏ `enterSelectionMode`, click checkbox/toolbar label mới); giữ nguyên `trashBulkOps.test.ts`, `useTrashedFiles.test.tsx`, `TrashGate.test.tsx`, debug tests.
9. **Verify**: `npx vitest run src/ui/Settings/TrashScreen.test.tsx src/ui/Settings/useTrashedFiles.test.tsx src/ui/Settings/trashBulkOps.test.ts src/ui/components/Skeleton.test.tsx src/utils/driveApi.test.ts` + `npx tsc --noEmit` + eslint file đụng; UI thật nên chạy playwright (mở Settings → Open Trash) vì đây là thay đổi layout/hover.

## 9. Rủi ro / điểm mù

1. **Ngày xóa không chính xác**: `trashedTime` rỗng với My Drive; `modifiedTime` là xấp xỉ (chỉ đúng nếu Drive bump lúc PATCH trash — cần kiểm chứng thực tế 1 file trước khi hứa "Ngày xóa"; nếu không chắc, ghi nhãn "Sửa đổi gần nhất" hoặc "—"). "Thời gian còn lại 30 ngày" chỉ là suy diễn từ ngày đó — đừng hiển thị như dữ liệu chính xác.
2. **Hover-only actions**: touch device không có hover; precedent repo (LikedSongs) dùng `group-focus-within` nhưng đó là a11y bàn phím, không giải quyết touch. Cân nhắc: hiện actions khi `sm:opacity-100`? hoặc chấp nhận vì user vẫn có checkbox → bulk toolbar (mọi hành vi đều làm được qua selection). Ghi rõ quyết định.
3. **Select-all indeterminate chưa có tiền lệ** — phải tự implement (native `indeterminate` qua ref hoặc icon 3 trạng thái); không quên trạng thái "partial" để UX đúng.
4. **Focus/a11y dialog bắt buộc giữ**: `id="trash-title"`, `closeButtonRef.focus()` khi mở, `aria-label common.close`, Escape capture-phase + guard `isBulkActioning/isEmptying` (TrashScreen.tsx:73-105) — bất kỳ thay đổi header nào cũng phải giữ 4 thứ này (test #13-15).
5. **Scroll/padding**: list area đang `p-4` (:319); divider full-bleed đẹp hơn nếu container đổi `px-0`/`px-2` và row tự pad — nhưng skeleton + test container class phải đổi theo.
6. **Không có search/filter** trong Trash → không có ràng buộc layout với filter; nếu sau này thêm thì select-all phải scope theo "kết quả đang hiện" (bài học từ `QueuePanel.test.tsx:863-947` — select-all theo visible scope).
7. **Count footer/plural**: `items_in_trash` không plural trong khi item có thể số ít; nếu sửa luôn thì cẩn thận test không assert key này (hiện không).
8. **Per-row permanent delete mới**: cần error handling đầy đủ (captureError + toast `empty_trash_error`?) + confirm, tránh xóa nhầm; hiện `handleBulkDelete` chỉ chạy bulk. Nếu KHÔNG thêm confirm cho xóa lẻ, đó là behavior mới cần user duyệt.
9. **Row height & skeleton mismatch**: component `Skeleton` rows dùng `data-testid="skeleton-row"`; test đếm 6 rows — giữ đúng 6.
10. **Working tree đang bẩn**: không revert diff hiện có (skeleton natural-height + locale metadata) — implementer sẽ thấy chúng trong `git diff`; chỉ commit phần của mình.
11. **`menu.select_multiple` vẫn sống ở MoreMenu** — không xóa key i18n khi bỏ khỏi Trash.
12. **`formatBytes` nhận number**: `size` từ Drive là string → phải `Number(size)`; file/folder thiếu size → "—" (đừng gọi formatBytes(undefined) vì signature yêu cầu number; `formatBytes(0)` trả "0 B").
