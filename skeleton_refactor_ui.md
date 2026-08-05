# PLAN: Skeleton Loading Toàn Diện (skeleton_refactor_ui)

> Trạng thái: **PLAN CHI TIẾT — sẵn sàng implement** · Ngày: 2026-08-03
> Mục tiêu: thay toàn bộ loading state bằng skeleton loading chuẩn (Spotify/YouTube Music style) cho các màn chính.
> Cách dùng: mỗi slice dispatch ĐÚNG 1 subagent theo spec chi tiết bên dưới, TUẦN TỰ (Slice 0 → 1 → 2 → 3 → 4), TDD đỏ→xanh, verify nhẹ (chạy file test ảnh hưởng + tsc), cuối cùng full suite 1 lần trước khi commit.

---

## 1. HIỆN TRẠNG (audit — bằng chứng file:dòng)

| Màn | Loading hiện tại | Đánh giá |
|---|---|---|
| **MyDrive (MainContent)** | `isLoading ? <LoaderCircle spinner giữa màn>` — MainContent.tsx:243-245 (block `flex flex-col items-center justify-center h-[50vh]`) | ❌ Cần skeleton list |
| **HomeTab** | **KHÔNG CÓ loading state nào** — data load async trong effect, các section pop-in từng cái khi resolve | ❌ Cần skeleton per-section |
| **TrashScreen** | `isLoading ? <LoaderCircle>` — TrashScreen.tsx:165 | ❌ Cần skeleton rows |
| **FolderSelectionScreen** | `isLoading && !isSearchingApi ? <LoaderCircle>` — :350-382 (kèm "Searching deeper..." riêng) | ❌ Cần skeleton rows |
| **App Suspense fallback** | `Loading...` text — App.tsx:227 | ⚠️ Nâng skeleton nếu rẻ (Slice 4) |
| **Sidebar quota** | không có loading | ✅ Giữ |
| **Nút (Login, DeleteConfirm, NewFolder, BulkDelete, DownloadDialog, SelectionToolbar...)** | `LoaderCircle` trong nút | ✅ **GIỮ** (spinner trong button là chuẩn) |
| **CacheManagerModal** | spinner per-row tại slot dung lượng (w-14 cố định) | ✅ **GIỮ** (đã tối ưu, không giật) |
| **PlayerBar buffering / SongCard upload ring / MoreMenu** | icon/ring | ✅ **GIỮ** |

**Phát hiện then chốt**: `src/ui/components/Skeleton.tsx` ĐÃ TỒN TẠI (Skeleton + SkeletonText: `animate-pulse bg-gray-200 dark:bg-[#2a2a2a]`, `aria-hidden="true"`, props width/height/rounded/className) nhưng **KHÔNG được import ở bất kỳ đâu** (grep = 0 match ngoài chính nó) → **TÁI SỬ DỤNG + MỞ RỘNG, TUYỆT ĐỐI KHÔNG viết component skeleton mới ở file khác**.

---

## 2. THIẾT KẾ COMPONENT (Slice 0 — chốt cứng interface)

### 2.1 Giữ nguyên (không đụng)
- `Skeleton` (width/height/className/rounded) — props giữ NGUYÊN (có thể có caller cũ nào đó? grep xác nhận không → vẫn giữ API ổn định).
- `SkeletonText` (lines/className/lineClassName/gap).

### 2.2 Mở rộng trong CÙNG file `src/ui/components/Skeleton.tsx`:

```
export interface SkeletonCardProps {
  cols?: number;              // số cột responsive mặc định 5 (lg)
  rows?: number;              // số card mặc định 1
  className?: string;
}
export function SkeletonCardGrid({ cols = 5, rows = 1 }: SkeletonCardProps): JSX.Element
```
- Mỗi card: `<div className="flex flex-col gap-2"><Skeleton className="aspect-square w-full rounded-2xl" /> <SkeletonText lines={2} gap="space-y-1.5" lineClassName="h-3.5" /></div>` (khớp PremiumCard: cover `w-full aspect-square rounded-2xl mb-4` + title `text-sm` + artist `text-xs` → line 1 w-100% h-3.5, line 2 w-2/3 h-3)
- Grid: `<div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">` — KHỚP chính xác class grid của HomeTab sections (HomeTab.tsx:172/196/242/257)
- Bọc ngoài `aria-hidden="true"` (Skeleton con đã có — đủ)

