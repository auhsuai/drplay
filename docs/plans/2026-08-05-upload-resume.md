# PLAN: Upload Resume (Slice 5) — persist queue + session + auto-resume — 2026-08-05

> Trạng thái: PLAN CHI TIẾT — sẵn sàng implement. Ngày: 2026-08-05
> Nguồn: research chính thức developers.google.com/workspace/drive/api/guides/manage-uploads (resumable, session TTL 1 tuần, query-status, pre-generated IDs) + UX (Filestack/uxpatterns.dev/eleken 2026: retry silent, fail-early, per-file state) + audit code thật uploadManager.ts, driveUpload.ts (926 dòng), db.ts (Dexie v8), SettingsTab.tsx, App.tsx (onLogin dòng 275).
> Cách dùng: mỗi slice dispatch ĐÚNG 1 subagent, TUẦN TỰ (5.1 → 5.2 → 5.3 — cùng chạm uploadManager/driveUpload, cấm song song), TDD đỏ→xanh, verify thật.

---

## 0. QUYẾT ĐỊNH ĐÃ CHỐT (brainstorming với user 2026-08-05)

1. **Phạm vi resume**: CHỈ disk-path uploads (diskFile, folderChildFile, folderRoot→children). Bytes uploads (kéo thả Blob vào RAM) KHÔNG persist được payload → app tắt giữa chừng: entry đánh dấu interrupted → mở lại → hủy entry + **1 toast tổng hợp** "upload bị gián đoạn, vui lòng thử lại" (không spam từng file).
2. **Cơ chế**: TỰ ĐỘNG resume khi app mở lại + user đã login. Silent: KHÔNG toast khi resume thành công / đang chạy.
3. **UI**: Section "Uploads dở dang" trong Settings — entries đang resume/đang chạy (tên + tiến trình) + nút hủy. i18n en+vi.
4. **KHÔNG persist offset liên tục**: offset resume lấy từ query-status server (PUT rỗng */total → Range). Chỉ persist uploadUri + clientGeneratedId + filePath + totalSize + name + parentId.
5. **Persist là best-effort**: DB write fail → warn log + upload vẫn chạy (chỉ mất khả năng resume).

## 1. EDGE CASES (research hành vi user — bắt buộc xử lý)

| Tình huống user | Hành vi khi resume |
|---|---|
| Tắt máy/app ngang, ngắt mạng dài | Resume từ byte N (query-status → 308+Range), silent |
| Upload thật sự đã xong trước khi tắt (response mất) | Query 200/201 → markDone silent |
| File bị XÓA trên disk khi upload dở | statDiskPath → null → hủy entry + toast rõ "không tìm thấy file" |
| File bị DI CHUYỂN / ĐỔI TÊN trên disk | diskPath cũ chết → stat null → như xóa: hủy + toast |
| File đổi KÍCH THƯỚC giữa chừng | stat.size ≠ persisted totalSize → session cũ vô dụng (Content-Range sai) → hủy session cũ + upload MỚI từ 0 với size mới (tự chữa, silent) |
| Session TTL 1 tuần (404 khi query) | Hủy entry + toast (không thể resume — mất tiến trình) |
| 4xx khác khi query / 5xx hết retry | Đã xử lý bởi slice 2+3 (restart session / initiate mới từ 0) — giữ nguyên |
| User chưa login khi mở app | Không resume — đợi onLogin → trigger |
| Login account KHÁC | Chỉ resume đúng userEmail (per-user rows); account khác không đụng |
| Nhiều upload dở dang | Resume tuần tự qua queue (pump sẵn có) |
| User cancel từ Settings khi đang resume | cancelUpload như thường → xóa DB row |
| DB write fail | warn log + upload vẫn chạy (best-effort) |

## 2. INTERFACE CHỐT CỨNG (contract giữa các slice — KHÔNG đổi giữa chừng)

### 2.1 DB schema v9 — table `uploadSessions` (db.ts)
```ts
export interface UploadSessionRow {
  id: string;              // = entry.id ('pending-<uuid>') — PK
  userEmail: string;       // per-user (index)
  name: string;
  isFolder: boolean;
  kind: "diskFile" | "folderChildFile" | "folderRoot" | "bytes";
  diskPath?: string;       // undefined cho bytes
  parentId: string;
  totalSize?: number;      // undefined khi chưa stat / bytes
  uploadUri?: string;      // session URI Google — undefined khi chưa initiate
  clientGeneratedId?: string;
  status: "active" | "interrupted";
  createdAt: number;
  updatedAt: number;
}
```
- `this.version(9).stores({ ...existing..., uploadSessions: "id, userEmail, status" })` — forward-only, thêm table, KHÔNG đổi PK table cũ.
- Exposed: `uploadSessions!: Table<UploadSessionRow, string>`.

