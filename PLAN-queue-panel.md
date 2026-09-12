# PLAN — Queue Panel (DrPlay)

> Trạng thái: SPEC ĐÃ CHỐT với user (2026-09-12) — sẵn sàng thực thi theo slice.
> Task type: FEATURE MỚI (`closed-loop-feature-development`), TDD, review từng slice.
> Dispatch TUẦN TỰ trên cùng working tree (5C.4). Branch: `main`.

---

## 1. Yêu cầu gốc (user)

1. **Queue panel** hiện danh sách queue, style "y chang" `CacheManagerModal`
   (nút, màu, blur, checkbox, rounded-2xl, brand-primary).
2. Nút **search** tìm tên bài hát trong queue.
3. **More menu từng file** giống menu file ở tab My Drive — nhưng **bỏ** các
   tính năng file-management (`Move to`, `Delete`); **thêm** "Xoá khỏi hàng đợi".
4. **Chọn nhiều file** trong queue.
5. Hiện cơ chế play-next hiện tại: **Normal / Random / Repeat** — và cho bấm đổi.
6. **More menu mới ở My Drive**: "Thêm file / folder vào queue" (folder = đệ quy).
7. Có thể **xoá queue từng file, hoặc theo folder**.
8. Nút mở queue nằm **ngay bên trái icon volume** trong PlayerBar.
9. Phím tắt **Ctrl+Q** mở/đóng queue panel.

## 2. Quyết định UX đã chốt (user trả lời)

| # | Điểm | Chốt |
|---|------|------|
| 1 | Kiểu panel | **Modal giữa màn hình** (style y hệt CacheManagerModal, cao hơn + list cuộn) |
| 2 | Xoá bài ĐANG PHÁT | **KHÔNG cho xoá** — mục "Xoá khỏi hàng đợi" + checkbox của row hiện tại bị disable |
| 3 | Menu từng row | Giữ: **Tải xuống, Điều hướng tới file, Thêm vào playlist**; luôn có **Xoá khỏi hàng đợi**. Bỏ: Move to / Delete / Select multiple (đã có nút riêng) |
| 4 | Play mode | **Cho bấm đổi trực tiếp 4 chế độ** (Normal / Random / Repeat all / Repeat one) |
| 5 | Thêm folder vào queue | **Đệ quy toàn bộ** (cả folder con), cap an toàn + toast khi bị cắt |

## 3. Quyết định kỹ thuật bổ sung (Main Agent, đã verify code thật)

- **Persist**: chỉ `originalQueue` được persist vào `drplay_queue`
  (khớp `usePlayerSession` restore). Thao tác queue mới + `updateQueueContext`
  dùng CHUNG helper `persistQueue` — tránh 2 nguồn sự thật.
- **PlayMode persist**: đã tự động — `usePlayerLifecycle` đã persist `playModeKv`
  theo `playMode` (effect sẵn có), không cần persist thủ công.
- **Play mode đổi trực tiếp** cần recompute queue khi ra/vào shuffle; tách
  logic từ `handleTogglePlayMode` thành `handleSetPlayMode(mode)` và cho toggle
  gọi lại (behavior toggle giữ nguyên 100%).
- **Stale-closure trap**: PlayerBar memo comparator IGNORE handler props
  (App.tsx:191-228 comment). Mọi handler mới truyền xuống PlayerBar PHẢI dùng
  ref-delegate wrapper (`stableHandleX` pattern) như hiện có.
- **Track đã có sẵn**: `queueItemId` (danh tính chuẩn để xoá/multi-select),
  `parentId` + `parentName` (để xoá theo folder + hiển thị row).
- **Folder → queue**: 1 query/folder (`getFolderAudioQuery` trả cả audio + folder
  con) → BFS đệ quy, dùng `driveFetch` (đã có retry 429/5xx bên trong).
- **Accent-insensitive search**: normalize NFD + strip diacritics để gõ "co"
  tìm được "có" (user Việt).
- **Nút queue**: VolumeSlider nhận thêm prop `leading?: ReactNode` — nút render
  ngay trái `VolumeIcon`, giữ nguyên root classes `w-[30%] min-w-[120px] gap-3`.
- **Ctrl+Q**: thêm vào `useKeyboardShortcuts` (global, chỉ active khi PlayerBar
  mounted); require `(e.ctrlKey || e.metaKey)` + không `altKey`; guard
  INPUT/TEXTAREA/contentEditable như các key khác.
