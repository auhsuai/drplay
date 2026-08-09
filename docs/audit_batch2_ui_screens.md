# Audit Batch 2 — UI screens

Ngày: 2026-08-09
Scope: 6 file UI — audit-only, KHÔNG sửa code.
Project: drplay (Tauri v2 + React 19.2 + TypeScript 5.8 strict + zustand 5 + lucide-react 1.22 + react-easy-crop 6.0.2 + react-i18next 17)

**LƯU Ý KHÁC BIỆT SO VỚI MÔ TẢ GIAO VIỆC (5C.1):**
1. `TrashScreen.tsx` thực tế **555 dòng** (mô tả: 447).
2. `useFolderPicker.ts` thực tế **356 dòng** (mô tả: ~300+); có **4 catch** chứ không phải 3: 3× `catch (e)` (137, 298, 309) + 1× `catch (e: unknown)` (171) — không nhất quán style ngay trong cùng file.
3. `PlaylistView.tsx` có **4 catch** (44, 98, 113, 168) — 1× `catch (e)` + 3× `catch (err)` (mô tả: 1×).
4. **Mojibake KHÔNG tồn tại** — đã verify byte-level (`Encoding.UTF8.GetString` + kiểm tra U+FFFD): `errorLog.ts:20-21` sạch UTF-8 tiếng Việt hợp lệ ("để tránh race khi capture song song"). Console PowerShell render sai encoding, file thì không.
5. Commit `36dd123` (bulk ops allSettled trong TrashScreen) đã xác nhận qua `git show` — không đề xuất lại.

---

## File 1: `src/ui/Settings/TrashScreen.tsx` (555 dòng)