### 2.2 uploadManager — persist lifecycle (public API cũ KHÔNG đổi)
- MỚI: `persistActiveSession(entry)` — upsert row status='active' (processEntry trước upload + khi có uploadUri via callback).
- MỚI: `clearSession(entry)` — xóa row (markDone/markError/cancel terminal).
- MỚI: `resumeInterruptedUploads(token: string, userEmail: string): Promise<void>` — đọc rows status='active' của user → tạo entries (diskFile/folderChildFile/folderRoot với diskPath; bytes → hủy + đếm) → pump. Guard chạy 1 lần.
- `UploadEntry.status` giữ nguyên union — KHÔNG thêm status mới.

### 2.3 driveUpload — resume từ session lưu
```ts
export interface ChunkedUploadOptions {
  ...existing...
  initialUploadUri?: string | undefined;
  onSessionUpdate?: (uploadUri: string) => void;
}
```
- `uploadFileResumableChunked`: nếu `initialUploadUri` → attempt 0: dùng URI đó + query-status/resume ngay (refactor: đổi điều kiện `attempt > 0 && uploadUri !== null` thành `uploadUri !== null` — attempt 0 có uri cũng qua resume path; MAX_UPLOAD_ATTEMPTS vẫn giới hạn tổng).
- Sau initiate thành công → gọi `onSessionUpdate(uploadUri)` (manager persist row).
- `uploadChunksInSession` giữ nguyên (đã có startOffset).

### 2.4 Settings UI (SettingsTab.tsx)
- Section mới "Uploads dở dang": `subscribe()` → `getEntries()` → render entries queued/uploading (tên + progress %) + nút hủy (cancelUpload).
- Ẩn section khi rỗng (pattern ErrorLogSection).
- i18n mới (en+vi): `settings.uploads_section`, `settings.uploads_cancel`, `upload.interrupted`, `upload.resume_not_found`.

### 2.5 App.tsx — resume trigger
- Trong `onLogin` (dòng ~275): sau khi set tokens → `void resumeInterruptedUploads(token, userEmail)`. Subagent đọc code thật tìm userEmail state.

---

## 3. SLICES — SPEC CHI TIẾT

### SLICE 5.1 — DB schema v9 + persist lifecycle + bytes-interrupted toast
- **File**: `src/db/db.ts` + `src/utils/uploadManager.ts` (+ test).
- **Thay đổi**: (1) db.ts version 9 + uploadSessions + interface 2.1. (2) uploadManager: `persistActiveSession(entry)` trong processEntry trước handleByKind — persist name/isFolder/kind/diskPath/parentId/totalSize (nếu biết)/clientGeneratedId/status active; `clearSession(entry)` tại markDone/markError/cancelQueuedEntry/cancel-aborted. (3) bytes kind: persist row kind='bytes' (để resume biết có bytes bị gián đoạn).
- **Behavior contract**:
  - Upload chạy → row active tồn tại (test assert db.uploadSessions có row).
  - Done/error/cancel → row xóa (test assert không còn).
  - DB fail (mock reject) → upload VẪN chạy, warn log, không block.
  - KHÔNG đổi behavior user-facing trong phiên.
- **Test (TDD)**: (a) processEntry persist row đúng fields; (b) markDone xóa row; (c) markError xóa row; (d) cancel queued + cancel in-flight xóa row; (e) DB reject → upload vẫn chạy + warn log; (f) bytes seed persist row kind='bytes'.
- **Done**: test xanh (đỏ→xanh log cụ thể) + tsc + full suite.

