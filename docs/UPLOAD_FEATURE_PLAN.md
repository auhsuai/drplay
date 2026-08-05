# PLAN: Upload File/Folder (kéo thả + nút +) + Bảo vệ Race + Delta Sync Recently Added

> Phiên này (2026-08-01) viết để phiên SAU đọc là làm được ngay.
> Trạng thái: **CHƯA làm gì** — plan thuần, đã verify mọi điểm chạm bằng đọc code.
> Repo: `C:\Users\thinkpad\Desktop\Antigravity\drplay` — branch `main`, app Tauri v2 + React + Vite + Tailwind + Dexie.

---

## 0. Tóm tắt yêu cầu (user, verbatim ý)

1. **Upload file HOẶC folder** (đều được) bằng 2 cách:
   - Kéo thả vào cửa sổ app, HOẶC
   - Nút dấu cộng `+` đặt BÊN PHẢI chữ "DrPlay" (header trên cùng sidebar).
2. **UI khi đang upload**:
   - File được upload: card **mờ đi** + **spinner xoay** (giống spinner PlayerBar — `LoaderCircle animate-spin`).
   - **Folder cha chứa file đang upload**: có spinner xoay nhưng **KHÔNG mờ** (folder này đã tồn tại trên Drive).
   - Folder được upload (folder mới tạo): cũng **mờ + spinner**.
   - Xong → hết mờ, trở lại UI bình thường.
3. **Bảo vệ race (quan trọng)**: file/folder đang upload (và folder cha) **KHÔNG được di chuyển, xóa, thêm playlist, like...** — mọi action phải chờ upload xong rồi mới cho thao tác. Cần cơ chế phòng vệ đầy đủ (MoreMenu, selection, bulk delete/move, PlayerBar, playlist...).
4. **Delta sync Recently Added**: hiện HomeTab "Recently Added to Drive" chỉ load lúc mount + khi event `recent-updated` (chỉ fire khi PHÁT nhạc — history.ts:52). Muốn **tự cập nhật sau upload** (không cần F5).

---

## 1. Kiến thức codebase ĐÃ VERIFY (đừng tra lại từ đầu)

### 1.1 Upload hiện chưa tồn tại
- `driveApi.ts` có: `createFolder` (140), `deleteFile` (162), `moveFile` (186), `getRecentlyAddedAudioFiles` (267), `searchFolders` (329), `listFolderChildren` (336), `getAppConfig` (394), `getDriveStorageQuota` (520).
- **CHƯA có** hàm upload file → phải viết mới.

### 1.2 Điểm chạm UI (đã đọc)
| File | Vai trò | Ghi chú |
|---|---|---|
| `src/ui/Sidebar/Sidebar.tsx` | Header DrPlay (line ~60-67): `h1` chứa icon HardDrive + chữ DrPlay — **nơi đặt nút `+`** | Thêm button bên phải, style giống nút `+` tạo playlist (line 78-87) |
| `src/ui/MainContent/components/SongCard.tsx` | Card file — **nơi hiện mờ + spinner upload** | Cần prop mới `isUploading` → overlay `opacity` + `<LoaderCircle className="w-5 h-5 animate-spin" />` (pattern PlayerBar.tsx:381) |
| `src/ui/components/MoreMenu.tsx` | Menu 3 chấm — **cần chặn action khi đang upload** | Delete/Move/Playlist/Download... guard |
| `src/ui/MainContent/MainContent.tsx` | VirtualizedSongList (278) — truyền props xuống SongCard | Cần truyền `uploadingIds` |
| `src/hooks/useDriveExplorer.ts` | `handleBulkDelete` (317), bulk-move (370) — **cần guard upload** | + `filteredItems`/`currentItems` |
| `src/ui/HomeTab/HomeTab.tsx` | Recently Added (line 81-93) — **delta sync chỗ này** | Load: `getRecentlyAddedAudioFiles(token)` |
| `src/utils/history.ts` | Fire `recent-updated` (line 52) | Chỉ khi play — thiếu event sau upload |