### Pattern: 5× `catch (e)` không annotate (dòng 87, 116, 164, 215, 265)
- Hiện tại: `catch (e) { void captureError({ level: "error", source: TRASH_MODULE, message: \`fetch-trashed-failed: ${e instanceof Error ? e.message : String(e)}\` }); showErrorToast(...); }` — tất cả 5 catch đều: typed qua TS strict (`useUnknownInCatchVariables`), log có context (module `TRASH_MODULE` + prefix hành động + message), fallback toast + finally setState. Không catch nào nuốt lỗi.
- Search đã làm: MDN try/catch + TS 4.4 `useUnknownInCatchVariables` (đã chốt ở audit batch 1 — tsconfig `"strict": true`).
- 2026 khuyến nghị: **giữ nguyên** — annotate `(e: unknown)` không đổi hành vi/type (strict đã ngầm unknown), chỉ style. Batch 1 kết luận tương tự cho 6 file core.
- Mức độ tự tin: Cao
- Rủi ro nếu nâng cấp: không có lợi ích; chuẩn hoá nên làm toàn codebase (cross-file #2) nếu làm.

### Pattern: Outside-click manual — useEffect + `document.addEventListener("mousedown")` + `ref.contains` (dòng 57-72)
- Hiện tại:
  ```tsx
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) setIsMoreMenuOpen(false);
    };
    if (isMoreMenuOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isMoreMenuOpen]);
  ```
- Search đã làm: "react detect outside click best practice useEffect mousedown ref contains" — pattern chuẩn vẫn là useEffect + document listener + `ref.contains()` (reactuse.com/blog/detect-click-outside-react, SO 32553158, dev.to/4-ways...). Không có API React built-in mới thay thế.
- 2026 khuyến nghị: **giữ nguyên** (pattern này là chuẩn). NHƯNG ghi nhận DRY: y hệt pattern này lặp **5 lần** trong codebase (TrashScreen:67, UploadButton.tsx:69, useMoreMenuEvents.ts:51, ThemeDropdown.tsx:24, LanguageDropdown.tsx:19) → candidate extract `useClickOutside` hook dùng chung. Đây là refactor lan nhiều file → giao closed-loop-refactor, KHÔNG phải modernize 1 file. Threshold đạt: DRY (tiêu chuẩn ngành).
- Mức độ tự tin: Cao
- Rủi ro nếu nâng cấp: extract hook đổi 5 consumer; rủi ro thấp (pure refactor) nhưng ngoài phạm vi 6 file này.

### Pattern: `eslint-disable-next-line react-hooks/set-state-in-effect` (dòng 100-104)
- Hiện tại: `// fetchTrashed only sets state after await, but the React Compiler lint rule (set-state-in-effect) still traces the finally-setState through the try/catch exception edges, so the disable stays.` + disable trên `void fetchTrashed();`
- Search đã làm: react.dev chính thức https://react.dev/reference/eslint-plugin-react-hooks/lints/set-state-in-effect — rule flag "Setting loading state synchronously" (đúng case này) nhưng docs công nhận async fetch trong effect là hợp lệ ("You do need Effects to synchronize with external systems... you can also fetch data with Effects"); ví dụ hợp lệ trong docs là setState SAU await (fetchData().then(() => setLoading(false))).
- 2026 khuyến nghị: **giữ nguyên** — disable có comment giải thích chính xác cơ chế rule (trace exception edges); `isLoading` khởi đầu `true` (comment RC-B giải thích vì sao — tránh flash empty state). Không có cách "chuẩn hơn": đây là fetch-on-mount hợp lệ.
- Mức độ tự tin: Cao

### Pattern: Bulk ops qua `Promise.allSettled` + per-item captureError (dòng 134-163, 181-224, 232-264)
- Hiện tại: `Promise.allSettled(ids.map(...))` → đếm `failedCount`, chỉ xoá succeeded khỏi list/selection, toast đếm số fail, `finally` clear `isBulkActioning`. 3 khối gần giống nhau (empty trash / bulk restore / bulk delete) — chỉ khác message prefix + hàm gọi.
- Search đã làm: MDN Promise.allSettled (đã chốt batch 1).
- 2026 khuyến nghị: **giữ nguyên** — đã refactor đúng ở commit 36dd123 (git show xác nhận: "bulk ops via allSettled - partial failure aware", kèm 3 test RED→GREEN). KHÔNG đề xuất lại như nhiệm vụ dặn.
- Ghi chú micro-nit: 3 khối forEach kết quả lặp cấu trúc giống nhau (succeededIds/failedCount) — candidate extract helper thuần nếu Main Agent muốn (nhưng 2 trong 3 có sự khác biệt thật: empty-trash có onClose, bulk có selection update → lợi ích gộp khiêm tốn, không đạt threshold ≥20%).
- Mức độ tự tin: Cao

### Pattern: `files.map((f: TrashedItem) => ({...}))` — identity-narrowing (dòng 80-86)
- Hiện tại: map `DriveFileItem` (có thêm size/parents/trashed/createdTime/modifiedTime — đã verify `src/utils/driveTypes.ts:4-13`) → `TrashedItem` 3 field.
- 2026 khuyến nghị: **giữ nguyên** — narrowing có mục đích (state giữ shape ổn định tối thiểu), không phải copy vô nghĩa.
- Mức độ tự tin: Cao

### Pattern: Lucide icons (dòng 2-13)
- Hiện tại: `Trash2, X, RefreshCw, LoaderCircle, TriangleAlert, FileHeadphone, Folder, Check, SquareCheckBig, Ellipsis` — 10 icon.
- Search đã làm: lucide.dev/icons/file-headphone (icon canonical, created v0.68.0); lucide.dev/guide/react/advanced/aliased-names; verify local `node_modules/lucide-react/dist/lucide-react.d.ts` — cả 10 icon tồn tại với tên canonical (TriangleAlert thay AlertTriangle, SquareCheckBig thay CheckSquare, Ellipsis thay MoreHorizontal — đều là canonical mới).
- 2026 khuyến nghị: **giữ nguyên** — canonicalisation (commit 952c5c5) đã áp dụng đầy đủ ở file này, không còn alias cũ.
- Mức độ tự tin: Cao

### Pattern: Backdrop close `e.target === e.currentTarget` + cast `e.target as Node` (dòng 290-293, 61)
- 2026 khuyến nghị: **giữ nguyên** — cast cho `contains()` là bắt buộc (Node type), guard đúng chuẩn (chỉ đóng khi click backdrop, không phải dialog).
- Mức độ tự tin: Cao

### Test companion: ✅ `src/ui/Settings/TrashScreen.test.tsx` — skeleton loading (5 tests), bulk ops (partial failure: "1 item fails → other items still restored + list updates only succeeded", selection cleared only for succeeded, empty trash partial → no onClose) — 8+ tests, khớp commit 36dd123.

---

## File 2: `src/ui/LikedSongs/LikedSongs.tsx` (264 dòng)

### Pattern: 2× `catch (e)` (dòng 61, 86)
- Hiện tại: như các file khác — strict-unknown + captureError có context + toast. Không nuốt lỗi.
- 2026 khuyến nghị: **giữ nguyên** (style-only, đã chốt batch 1).
- Mức độ tự tin: Cao

### Pattern: Dead prop `token` (interface dòng 19, destructure dòng 24, caller TabContentRouter.tsx:161)
- Hiện tại: `interface LikedSongsProps { onPlay; token: string | null; currentTrack }` nhưng `export function LikedSongs({ onPlay, currentTrack }: LikedSongsProps)` — **`token` không được destructure/dùng ở đâu**; caller vẫn truyền `token={token}` (TabContentRouter.tsx:161).
- Search đã làm: N/A — code chết thuần, không cần tra cứu lib.
- 2026 khuyến nghị: **xoá code chết (backlog)** — gỡ `token` khỏi interface + destructure + caller. Threshold đạt: tiêu chuẩn ngành (dead code). NHƯNG đụng 2 file (LikedSongs.tsx + TabContentRouter.tsx) + đổi props contract của component (1 consumer duy nhất) → để Main Agent quyết định task (xoá đơn giản, có thể làm ngoài modernize skill).
- Mức độ tự tin: Cao (grep xác nhận token không xuất hiện trong thân component)
- Rủi ro nếu nâng cấp: thấp — 1 consumer duy nhất; nếu có kế hoạch dùng token sau này thì giữ lại cũng vô hại.

### Pattern: Event subscription window events (dòng 39-55)
- Hiện tại: `addEventListener(FAVORITES_UPDATED_EVENT + "user-changed", handleUpdate)` + cleanup removeEventListener trong effect `[]`.
- 2026 khuyến nghị: **giữ nguyên** — subscribe/cleanup chuẩn React. (Không áp dụng `useSyncExternalStore`: nguồn là dexie async + fetch-on-event, không phải external store sync-readable.)
- Mức độ tự tin: Cao

### Pattern: Race — `loadFavorites` không ignore-guard (dòng 29-68)
- Hiện tại: effect `[]` gọi `loadFavorites()`; `handleUpdate` gọi lại khi event. Không có `ignore` flag; nếu 2 lần load chồng nhau, kết quả chậm nhất ghi đè.
- 2026 khuyến nghị: **giữ nguyên** — nguồn là dexie cục bộ (near-instant), cả 2 lần đọc cùng dữ liệu → kết quả gần như không bao giờ lệch; setState sau unmount là no-op từ React 18. Không đạt threshold (rủi ro lý thuyết, không phải bug quan sát được).
- Mức độ tự tin: Trung bình
- Ghi chú: nếu sau này đổi sang fetch mạng cho favorites → bắt buộc thêm ignore/Abort guard (theo react.dev "Fetching data" — ignore flag).

### Pattern: `useVirtualizer` + `eslint-disable-next-line react-hooks/incompatible-library` (dòng 74-80)
- Hiện tại: disable có comment giải thích (react-hooks compiler không phân tích được internals của @tanstack/react-virtual; options object là data bag thuần).
- 2026 khuyến nghị: **giữ nguyên** — disable hợp lệ, đây là pattern chuẩn khi dùng tanstack virtual.
- Mức độ tự tin: Cao

### Test companion: ❌ **KHÔNG có** LikedSongs.test.tsx → coverage gap (Giai đoạn 3 nếu có upgrade ở file này sẽ không có regression coverage).

---

## File 3: `src/ui/components/ImageCropperModal.tsx` (201 dòng)

### Pattern: react-easy-crop v6 usage (dòng 113-122, import dòng 2-3)
- Hiện tại: `import type { Area } from "react-easy-crop"; import Cropper from "react-easy-crop";` + props `image/crop/zoom/aspect={1}/onCropChange/onCropComplete/onZoomChange/objectFit="cover"`.
- Search đã làm:
  - context7 `/valentinh/react-easy-crop`: getting-started + props.md — mọi prop dùng (crop, zoom, aspect, onCropChange, onCropComplete, onZoomChange, objectFit) khớp chính xác docs v6; `Area` type export từ root (`onCropComplete(croppedArea: Area, croppedAreaPixels: Area) => void`).
  - GitHub releases react-easy-crop: v6.0.0 breaking change = "Modernize build and test tooling" (KHÔNG đổi API); v6.1.0 thêm debounce onCropComplete khi resize bursts; v6.2.3 fix CJS type exports.
  - Verify local `node_modules/react-easy-crop/index.d.mts`: `Area { width, height, x, y }` + CropperProps đúng.
- 2026 khuyến nghị: **giữ nguyên** — API usage đang đúng chuẩn v6 hiện tại (project cài 6.0.2, latest 6.2.3).
- Ghi chú backlog: bump dep 6.0.2 → 6.2.3 (fix CJS types #663 + debounce resize #653) — là dependency bump, không phải modernize code.
- Mức độ tự tin: Cao (docs chính thức context7 + d.ts local)
- Rủi ro nếu nâng cấp: không cần nâng cấp code; bump dep có thể kiểm qua test sẵn có.

### Pattern: 1× `catch (e)` (dòng 66) trong handleSave
- Hiện tại: catch → captureError + toast + finally setIsProcessing(false). Chuẩn.
- 2026 khuyến nghị: **giữ nguyên**.
- Mức độ tự tin: Cao

### Pattern: `getCroppedImg` — `new Promise` executor + Image onload/onerror (dòng 168-201)
- Hiện tại: canvas 512×512 (const có tên + comment "optimal quality vs storage"), `ctx` null-check reject, `canvas.toDataURL("image/jpeg", 0.8)`, `image.onerror = reject`.
- Search đã làm: N/A — pattern thuần (không lib); source là data URL từ FileReader (local, load tin cậy) nên thiếu timeout không phải rủi ro thật. `Promise.withResolvers` (MDN, Baseline 2024) chỉ đổi style ~0 dòng, không rút ngắn.
- 2026 khuyến nghị: **giữ nguyên** — đã có error path đầy đủ (onerror, ctx null), không rò rỉ, không nuốt lỗi.
- Mức độ tự tin: Cao

### Pattern: Focus management + Escape handler (dòng 29-45)
- Hiện tại: lưu `document.activeElement`, focus dialog on mount, restore on unmount; Escape đóng khi `!isProcessing`; listener cleanup chuẩn.
- 2026 khuyến nghị: **giữ nguyên** — đúng chuẩn WAI-ARIA APG dialog pattern (test companion assert chính xác các semantics này).
- Mức độ tự tin: Cao

### Test companion: ✅ `src/ui/components/ImageCropperModal.test.tsx` — mock react-easy-crop (vi.mock dòng 9), test WAI-ARIA APG dialog semantics (aria-labelledby, focus restore), close guards while processing, backdrop close. **KHÔNG test** getCroppedImg/canvas path (mock toàn bộ cropper).

---

## File 4: `src/ui/components/MoreMenu/useMenuMove.ts` (69 dòng)

### Pattern: 1× `catch (e)` (dòng 57-65)
- Hiện tại: `await moveFile(...); await db.files.update(...); if (onRemoveItem) onRemoveItem(itemId);` catch → captureError + toast + `onRefresh?.()`.
- 2026 khuyến nghị: **giữ nguyên** — chuẩn: typed unknown, log context, fallback refresh (re-sync cache), không nuốt lỗi.
- Ghi chú: nếu `db.files.update` fail SAU khi moveFile thành công trên Drive → toast "move_error" hơi sai ngữ nghĩa (Drive đã move) nhưng `onRefresh` sẽ re-sync → hành vi fail-safe hợp lý, không phải bug. Không đề xuất thay đổi.
- Mức độ tự tin: Cao

### Pattern: Early-return guard + close sequence (dòng 38-51)
- Hiện tại: guard thiếu driveItem/token/currentFolderId; newParentId === currentFolderId → close không move; đóng menu TRƯỚC await (UX không block).
- 2026 khuyến nghị: **giữ nguyên** — logic đúng thứ tự (optimistic close + background move).
- Mức độ tự tin: Cao

### Test companion: ⚠️ không có useMenuMove.test riêng; `MoreMenu.test.tsx` mock `moveFile` + assert `onRemoveItem` được gọi (dòng 219-243) — coverage gián tiếp qua component.

---

## File 5: `src/ui/Playlist/PlaylistView.tsx` (391 dòng)

### Pattern: 4× catch không annotate — 1× `catch (e)` (44) + 3× `catch (err)` (98, 113, 168)
- Hiện tại: tất cả đều typed-unknown ngầm + captureError context + toast. Không nuốt lỗi.
- 2026 khuyến nghị: **giữ nguyên** (style-only).
- Mức độ tự tin: Cao

### Pattern: `MAX_COVER_BYTES = 5 * 1024 * 1024` khai báo TRONG component body (dòng 124)
- Hiện tại: const thuần, không phụ thuộc props/state, bị tạo lại mỗi render.
- 2026 khuyến nghị: **giữ nguyên (micro-nit)** — nên ở module scope nhưng không đạt threshold nào; nếu Main Agent muốn thì đây là thay đổi 1-dòng fast-lane-style (const hoisting), không đáng 1 dispatch.
- Mức độ tự tin: Cao

### Pattern: `React.useRef` (dòng 37) + `useRef` (dòng 38) — 2 cách trong cùng file
- Hiện tại: `const fileInputRef = React.useRef<HTMLInputElement>(null);` và `const scrollRef = useRef<HTMLElement>(null);` — import `useRef` đã có (dòng 1).
- 2026 khuyến nghị: **giữ nguyên (micro-nit style)** — không đạt threshold; `React.useRef` hoạt động đúng (namespace import cần cho React.MouseEvent type anyway).
- Mức độ tự tin: Cao

### Pattern: FileReader.readAsDataURL → base64 (dòng 142-155)
- Hiện tại: validate type + size → `reader.onload` setSelectedImage + open cropper; `reader.onerror` captureError + toast; reset `input.value = ""` cho phép chọn lại cùng file.
- Search đã làm: N/A — so sánh phương án `URL.createObjectURL`: thay FileReader để preview nhưng vẫn cần base64 cho lưu (cropper output); thêm lifecycle revokeObjectURL → net dòng không giảm, thêm rủi ro leak nếu quên revoke. Không đạt threshold.
- 2026 khuyến nghị: **giữ nguyên**.
- Mức độ tự tin: Trung bình

### Pattern: loadPlaylist useCallback + event sub + prefetch effect (dòng 40-80)
- Hiện tại: `loadPlaylist` useCallback([playlistId, t]); effect sub "playlists-updated" + "user-changed" với cleanup; prefetch effect riêng.
- 2026 khuyến nghị: **giữ nguyên** — chuẩn.
- Mức độ tự tin: Cao

### Test companion: ❌ **KHÔNG có** PlaylistView.test.tsx → coverage gap (2 luồng chưa có regression: handleSaveCover/ImageCropperModal wiring, handleRemove).

---

## File 6: `src/ui/FolderSelection/useFolderPicker.ts` (356 dòng)

### Pattern: 4 catch — `catch (e)` ×3 (137, 298, 309) + `catch (e: unknown)` ×1 (171)
- Hiện tại: 3 catch không annotate nhưng dòng 171 annotate — không nhất quán ngay trong 1 file. Tất cả đều: phân loại abort (`isAbortError` → return im lặng đúng chuẩn — abort do chính code gây ra không phải lỗi user), `classifyFolderError` cho log, fallback setState + toast. Không nuốt lỗi.
- 2026 khuyến nghị: **giữ nguyên** — style-only; nếu chuẩn hoá thì nên chuẩn hoá toàn codebase (batch 1 cross-file #3), không làm riêng file này.
- Mức độ tự tin: Cao

### Pattern: "Adjusting state during render" ×3 block (dòng 68-102)
- Hiện tại:
  ```ts
  const [lastFetchedFolderId, setLastFetchedFolderId] = useState(currentFolderId);
  if (lastFetchedFolderId !== currentFolderId) {
    setLastFetchedFolderId(currentFolderId);
    setSearchQuery("");
    setApiSearchResults([]);
  }
  ```
  (2 block sau tương tự cho apiSearchActive + lastSearchQuery)
- Search đã làm: react.dev https://react.dev/learn/you-might-not-need-an-effect — recap chính thức: *"To reset a particular bit of state in response to a prop change, **set it during rendering**"*; mục "Adjusting some state when a prop changes" dùng CHÍNH pattern track previous-value + setState trong render.
- 2026 khuyến nghị: **giữ nguyên** — đây LÀ pattern React chính thức khuyến nghị 2026 (thay cho setState-in-effect). Comment trong code giải thích "why" đầy đủ. KHÔNG đổi.
- Mức độ tự tin: Cao (docs chính thức)

### Pattern: `eslint-disable-next-line react-hooks/set-state-in-effect` (dòng 211) + `exhaustive-deps` (219)
- Hiện tại: comment giải thích: fetchFolders setState sync chính là loading transition (effect LÀ fetch trigger); delay setState sau await sẽ flash nội dung folder cũ. Deps `[currentFolderId, token]` chủ đích (fetchFolders/cancelFolderFetch identity đổi mỗi render).
- Search đã làm: react.dev lints/set-state-in-effect — docs công nhận fetch-trigger effect hợp lệ; 2 disable đều có lý do chính xác.
- 2026 khuyến nghị: **giữ nguyên**.
- Mức độ tự tin: Cao

### Pattern: AbortController + isAborted race-guard + isAbortError (dòng 109-152, helper 16-32)
- Hiện tại: `cancelFolderFetch()` abort trước fetch mới; `isAborted(controller)` check sau MỖI await (db + network); finally chỉ clear khi controller còn là hiện tại (`foldersAbortRef.current === controller`) — chống stale finally ghi đè state của fetch mới. `isAborted` indirection có comment giải thích vì sao (typescript-eslint flow narrowing "never aborted").
- 2026 khuyến nghị: **giữ nguyên** — race-guard đầy đủ, trên chuẩn trung bình.
- Mức độ tự tin: Cao

### Pattern: Drive query escape (dòng 165) + query string build
- Hiện tại: `query.replace(/\\/g, "\\\\").replace(/'/g, "\\'")` trước khi nhúng vào `name contains '...'` — chống query injection; `DRIVE_FOLDER_MIME_TYPE` constant có tên.
- Search đã làm: grep cross-codebase — escape pattern này chỉ có 1 chỗ (không lặp để extract); diskFs.ts:329 có replace khác ngữ cảnh.
- 2026 khuyến nghị: **giữ nguyên** — cần thiết, đúng chỗ.
- Mức độ tự tin: Cao

### Pattern: Cấu trúc file 356 dòng — có nên tách helper thuần?
- Hiện tại: state 9 biến + 3 render-adjust block + 4 effect + 5 handler; helpers (classifyFolderError/isAbortError/isAborted/FolderItem) ĐÃ tách sẵn sang folderSelectionHelpers.ts.
- 2026 khuyến nghị: **giữ nguyên** — phần đã tách được thì đã tách; phần còn lại gắn chặt state hook (không tách được thành helper thuần dễ test mà không đổi thiết kế). Không đạt threshold.
- Mức độ tự tin: Cao

### Pattern: `setIsSearchingApi(false)` trong finally không abort-guard (dòng 181-183)
- Hiện tại: finally luôn set false kể cả khi abort. Race lý thuyết: abort request cũ → finally cũ set false trong khi request mới đang chạy.
- 2026 khuyến nghị: **giữ nguyên** — phân tích: abort xảy ra trong cleanup debounce effect; request mới chỉ bắt đầu sau 300ms debounce → cửa sổ race đã bị debounce neutralise thực tế. Chỉ là ghi chú, không phải bug quan sát được.
- Mức độ tự tin: Trung bình

### Test companion: ⚠️ không có hook-only test; `FolderSelectionScreen.test.tsx` cover gián tiếp qua screen (không thấy renderHook cho useFolderPicker — grep `useFolderPicker|renderHook` = 0 kết quả).

---

## Cross-file findings (backlog — KHÔNG sửa)

1. **Outside-click `mousedown + contains` pattern lặp 5 chỗ**: `src/ui/Settings/TrashScreen.tsx:67`, `src/ui/components/UploadButton.tsx:69`, `src/ui/components/MoreMenu/useMoreMenuEvents.ts:51`, `src/ui/Settings/components/ThemeDropdown.tsx:24`, `src/ui/Settings/components/LanguageDropdown.tsx:19` — extract `useClickOutside` hook dùng chung (DRY, tiêu chuẩn ngành). Đạt threshold DRY nhưng là refactor lan 5+ file → closed-loop-refactor orchestration, không phải modernize 1 file.
2. **`catch (e)`/`catch (err)` không annotate toàn codebase** — 17 chỗ riêng trong 6 file này; tổng 100+ chỗ (đã note ở batch 1 cross-file #3). Style-only, không phải bug. Nếu chuẩn hoá: làm theo batch.
3. **Dead prop `token` của LikedSongs**: interface `LikedSongs.tsx:19` + caller `TabContentRouter.tsx:161` truyền nhưng component (dòng 24) không dùng — xoá code chết (2 file, 1 consumer duy nhất).
4. **react-easy-crop 6.0.2 → 6.2.3** (latest 2026-07): fix CJS type exports #663 + debounce onCropComplete khi resize bursts #653 — dependency bump, không phải modernize code (ImageCropperModal usage không đổi).
5. **`set-state-in-effect` disables**: TrashScreen.tsx:103, useFolderPicker.ts:211 — cả 2 đều có comment lý do đúng; file UI khác có pattern fetch-on-mount tương tự (PlaylistView.tsx:54, LikedSongs.tsx:29) nhưng không cần disable (không có setState sync đầu effect).

## MCP fallback note

Không cần fallback thật: DuckDuckGo MCP có 2/6 search bị bot-detect lần đầu → retry query khác thành công (không phải outage); context7 khả dụng (resolve + query-docs `/valentinh/react-easy-crop`, High reputation). Verify bổ sung bằng d.ts cài đặt thật (react-easy-crop 6.0.2, lucide-react 1.22.0) qua grep local.

Nguồn đã dùng:
- https://react.dev/reference/eslint-plugin-react-hooks/lints/set-state-in-effect (rule chính thức)
- https://react.dev/learn/you-might-not-need-an-effect ("set it during rendering" — recap + mục Adjusting state)
- https://lucide.dev/icons/file-headphone + https://lucide.dev/guide/react/advanced/aliased-names (icon canonical)
- https://github.com/ValentinH/react-easy-crop/releases (v6.0.0 = build tooling only; v6.1.0 debounce; v6.2.3 CJS types)
- context7 /valentinh/react-easy-crop (getting-started, props, callbacks)
- Local: `node_modules/react-easy-crop/index.d.mts` (Area/CropperProps), `node_modules/lucide-react/dist/lucide-react.d.ts`, `src/utils/driveTypes.ts:4-13`, `src/utils/drivePagination.ts:118-131`

## Tổng kết đề xuất

| File | Pattern | Quyết định | Threshold |
|---|---|---|---|
| TrashScreen.tsx | 5× catch (e) | giữ nguyên | — (style-only) |
| TrashScreen.tsx | outside-click manual | giữ nguyên (DRY note → cross-file #1) | DRY nhưng refactor lan 5 file |
| TrashScreen.tsx | set-state-in-effect disable | giữ nguyên | — (đúng docs) |
| TrashScreen.tsx | bulk ops allSettled | giữ nguyên | — (đã refactor 36dd123) |
| LikedSongs.tsx | 2× catch (e) | giữ nguyên | — |
| LikedSongs.tsx | dead prop `token` | **xoá code chết (backlog)** | tiêu chuẩn ngành (dead code) |
| ImageCropperModal.tsx | react-easy-crop v6 | giữ nguyên | — (đúng docs v6; bump dep là backlog) |
| ImageCropperModal.tsx | catch + getCroppedImg | giữ nguyên | — |
| useMenuMove.ts | catch + move sequence | giữ nguyên | — |
| PlaylistView.tsx | 4× catch | giữ nguyên | — |
| PlaylistView.tsx | MAX_COVER_BYTES trong component | giữ nguyên (micro-nit) | — |
| useFolderPicker.ts | 4 catch (3 unannotated + 1 annotated) | giữ nguyên | — (style-only) |
| useFolderPicker.ts | render-time state adjustment ×3 | giữ nguyên | — (CHÍNH là pattern React chính thức) |
| useFolderPicker.ts | AbortController race-guard | giữ nguyên | — (đã trên chuẩn) |

**KẾT LUẬN CHUNG: cả 6 file đã đạt chuẩn 2026 — không có upgrade nào trong 6 file đạt threshold để dispatch modernize. Backlog khả thi: (a) extract `useClickOutside` ×5 (refactor), (b) xoá dead prop `token` LikedSongs (2 file), (c) bump react-easy-crop 6.2.3 (dependency).**