### SLICE 5.2 — Resume thật: initialUploadUri + resumeInterruptedUploads
- **File**: `src/utils/driveUpload.ts` + `src/utils/uploadManager.ts` (+ test 2 file).
- **Thay đổi**:
  1. driveUpload: `ChunkedUploadOptions.initialUploadUri` + `onSessionUpdate`; refactor điều kiện resume (2.3); gọi onSessionUpdate sau initiate.
  2. uploadManager: `resumeInterruptedUploads(token, userEmail)` — đọc rows active của user: disk kinds → tạo InternalEntry (id = row.id mới pending-uuid? KHÔNG — dùng row.id làm entry.id để cancel trùng; ĐỌC code thật: entries dùng id 'pending-<uuid>'; resume nên tạo id MỚI để tránh trùng row cũ — nhưng row cũ phải xóa trước khi tạo entry mới) → xóa row cũ → tạo entry (kind giữ) → pump; bytes → đếm → toast tổng hợp `upload.interrupted` + xóa row. Guard flag chống chạy đồng thời.
  3. uploadDiskPathChunked: nhận `initialUploadUri` từ... ĐỌC code thật: resume tạo entry với trường nội bộ `resumeUri?: string` (InternalEntry) → truyền vào uploadFileResumableChunked opts.initialUploadUri.
  4. Khi stat.size ≠ row.totalSize (file đổi size) → bỏ initialUploadUri (upload mới từ 0, silent). Khi stat null (file mất) → markError + toast `upload.resume_not_found`.
- **Behavior contract**:
  - Resume thành công (308) → continue từ offset server, silent, KHÔNG toast.
  - Query 200/201 → markDone silent.
  - 404 (TTL) → hủy + toast `upload.resume_not_found`.
  - stat null (xóa/di chuyển/đổi tên) → hủy + toast `upload.resume_not_found`.
  - stat.size ≠ totalSize → upload mới từ 0 (silent).
  - bytes rows → toast tổng hợp 1 cái `upload.interrupted`.
  - resumeInterruptedUploads gọi 2 lần liên tiếp → chạy 1 lần (guard).
  - Upload mới (startUploads) + resume cùng lúc → queue tuần tự an toàn.
- **Test (TDD)**: (a) initialUploadUri → query-status 308 → resume tại offset server, initiate count 0; (b) query 200 → done; (c) query 404 → initiate mới từ 0 + toast; (d) stat null → error + toast resume_not_found + row xóa; (e) stat.size ≠ totalSize → upload từ 0 không dùng initialUploadUri; (f) bytes row → toast tổng hợp 1 lần; (g) guard chống double-run; (h) onSessionUpdate được gọi sau initiate + row cập nhật uploadUri; (i) full suite giữ xanh.
- **Done**: test xanh + tsc + full suite.

### SLICE 5.3 — Settings UI + App.tsx trigger
- **File**: `src/ui/Settings/SettingsTab.tsx` + `src/App.tsx` (+ test SettingsTab + i18n 2 file).
- **Thay đổi**: (1) SettingsTab: section mới dùng `subscribe`/`getEntries`/`cancelUpload` từ uploadManager; render tên + progress + nút hủy; ẩn khi rỗng; (2) App.tsx onLogin → `void resumeInterruptedUploads(accessToken, userEmail)`; (3) i18n en+vi: settings.uploads_section, settings.uploads_cancel, upload.interrupted, upload.resume_not_found.
- **Behavior contract**: section hiện entries queued/uploading + progress cập nhật live; nút hủy → entry error aborted + row xóa + không toast; ẩn khi rỗng.
- **Test (TDD)**: (a) render entries khi có; (b) ẩn khi rỗng; (c) click cancel → cancelUpload gọi đúng id; (d) i18n key tồn tại en+vi; (e) SettingsTab.test.tsx cũ giữ xanh.
- **Done**: test xanh + tsc + full suite + eslint.

---

## 4. ĐỊNH NGHĨA DONE (toàn plan)
- [ ] Slice 5.1-5.3 APPROVE (TDD đỏ→xanh, report đủ mục skill)
- [ ] Full suite xanh + tsc clean + eslint . = 0 (verify thật)
- [ ] Grep: không as any mới; mojibake 0 (file vi có dấu — cấm Set-Content)
- [ ] codebase-memory ghi (pattern persist+resume, edge case file-bị-xóa, per-user session)
- [ ] Commit gợi ý: `feat(upload): persist sessions + auto-resume interrupted uploads (IndexedDB)`

## 5. NGUỒN THAM KHẢO (đã tra 2026-08-05)
- developers.google.com/workspace/drive/api/guides/manage-uploads — resumable upload, query-status (Content-Range */total → 200/308/404), pre-generated IDs (409 = done), session TTL 1 tuần, "any 4xx → restart"
- blog.filestack.com/upload-file-ui-design-components-states-and-errors — retry silent, fail-early, per-file state, error messaging
- uxpatterns.dev/patterns/user-feedback/notification — toast chỉ cho recoverable issues, không spam
- eleken.co/blog-posts/file-upload-ui — upload queue panel, progress feedback
- audit code thật (db.ts v8, uploadManager.ts, driveUpload.ts slice 1-4, SettingsTab.tsx, App.tsx onLogin)