```
export interface SkeletonRowListProps {
  rows?: number;              // mặc định 8
  showFolderIcon?: boolean;   // true = variant folder (FolderSelection), false = audio (MyDrive/Trash)
  className?: string;
}
export function SkeletonRowList({ rows = 8, showFolderIcon = false }: SkeletonRowListProps): JSX.Element
```
- Mỗi row: `<div className="flex items-center gap-4 py-3">` (khớp khoảng cách row SongCard):
  - `<Skeleton className="w-10 h-10 rounded-md shrink-0" />` (icon 40px — SongCard icon square)
  - `<div className="flex-1 min-w-0 space-y-2"><Skeleton className="h-3.5 w-1/2" /> <Skeleton className="h-3 w-1/3" /></div>`
  - showFolderIcon=true: `<Skeleton className="w-10 h-10 rounded-md shrink-0" />` giống nhau (chỉ khác semantic — không cần class khác)
- Container: `<div className="flex flex-col gap-1" aria-hidden="true">` — khi cần screen reader: caller bọc ngoài với `role="status"` + `aria-label={t('loading')}` (Slice 1-3 làm)

### 2.3 Accessibility bắt buộc (Slice 0 thêm vào BASE_CLASS)
- BASE_CLASS hiện tại: `"animate-pulse bg-gray-200 dark:bg-[#2a2a2a] transition-colors duration-300"` → THÊM `motion-reduce:animate-none` (tôn trọng prefers-reduced-motion — Tailwind có sẵn utility này, không cần CSS thêm)

### 2.4 Shimmer — quyết định ở Slice 0 (research bắt buộc)
- Research DuckDuckGo: "skeleton loading best practice 2026 shimmer vs pulse", "skeleton screen accessibility reduced motion"
- Mặc định: **giữ animate-pulse** (đủ, an toàn, đã có). Nếu research cho thấy shimmer gradient là chuẩn phổ biến: thêm prop `shimmer?: boolean` vào Skeleton (mặc định false = pulse) — KHÔNG đổi mặc định.
- Ghi quyết định cuối cùng vào codebase-memory.

---

## 3. SLICES — SPEC CHI TIẾT CHO SUBAGENT (dispatch nguyên văn từng slice)

> Mẫu prompt chung cho mọi slice: theo `closed-loop-feature-development` skill (test trước/code sau, CHUẨN CHUNG 5B.8, report format skill). Các mục bên dưới là phần SPEC riêng từng slice — chèn vào prompt.

### SLICE 0 — Component skeleton mở rộng
- **File**: `src/ui/components/Skeleton.tsx` + `Skeleton.test.tsx` (mới, nếu chưa có — KIỂM TRA có file test nào không)
- **Research bắt buộc trước khi code**: DuckDuckGo "skeleton loading best practices 2026" + "skeleton reduced motion accessibility" (cite link trong report). context7 nếu cần Tailwind motion-reduce.
- **Thay đổi**:
  1. BASE_CLASS thêm `motion-reduce:animate-none`
  2. Thêm `SkeletonCardGrid` + `SkeletonRowList` (interface như §2.2)
  3. (tuỳ research) thêm shimmer prop
- **Behavior contract**: component MỚI, không đổi Skeleton/SkeletonText API; không đổi màu/giao diện khác
- **Test (TDD)**: (a) SkeletonCardGrid render đúng rows × cols phần tử Skeleton (data-testid="skeleton-card"); (b) class grid đúng `grid-cols-2 md:grid-cols-4 lg:grid-cols-5`; (c) SkeletonRowList render rows phần tử, mỗi row có icon + 2 lines; (d) BASE_CLASS chứa motion-reduce:animate-none (assert qua className của Skeleton); (e) aria-hidden trên container
- **Verify**: tsc + file test mới xanh + grep không nơi nào khác import Skeleton (xác nhận không phá caller)
- **Done**: test xanh, tsc clean

### SLICE 1 — MyDrive (MainContent)
- **File**: `src/ui/MainContent/MainContent.tsx` + `src/ui/MainContent/MainContent.windowing.test.tsx` (+ các test khác assert spinner — grep "LoaderCircle" trong test MainContent trước)
- **Thay đổi**: block `) : isLoading ? (` (dòng 243-245, spinner LoaderCircle giữa màn `h-[50vh]`) → thay bằng:
  ```tsx
  ) : isLoading ? (
    <div role="status" aria-label={t('loading', 'Loading...')} className="py-4">
      <SkeletonRowList rows={8} />
    </div>
  ) : (
  ```