### 1.3 Spinner chuẩn app
- PlayerBar.tsx:381: `<LoaderCircle className="w-5 h-5 animate-spin" />` (lucide-react `LoaderCircle`).
- MoreMenu khi downloading cũng dùng `LoaderCircle animate-spin text-[#4285F4]`.

### 1.4 Drag & Drop trong Tauri v2 (CHƯA verify runtime — cần tra trước khi code)
- Chưa có `tauri-plugin-drag-drop` trong `src-tauri/Cargo.toml` (đã grep, không thấy).
- Tauri v2 core có `getCurrentWebview().onDragDropEvent()` (API core — `@tauri-apps/api/webview`) — **BẮT BUỘC tra context7 tài liệu Tauri v2 hiện tại** trước khi chọn (plugin vs core API), vì luật skill: không đoán API.
- Cách khác (fallback đơn giản): nút `+` → `open({ directory: false, multiple: true })` (plugin-dialog **đã cài + `dialog:allow-open` đã có trong capabilities** từ task trước — verify!). Folder thì `open({ directory: true })`.

### 1.5 Đọc file từ disk để upload folder (Rust fs scope — QUAN TRỌNG)
- Để upload **folder** cần đọc file từ disk: dùng `tauri-plugin-fs` (đã cài, Cargo.toml có).
- Capabilities hiện chỉ có `fs:allow-write-file` ($DOWNLOAD/**) — **cần thêm** quyền đọc file (VD `fs:allow-read-file` + scope cho đường dẫn user chọn — tương tự pattern `register_download_path` ở `src-tauri/src/lib.rs:25` đã có sẵn để extend scope động).
- **BẮT BUỘC tra context7** `tauri-plugin-fs` v2: cách `readFile`/đọc bytes + extend scope (pattern đã có `register_download_path` làm mẫu).

### 1.6 Google Drive upload API (đã research trước — session trước)
- `files.create` multipart: file ≤ 5MB.
- **Resumable upload** (nhạc thường 5-50MB → cần cái này):
  1. `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable` + header `X-Upload-Content-Type`/`X-Upload-Content-Length`, body = JSON metadata `{name, parents:[folderId]}` → response header `Location` = upload URI.
  2. `PUT <uploadUri>` với body bytes + header `Content-Range: bytes 0-<size-1>/<size>` → 200/201 = xong. (Có thể 1-shot PUT toàn bộ, không cần chunk vì file audio vừa; nếu muốn chunk → tra docs resumable chunk.)
- **Quota**: upload = 50 quota units/request; 750GB/ngày/user; file max 5TB — an toàn. **Nhớ check storageQuota trước khi upload** (đã có `getDriveStorageQuota` — dùng nó, nếu `usage ≥ limit` → chặn + toast "hết dung lượng").

### 1.7 Điểm mấu chốt race (user nhấn mạnh)
Các nơi có thể thao tác lên file đang upload:
- MoreMenu: Delete (useMenuDelete → deleteFile), Move to (handleMove → moveFile), Add to Playlist (useMenuPlaylists), Download (useMenuDownload), Select multiple.
- useDriveExplorer: handleBulkDelete (317), bulk move (370).
- **GIẢI PHÁP đề xuất**: 1 nguồn sự thật tập trung — module `src/utils/uploadManager.ts` (module-level singleton, export `isUploading(id)`, `getUploadingIds()`, subscribe via CustomEvent `upload-progress`/`upload-status-changed`). Mọi guard đọc từ đó. **KHÔNG** tạo state local rải rác (race).
- SongCard/MoreMenu nhận `isUploading` → disabled + spinner. useDriveExplorer guard bulk ops: filter ra ids đang upload + toast "đang upload".

---

## 2. Kiến trúc đề xuất (single source of truth)

```
src/utils/uploadManager.ts        ← MỚI: singleton quản lý upload queue + status
src/utils/driveApi.ts             ← THÊM: uploadFileResumable(), createFolderAndUpload()...
src/ui/components/UploadButton.tsx ← MỚI (hoặc nhét Sidebar): nút + header DrPlay
src/ui/Sidebar/Sidebar.tsx        ← THÊM: render UploadButton cạnh chữ DrPlay + kéo thả overlay
src/ui/MainContent/components/SongCard.tsx ← THÊM: prop isUploading (mờ + spinner)
src/ui/components/MoreMenu.tsx    ← THÊM: guard isUploading (disable delete/move/playlist/download)
src/hooks/useDriveExplorer.ts     ← THÊM: guard bulk delete/move (bỏ ids đang upload)
src/ui/HomeTab/HomeTab.tsx        ← THÊM: delta sync (event mới + refresh after upload)
src/hooks/useMenuPlaylists.ts     ← THÊM: guard add-to-playlist khi đang upload (nếu cần)
src-tauri/capabilities/default.json ← THÊM: fs read quyền + scope (nếu upload folder)
src-tauri/src/lib.rs              ← CÓ THỂ THÊM: command extend fs scope đọc file (pattern register_download_path)
```

### 2.1 `uploadManager.ts` — contract chốt cứng (viết test trước)
```ts
export interface UploadEntry {
  id: string;              // Drive fileId (nếu có) hoặc temp id 'pending-<uuid>'
  name: string;
  isFolder: boolean;
  parentId?: string;       // folder cha trên Drive (nếu upload vào folder có sẵn)
  status: 'queued' | 'uploading' | 'done' | 'error';
  progress?: number;       // 0-100 (nếu có thể báo)
  error?: string;
}

export function startUploads(entries: UploadSeed[]): void;   // đẩy vào queue, tự chạy tuần tự
export function getUploadingIds(): ReadonlySet<string>;      // gồm CẢ folder cha đang chứa file upload
export function isUploading(id: string): boolean;
export function subscribe(cb: (entries: UploadEntry[]) => void): () => void; // fire 'upload-status-changed'
export function getEntries(): UploadEntry[];
```
- **Folder cha**: khi upload file vào folder đã tồn tại → `id` của folder cha cũng vào `getUploadingIds()` (spinner không mờ). Khi upload folder mới → folder mới có id sau khi `createFolder` trả về → thêm vào set.
- Queue **tuần tự** (1 upload/lúc) — tránh race quota + đơn giản UI.
- Fire CustomEvent `upload-status-changed` (detail: entries) → SongCard/MoreMenu/HomeTab lắng nghe (pattern `recent-updated`/`metadata-updated` có sẵn trong repo).

### 2.2 `driveApi.ts` — hàm upload mới
```ts
export async function uploadFileResumable(
  token: string,
  file: Blob | Uint8Array,       // bytes từ disk (folder) hoặc File (drag-drop/file-picker)
  name: string,
  parentId: string,              // folder đích (root = 'root')
  onProgress?: (fraction: number) => void,   // từ X-Upload-Progress? hoặc bỏ — tối thiểu
  signal?: AbortSignal
): Promise<DriveFileItem>;

export async function uploadFolder(
  token: string,
  folderPath: string,            // path disk (chỉ khi drag-drop folder / chọn folder)
  name: string,
  parentId: string,
  onProgress?: ...
): Promise<{ folder: DriveFileItem; uploadedCount: number }>;
```
- Tái dùng `driveFetch` (retry/backoff/timeout có sẵn) — NHƯNG lưu ý: retry trên PUT resumable có thể gửi lại toàn bộ body — chấp nhận (file nhỏ) hoặc tự quản lý. Ghi rõ quyết định.
- Lỗi: phân loại (quota exceeded 403 → toast hết dung lượng; network → retry có giới hạn; abort → huỷ).

### 2.3 Nút `+` — Sidebar header
- Vị trí: `Sidebar.tsx` line ~60-67 (h1 DrPlay) — thêm button ngay sau chữ DrPlay (bên phải), icon `Plus` (lucide), style giống nút + playlist (line 78-87).
- Click → `open({ directory: false, multiple: true, filters: [{ name: 'Audio', extensions: ['mp3','flac','wav','m4a','ogg','aac','opus'] }] })` (plugin-dialog).
- Folder: nút `+` mở menu nhỏ 2 lựa chọn "Upload file"/"Upload folder"? HOẶC 1 dialog directory:true cho cả 2? **QUYẾT ĐỊNH cho phiên sau**: menu 2 chọn (file/folder) — rõ ràng hơn. Folder → `open({ directory: true })`.
- Sau khi chọn: `startUploads()` với folder đích = **folder hiện tại đang mở** (currentFolderId từ `useDriveStore`) hoặc root.

### 2.4 Kéo thả
- **BẮT BUỘC tra context7 trước**: `getCurrentWebview().onDragDropEvent` (Tauri v2 core) — nhận `{paths: string[], type: 'drop'}` → phân biệt file/folder qua fs (Rust) hoặc dựa vào mime.
- Overlay drop: `dragenter`/`dragleave`/`dragover` trên toàn window → overlay "Thả để upload" (style app: bg đen/50 + border dashed).
- Path nhận được là đường dẫn disk → upload folder cần đọc bytes qua Rust fs (mục 1.5) — hoặc nếu chỉ là file → đọc qua Tauri fs đọc bytes rồi `uploadFileResumable`.

### 2.5 SongCard — mờ + spinner
- Prop mới `isUploading?: boolean`.
- Card: khi true → `opacity-50 pointer-events-none` + overlay spinner giữa card: `<LoaderCircle className="w-5 h-5 animate-spin text-[#4285F4]" />` (center absolute).
- **Folder cha**: nhận `isUploading` true nhưng KHÔNG mờ — cần phân biệt: prop `isUploading` (mờ) vs `isUploadingParent` (chỉ spinner)? **Đơn giản hơn**: truyền `uploadState: 'none' | 'uploading' | 'parent-uploading'` — card mờ khi 'uploading', chỉ spinner khi 'parent-uploading'. Ghi rõ trong plan slice.

### 2.6 Guard race — MoreMenu + useDriveExplorer
- MoreMenu nhận prop `isUploading` → khi true: ẩn/disable các mục Delete, Move to, Download, Add to Playlist (và không mở menu? chọn: disable + title tooltip "Đang tải lên...").
- `useDriveExplorer.handleBulkDelete`/bulk-move: lọc `getUploadingIds()` khỏi selection trước khi thao tác + toast nếu có bị loại.
- `useMenuPlaylists.handleAddToPlaylist`: guard `isUploading(track.id)` → toast.
- Selection mode: card đang upload không vào selection (onToggleSelection guard).

### 2.7 Delta sync Recently Added
- Thêm event mới: uploadManager fire `drive-files-changed` (detail: {count}) sau mỗi upload done.
- `HomeTab.tsx`: listener `drive-files-changed` → `getRecentlyAddedAudioFiles(token)` lại (tái dùng code line 81-93 — extract thành hàm `loadRecentlyAdded(token)`).
- **Bonus nhẹ**: listener `window focus` (app focus) → refresh nếu > 60s kể từ lần load (tránh F5 thủ công khi upload ngoài app). QUYẾT ĐỊNH: làm event-only trước (đúng yêu cầu), focus-poll là optional.
- LƯU Ý: `getRecentlyAddedAudioFiles` dùng `orderBy=createdTime desc&pageSize=5` (line ~270) — sau upload file mới sẽ đứng đầu. OK.

---

## 3. Thứ tự thực hiện (vertical slices — mỗi slice = 1 dispatch riêng, tuần tự)

### Slice 1 — `uploadManager.ts` (nền tảng, KHÔNG UI)
- Tạo singleton + queue tuần tự + status event + `getUploadingIds` (gồm folder cha).
- Test: unit (queue tuần tự, status transitions, folder cha tracking, subscribe/unsubscribe, abort).
- Done: vitest pass, chưa nối UI.

### Slice 2 — `driveApi.ts` upload functions
- `uploadFileResumable` + `uploadFolder` (nếu cần đọc disk — kéo theo Rust fs slice 3).
- Test: mock fetch (resumable 2 bước POST+PUT, lỗi 403 quota, abort).
- **Tra context7 trước**: Google Drive resumable upload API (fields, headers) + Tauri fs read pattern.

### Slice 3 — Rust fs đọc file (CHỈ nếu làm upload folder)
- `lib.rs`: command extend fs scope đọc (pattern `register_download_path` line 25).
- capabilities: thêm `fs:allow-read-file` + scope.
- Test: cargo build + invoke test (nếu có pattern).

### Slice 4 — Nút `+` Sidebar + dialog chọn
- Sidebar header + UploadButton (menu 2 chọn file/folder) → `startUploads`.
- Test component.

### Slice 5 — Drag & drop (tra context7 trước, chọn core API)
- onDragDropEvent + overlay drop + gọi startUploads.
- Test: khó unit — tối thiểu component overlay; verify tay trên WebView2.

### Slice 6 — SongCard mờ + spinner (+ truyền qua MainContent/VirtualizedSongList/FullRecentView)
- Prop `uploadState` + overlay spinner.
- Test component (3 trạng thái).

### Slice 7 — Guard race
- MoreMenu disable + useDriveExplorer bulk guard + playlists guard + selection guard.
- Test: mỗi guard 1-2 case.

### Slice 8 — Delta sync Recently Added
- Event `drive-files-changed` + HomeTab listener + extract loadRecentlyAdded.
- Test component HomeTab (mock driveApi, fire event → refetch).

### Verify cuối
- `npm test` full (hiện 50 files/467), `npx tsc --noEmit`, `npm run build`, cargo build.
- **Chạy app thật trên WebView2**: upload 1 file mp3 nhỏ → thấy mờ + spinner → xong hết mờ → Recently Added cập nhật không cần F5 → thử delete/move khi đang upload → bị chặn.
- Verify encoding (byte-level) mọi file mới có tiếng Việt.

---

## 4. Bẫy / lưu ý (đọc kỹ trước khi code)

1. **KHÔNG đoán API Tauri**: drag-drop + fs read → bắt buộc context7/duckduckgo trước (Luật 3). Drag-drop trên WebView2 có thể khác tài liệu — thử thật.
2. **`driveFetch` retry + resumable PUT**: retry toàn bộ body có thể gây lỗi "already uploaded" — cân nhắc disable retry cho PUT (hoặc dùng Content-Range chuẩn). Ghi rõ.
3. **Folder cha tracking**: id folder cha phải có TRƯỚC khi upload file con (folder đã tồn tại trên Drive → có id; folder mới → id sau createFolder). Xử lý thứ tự trong uploadManager.
4. **Race selection**: selection-mode guard phải đọc cùng 1 `getUploadingIds()` — không copy state.
5. **Capabilities**: thêm fs read scope động — KHÔNG mở rộng bừa (chỉ allow đường dẫn user chọn), bảo mật là ưu tiên của user.
6. **Spinner folder cha không mờ**: phân biệt 2 trạng thái rõ ràng trong UI (mờ = chính nó đang upload; chỉ spinner = cha của file đang upload).
7. **i18n**: mọi text mới ("Đang tải lên...", "Upload", "Thả để upload", "Upload folder") thêm cả vi + en, verify encoding.
8. **Toast**: dùng `showErrorToast`/`showSuccessToast` (đã có — toast-root đã fix ở session trước).
9. **`storageQuota` check trước upload**: dùng `getDriveStorageQuota` (đã có) — `usage ≥ limit` → chặn + toast. Limit null (unlimited) → bỏ qua check.
10. **Lưu ý commit**: working tree đang sạch sau khi push `967f474` (storage quota). Mỗi slice commit riêng.

## 5. Nguồn đã tra (session trước, tái dùng)
- Google Drive resumable upload: developers.google.com/workspace/drive/api/guides/manage-uploads (đã fetch 2026-08-01).
- Quota: developers.google.com/workspace/drive/api/guides/limits (cập nhật 2026-05-01).
- storageQuota: developers.google.com/workspace/drive/api/reference/rest/v3/about.

---

## 6. QUYẾT ĐỊNH PHIÊN THỰC THI (2026-08-02 — đã verify + context7, ghi ADR codebase-memory)

1. **Drag & drop = core API** `getCurrentWebview().onDragDropEvent()` từ `@tauri-apps/api/webview`
   (context7 v2.tauri.app 2026-08-02) — KHÔNG cần plugin mới. `drop` → `paths: string[]`.
2. **Đọc file = `tauri-plugin-fs`** (đã cài): `readFile(path) → Uint8Array`, `readDir(path, {recursive:true})`
   để walk folder. Rust: command mới `register_upload_path` (pattern `register_download_path` lib.rs:25),
   capabilities thêm `fs:allow-read-file` + `fs:allow-read-dir`.
3. **Resumable 2 bước**: POST `?uploadType=resumable` (headers X-Upload-*, body metadata) → `Location`
   → PUT full body + `Content-Range: bytes 0-(N-1)/N` → 200/201. KHÔNG chunk, KHÔNG progress (spinner đủ).
   Bước PUT KHÔNG retry tự động (sau 200 mà gửi lại → upload mới); retry cả luồng do uploadManager làm,
   max 2 lần lỗi tạm thời. Timeout PUT = 120s (không dùng 20s mặc định).
4. **uploadManager = single source of truth** — mọi guard đọc `getUploadingIds()` từ module singleton,
   CẤM state local. Fire `upload-status-changed` (detail entries) + `drive-files-changed` (detail {count}).
5. **Pending row cơ chế hiển thị**: bắt đầu upload → `db.files.put({id:'pending-<uuid>', ...})` →
   Dexie live query tự hiện card → SongCard `uploadState: 'uploading'` (mờ + spinner). Done → xoá pending,
   put row thật. Error → xoá pending + toast. Folder mới: pending folder row → createFolder → row thật,
   giữ 'uploading' tới khi hết children.
6. **Folder upload**: KHÔNG hàm riêng — uploadManager compose: `walkDiskFolder` (diskFs.ts wrapper
   plugin-fs, test inject fake) → `createFolder` (có sẵn) → mỗi file con = 1 UploadEntry vào queue
   (tái dùng pending-row). driveApi chỉ thêm `uploadFileResumable` + `UploadError` (kind:
   quota|network|auth|invalid|aborted).
7. **Quota**: check `getDriveStorageQuota` trước mỗi file; `limit!==null && usage+size>limit` → error 'quota' + toast.
8. **Nút +**: menu 2 chọn Upload file / Upload folder (plugin-dialog `open()`, `dialog:allow-open` đã có).
   Đích = currentFolderId (driveStore). Token: `startUploads(seeds, token)`.
9. **MoreMenu guard**: đọc `uploadManager.isUploading(driveItem?.id ?? track?.id)` NGAY TRONG component
   (không cần prop mới — 3 call site PlayerBar/recent/default không đổi prop).
10. **SongCard memo comparator** phải thêm `uploadState` (nếu không card không re-render hết mờ).
11. **i18n**: section `upload.*` (button_title, upload_file, upload_folder, drop_overlay, uploading,
    quota_exceeded, error, uploading_blocked) — cả vi + en.

### Thứ tự dispatch (tuần tự, mỗi slice 1 subagent, commit riêng sau verify)
1. Slice 1: `uploadManager.ts` (+test) — mock driveApi
2. Slice 2: `driveApi.ts` uploadFileResumable + UploadError (+test mock fetch)
3. Slice 3: Rust `register_upload_path` + capabilities + `src/utils/diskFs.ts`
4. Slice 4: Sidebar UploadButton (menu file/folder + dialog)
5. Slice 5: Drag & drop overlay + onDragDropEvent
6. Slice 6: SongCard uploadState + spinner (MainContent/VirtualizedSongList truyền)
7. Slice 7: Guards race (MoreMenu + useDriveExplorer bulk + selection + useMenuPlaylists)
8. Slice 8: HomeTab delta sync (drive-files-changed listener)