- **Icon nút queue**: lucide `List` (icon 3 dòng + 3 chấm user chọn — đã verify
  tồn tại trong lucide-react 1.22.0: `dist/esm/icons/list.mjs`, export d.ts:12081).
- **Virtualize list**: dùng `@tanstack/react-virtual` (đã là dependency) cho
  danh sách queue — queue có thể vài trăm~1000 dòng sau "thêm folder đệ quy".

## 4. INTERFACE FREEZE — Slice 1 (`src/store/queueOps.ts`)

```ts
// Pure module-level functions (dùng usePlayerStore.getState()/actions).
export function appendTracksToQueue(tracks: Track[]): number;
export function removeTracksFromQueue(queueItemIds: readonly string[]): number;
export function removeTracksByFolderFromQueue(parentId: string): number;
export function persistQueue(queue: Track[]): void; // idbSet(queueKv) + captureError(warn)
```

**Contracts (BẢO TOÀN chính xác):**

- `appendTracksToQueue`:
  - `tracks.length === 0` → return 0; KHÔNG đụng store, KHÔNG persist.
  - Mỗi track mới phải có `queueItemId` (dùng `ensureQueueItemId`).
  - Append vào CUỐI `originalQueue` VÀ CUỐI `playbackQueue` (kể cả khi shuffle —
    chủ đích: phát sau đuôi queue, predictable).
  - `persistQueue(nextOriginalQueue)`; return số track đã thêm.
- `removeTracksFromQueue(ids)`:
  - Lọc CẢ HAI queue theo `queueItemId` NOT IN ids.
  - **Bài đang phát KHÔNG BAO GIỜ bị xoá** dù nằm trong ids (so bằng `sameTrack`).
  - Không có gì thay đổi (không match id nào) → return 0; KHÔNG persist.
  - Có thay đổi → persist `originalQueue` mới; return số item xoá khỏi `originalQueue`.
- `removeTracksByFolderFromQueue(parentId)`:
  - `!parentId` → return 0 (không làm gì).
  - ids = các track trong `originalQueue` có `parentId` khớp (trừ current) →
    delegate `removeTracksFromQueue`. Return số đã xoá.
- `persistQueue(queue)`:
  - `idbSet(SESSION_CLEANUP_KEYS.queueKv, queue).catch(...)` → `captureError`
    `{ level: "warn", source: "queueOps", message: "queue-save-fail: ..." }`.
  - `updateQueueContext` trong `usePlayerQueue.ts` thay 2 chỗ `idbSet` thô bằng
    helper này (giữ nguyên hành vi: save queue mới + save `[]` khi clear).

**`usePlayerQueue.ts` thay đổi thêm (Slice 1):**

- Chuyển `ensureQueueItemId` sang `src/hooks/player/utils.ts` (cạnh `sameTrack`)
  và **re-export** từ `usePlayerQueue.ts` để import cũ/test cũ không đổi.
  (Tránh import cycle: `queueOps` ← `usePlayerQueue` chỉ 1 chiều.)
- Thêm `handleSetPlayMode(mode: PlayMode)`:
  - `mode === playMode` → no-op.
  - Vào shuffle (`mode === "shuffle"` khác hiện tại): nếu `originalQueue.length > 0
    && currentTrack` → `setPlaybackQueue(shuffleQueueWithCurrent(originalQueue,
    currentTrack, ensureQueueItemId(currentTrack)))`; ngược lại chỉ `setPlayMode`.
  - Ra shuffle (đang shuffle, mode mới khác) → `setPlaybackQueue([...originalQueue])`.
  - `setPlayMode(mode)`.
  - `handleTogglePlayMode` refactor → `handleSetPlayMode(NEXT_MODE[playMode])`,
    behavior y hệt hiện tại (mọi test cũ phải xanh nguyên trạng).
- Trả thêm `handleSetPlayMode` trong return của hook.

## 5. SLICES

### Slice 1 — Queue ops core (KHÔNG UI)
- File: `src/store/queueOps.ts` (mới) + `src/store/queueOps.test.ts` (mới),
  `src/hooks/player/utils.ts` (+ensureQueueItemId), `src/hooks/player/usePlayerQueue.ts`
  (+handleSetPlayMode, persistQueue reuse, re-export), `usePlayerQueue.test.ts` (tests mới).
- Test list: xem §6.
- Verify: `npx vitest run src/store/queueOps.test.ts src/hooks/player/usePlayerQueue.test.ts`
  + `npx tsc --noEmit` + `npx eslint <files>`.