- Import: `import { SkeletonRowList } from '../components/Skeleton';` (đường dẫn đúng — MainContent ở src/ui/MainContent/, Skeleton ở src/ui/components/)
- **Behavior contract**: skeleton hiện ĐÚNG khi isLoading=true (driveStore); biến mất khi data; header chrome (TopNavigationBar + SelectionToolbar) GIỮ NGUYÊN (chỉ thay vùng data-drop-region); KHÔNG đổi logic explorer/fetch; empty state (không search, không audio) giữ nguyên — skeleton CHỈ thay block isLoading
- **Test (TDD)**: (a) RED: render MainContent isLoading=true → expect LoaderCircle spinner KHÔNG còn (queryByTestId/label cũ — kiểm tra test cũ assert spinner gì, cập nhật) + `role="status"` hiện + SkeletonRowList render 8 row; (b) isLoading=false + có items → không có skeleton, list thật; (c) isLoading=false + rỗng → empty state cũ giữ nguyên
- **Lưu ý**: test cũ MainContent.windowing dùng props isLoading:false — không vỡ. Test nào mock lucide LoaderCircle — giữ mock (LoaderCircle vẫn dùng ở nơi khác trong file? grep MainContent LoaderCircle — nếu hết dùng thì bỏ import + cập nhật mock)
- **Done**: test xanh + tsc

### SLICE 2 — HomeTab (4 section skeleton) — SLICE KHÓ NHẤT
- **File**: `src/ui/HomeTab/HomeTab.tsx` + `HomeTab.test.tsx`
- **Thay đổi**:
  1. Đổi khởi tạo state: `useState<Track[]>([])` → `useState<Track[] | null>(null)` cho CẢ 4: recent, heavy, discover, recentlyAdded (null = CHƯA LOAD lần đầu; [] = RỖNG thật)
  2. Greeting skeleton: khi `recent === null` (mọi section chưa load) → thay greeting header bằng `<div className="space-y-2 mb-10"><Skeleton className="h-8 w-64" /><Skeleton className="h-4 w-40" /></div>`
  3. Mỗi section: điều kiện render hiện tại `recent.length > 0 && (...)` → thêm nhánh:
     ```tsx
     {recent === null ? (
       <div className="mb-12">
         <Skeleton className="h-4 w-32 mb-4" />   {/* header icon+title */}
         <SkeletonCardGrid rows={1} cols={visibleCount} />
       </div>
     ) : recent.length > 0 ? ( ...section hiện tại... ) : null}
     ```
     Áp dụng cho 4 section: Recent Files (recent), Heavy Rotation (heavy), Discover (discover), Recently Added (recentlyAdded), Jump Back In (mostVisitedFolders — folder variant: header + `<SkeletonRowList rows={4} showFolderIcon />`)
  4. **GUARD chống nhấp nháy khi refetch**: skeleton CHỈ hiện khi state === null (lần đầu). Delta sync (drive-files-changed/pro-sync-complete/recent-updated) KHÔNG set null — chỉ set [] hoặc data → KHÔNG nhấp nháy. (loadRecentlyAdded chỉ gọi setRecentlyAdded khi có kết quả — không cần thêm guard khác; XÁC NHẬN: loadData hiện set từng state sau await — nếu 1 state resolve trước, section đó hiện trước — đúng ý "per-section")
  5. KHÔNG đổi: logic fetch, delta sync, useResponsiveItems, prefetch effect (chạy khi data — `[...recent, ...]` với null → filter Boolean? **LƯU Ý**: effect dòng 134-138 `const tracks = [...recent, ...heavy, ...discover, ...recentlyAdded]` — khi null spread vào → null phần tử → `.map(t => t.id)` crash! PHẢI sửa: `[...(recent ?? []), ...(heavy ?? []), ...(discover ?? []), ...(recentlyAdded ?? [])]` — ĐÂY LÀ BẪY, ghi trong prompt)
  6. recentlyAddedItems/quickAccess/discoverItems/heavyItems slice: `recentlyAdded.length > 0 ? ...` — với null: `(recentlyAdded ?? []).length > 0` hoặc để nhánh null đã return sớm — quyết định theo cấu trúc (đọc file thật)
- **Test (TDD)** — HomeTab.test.tsx hiện mock getRecentlyPlayed.mockResolvedValue([]) — cập nhật mock trả promise chưa resolve (deferred) cho test skeleton:
  (a) RED: mount với mọi get* trả deferred promise → 4 skeleton section hiện (data-testid="home-skeleton-section" hoặc class) + greeting skeleton + KHÔNG có text "Recent Files"/"Recently Added to Drive"; (b) resolve hết → skeleton biến mất, section thật hiện; (c) resolve 1 phần (VD chỉ recent) → chỉ section recent hiện, 3 cái kia skeleton; (d) delta sync: dispatch drive-files-changed sau khi đã load → KHÔNG có skeleton nhấp nháy (assert skeleton không xuất hiện lại — queryByTestId null sau khi dispatch); (e) empty thật (resolve []) → không skeleton, không section (như cũ); (f) prefetch effect không crash khi null (assert không throw + prefetchVisibleTracks gọi với mảng đã filter null)
- **Done**: test xanh + tsc