### Slice 2 — QueuePanel UI + PlayerBar wiring (nút + Ctrl+Q)
- File mới: `src/ui/PlayerBar/QueuePanel.tsx` (+ row/mode sub-components nếu cần,
  ≤400 dòng/file), `QueuePanel.test.tsx`, `src/ui/components/MoreMenu/QueueMenuItems.tsx`.
- File sửa: `PlayerBar.tsx` (nút ListMusic + mount panel + local open state),
  `PlayerBar/types.ts` (+`onSetPlayMode`), `VolumeSlider.tsx` (+`leading`),
  `useKeyboardShortcuts.ts` (Ctrl+Q), `App.tsx` (stableHandleSetPlayMode,
  ref-delegate), `AppShell.tsx` (truyền prop), `MoreMenu/constants.ts` (+variant
  `"queue"`), `MoreMenu.tsx` (render branch + props), locales en/vi.
- Nội dung panel: danh sách virtualized theo `playbackQueue`, highlight current,
  auto-scroll tới current khi mở, search (accent-insensitive), mode selector 4 nút,
  multi-select + bulk remove (disable current), row menu (Queue variant), empty
  states (queue rỗng / search không kết quả), Esc + overlay click đóng,
  role="dialog" aria-modal như CacheManagerModal.
- Tests: RTL component tests (không cần Playwright — app cần Google OAuth thật;
  ghi rõ lý do trong report theo MCP-fallback rule 5B.8.1).

### Slice 3 — MyDrive "Thêm vào hàng đợi" (file + folder đệ quy)
- File mới: `src/hooks/useMenuAddToQueue.ts`, `src/utils/folderTracks.ts` (+tests).
- File sửa: `src/utils/drivePagination.ts` (+`listFolderAudioFiles`), `MoreMenu.tsx`
  (wire hook), `DefaultMenuItems.tsx` (+item "Thêm vào hàng đợi"),
  locales en/vi.
- Caps: `MAX_ADD_TO_QUEUE_FILES = 1000` (dừng + toast khi cắt), guard re-entrancy,
  abort khi unmount. File: append 1 track; Folder: BFS đệ quy bằng
  `getFolderAudioQuery` (đã gồm cả subfolder), map DriveFileItem → Track
  (`parentId`/`parentName` của folder chứa nó).
- Tests: util (pagination, recursion, cap, abort, error) + hook (success/empty/error)
  + menu item (file/folder/no-token/loading).

## 6. Test list Slice 1 (TDD — RED trước)

`queueOps.test.ts`:
1. append empty queues → cả 2 queue = tracks, mỗi track có queueItemId; persist queueKv.
2. append giữ nguyên thứ tự cũ + nối đuôi cả 2 queue (normal).
3. append khi đang shuffle → vẫn nối đuôi `playbackQueue` (không shuffle lại).
4. append [] → no-op, không persist.
5. append giữ `queueItemId` đã có (không tạo mới).
6. remove xoá đúng queueItemId ở CẢ 2 queue; persist queue mới.
7. remove chứa id của current → current được giữ nguyên.
8. remove id không tồn tại → return 0, KHÔNG persist.
9. removeByFolder xoá hết track cùng parentId trừ current; `parentId` rỗng → 0.
10. persistQueue lỗi → captureError warn (mock idbSet reject).

`usePlayerQueue.test.ts` (bổ sung):
11. handleSetPlayMode normal→shuffle: queueItemId current ở head, đủ phần tử.
12. shuffle→normal: restore originalQueue order.
13. normal→repeat-all / repeat-one: chỉ đổi mode, không đụng queue.
14. set trùng mode đang bật → no-op (không set state).
15. queue rỗng + set shuffle → chỉ đổi mode.
16. handleTogglePlayMode vẫn cycle đúng 4 mode (test cũ phải xanh).

## 7. Verification plan

- Tầng 1 (subagent tự chạy): vitest các file liên quan + tsc + eslint; ghi
  baseline + log RED (fail cụ thể) + log GREEN vào report.
- Tầng 2 (Main Agent): đọc diff, cross-verify 1-2 claim, chạy `npx tsc --noEmit`,
  commit (`feat(player): ...`).
- Cuối session: full `npx vitest run` + `npm run build` 1 lần.

## 8. Risks / giới hạn

- Panel render 1000 dòng → phải virtualize (đã chốt).
- Add folder đệ quy có thể quét tổ hợp folder lớn → cap 1000 file + guard.
- Nhánh `feature/android-port` là worktree khác — KHÔNG đụng.
- Playwright E2E không khả thi (Google OAuth thật) → RTL + manual khi user chạy app.