### SLICE 3 — TrashScreen + FolderSelectionScreen
- **File**: `src/ui/Settings/TrashScreen.tsx` (+ test), `src/ui/FolderSelection/FolderSelectionScreen.tsx` (+ test)
- **TrashScreen**: block isLoading (dòng ~165) → `<div role="status" aria-label={t('loading')} className="py-4"><SkeletonRowList rows={6} /></div>`; import Skeleton; bỏ LoaderCircle nếu hết dùng (grep — LoaderCircle còn dùng ở restoreId/isBulkActioning/isEmptying → GIỮ import)
- **FolderSelectionScreen**: nhánh `isLoading && !isSearchingApi` (dòng ~350) → SkeletonRowList rows={6} showFolderIcon; GIỮ NGUYÊN nhánh isSearchingApi ("Searching deeper..." + LoaderCircle — search trong lúc load là hành vi riêng)
- **Behavior contract**: skeleton thay đúng block spinner; empty state giữ; "Searching deeper..." giữ
- **Test**: (a) TrashScreen isLoading → skeleton 6 row + không spinner; load xong → list thật; (b) FolderSelection isLoading && !isSearchingApi → skeleton; isSearchingApi → text cũ giữ; load xong → list
- **Done**: test xanh + tsc

### SLICE 4 — App Suspense fallback + verify tổng + ghi memory
- **File**: `src/App.tsx` + App.test.tsx (nếu assert "Loading...")
- Suspense fallback: `Loading...` text → giữ text (fallback hiếm thấy, mỗi lần render nhỏ) HOẶC nâng: quyết định cuối — mặc định GIỮ text (ghi lý do vào memory: Suspense fallback chỉ hiện khi lazy chunk tải — không phải loading data, text là đủ). Nếu đổi → SkeletonRowList.
- **Verify tổng (Main Agent tự chạy, không tin report)**:
  1. `npm test` FULL SUITE xanh
  2. `npx tsc --noEmit` PASS
  3. Grep: `<LoaderCircle` còn ở MainContent/TrashScreen/FolderSelection không (chỉ chấp nhận còn trong nút/modal/icon — liệt kê)
  4. Grep: `role="status"` có ở 3 màn
  5. (nếu được) playwright/dev check nhanh: skeleton hiện rồi biến mất, không giật layout
  6. Ghi codebase-memory: pattern SkeletonCardGrid/SkeletonRowList, quyết định shimmer, bẫy null-spread HomeTab, guard nhấp nháy

---

## 4. EDGE CASES BẮT BUỘC (mọi slice — behavior contract)

1. **Không giật layout**: skeleton kích thước = component thật (card aspect-square rounded-2xl; row icon 40px + 2 lines; grid class copy y hệt từ section thật)
2. **Dark mode**: BASE_CLASS đã có dark:bg-[#2a2a2a] — không thêm gì
3. **prefers-reduced-motion**: motion-reduce:animate-none (Slice 0)
4. **Rỗng thật ≠ chưa load**: null vs [] (HomeTab — Slice 2)
5. **Refetch không nhấp nháy**: skeleton chỉ khi null lần đầu; delta sync không set null
6. **Screen reader**: role="status" + aria-label={t('loading')} (Slice 1, 3)
7. **KHÔNG đổi logic fetch/state/delta sync** — chỉ UI loading
8. **Bẫy null-spread** HomeTab effect prefetch (Slice 2 mục 5)

---

## 5. ĐỊNH NGHĨA DONE (toàn feature — checklist Main Agent)

- [ ] Slice 0-4 APPROVE (mỗi slice TDD đỏ→xanh, report đủ mục skill)
- [ ] Full suite xanh + tsc clean (Slice 4 verify tổng — Main Agent tự chạy)
- [ ] Grep: không còn spinner trung tâm ở MainContent/TrashScreen/FolderSelection
- [ ] Skeleton khớp layout thật — visual check (playwright hoặc hỏi user confirm)
- [ ] codebase-memory đã ghi (pattern + quyết định + bẫy)
- [ ] Commit message gợi ý: `feat(ui): skeleton loading for HomeTab, My Drive, Trash and folder picker`

---

## 6. NGUỒN THAM KHẢO (Slice 0 tra — chưa tra)

- DuckDuckGo: "skeleton loading best practices 2026", "skeleton screen accessibility reduced motion", "shimmer skeleton vs pulse 2026"
- context7: Tailwind (motion-reduce, animate-pulse) nếu cần xác nhận
- Tham khảo UI nội bộ: PremiumCard.tsx (card size), SongCard.tsx (row size ~92px), useResponsiveItems.ts (lg=5/md=4/mobile=2), HomeTab.tsx (grid class), FolderSelectionScreen.tsx (folder row layout)
