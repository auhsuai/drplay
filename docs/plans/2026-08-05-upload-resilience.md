# PLAN: Upload Resilience — Google chuẩn (gap 1-5) — 2026-08-05

> Trạng thái: PLAN CHI TIẾT — sẵn sàng implement. Ngày: 2026-08-05
> Nguồn: research chính thức developers.google.com/drive/api (manage-uploads, handle-errors, limits — truy cập 2026-08-05) + audit code thật uploadManager.ts (910 dòng) + driveUpload.ts (480 dòng) + driveApi.ts (backoffDelay/driveFetch).
> Cách dùng: mỗi slice dispatch ĐÚNG 1 subagent, TUẦN TỰ (1 → 2 → 3 → 4 → 5), TDD đỏ→xanh, verify (test file ảnh hưởng + tsc + full suite).

---

## 1. HIỆN TRẠNG (audit — bằng chứng)

| Cơ chế | Trạng thái | Vị trí |
|---|---|---|
| Resumable flow + 308-resume (đọc Range server) | ✅ Đạt chuẩn | driveUpload.ts:332-418 |
| Retry 429/5xx/403-rate-limit (chunk) — backoffDelay + Retry-After | ✅ | driveUpload.ts:276-327, driveApi.ts:122 |
| 404 session expired → restart session | ✅ | driveUpload.ts:412, 463-472 |
| 401 → refresh token tự động | ✅ | fetchWithAuth |
| 403 quota → dừng vĩnh viễn + toast | ✅ | driveUpload.ts:111, uploadManager.ts:868 |
| Cancel → abort sạch | ✅ | entryControllers |
| Parent missing | ✅ | ParentFolderMissingError |
| Trùng tên (Drive cho phép) | ✅ không dùng tên identity | — |

## GAP (so chuẩn Google — research 2026-08-05)
1. **[BUG] File trùng khi retry timeout mơ hồ**: bytes path retry (uploadManager.uploadWithRetry) tạo SESSION MỚI; nếu PUT đầu đã thành công server nhưng response mất (network drop đúng lúc) → retry tạo file 2 lần. Chuẩn: `files.generateIds` + `clientGeneratedId` → retry idempotent (409 = thành công — đừng tạo file mới).
2. **[Chuẩn] 4xx trên chunk PUT (ngoài 404/401/403-quota) chưa restart session**: mapUploadHttpError → 'invalid' → dừng hẳn. Google: "For any 4xx during a resumable upload, restart the upload (new session URI)" — ngoại trừ quota/permanent. Hiện chỉ 404 restart.
3. **[Tối ưu] Không query-status trước restart sau network fail dài**: restart từ 0 tốn băng thông. Chuẩn: PUT rỗng `Content-Range: */total` → 200/201 = xong (xử lý response), 308 + Range = tiếp tục từ đó, 404 = session chết → tạo mới từ 0.
4. **[Phòng vệ] Không pre-check file > 750GB/ngày & > 5TB**: upload lớn fail giữa chừng. Chuẩn (S3): 750 GB upload/ngày/user, max file 5 TB. Pre-check rẻ tại quotaAllows.
5. **[Feature — làm SAU] Không persist queue + session URI**: app tắt giữa chừng → mất upload, không resume (session TTL 1 tuần). Cần persist (IndexedDB hoặc file) + query-status khi khởi động lại.

---

## 2. SLICES — SPEC CHI TIẾT

> Mẫu prompt dispatch chung: theo closed-loop-bugfix (slice 1) / closed-loop-code-modernize (slice 2-4, threshold: chuẩn ngành + chống lỗi thật) + CHUẨN CHUNG 5B.8. CẢNH BÁO encoding trong MỌI prompt: CẤM PS Set-Content; dùng edit tool; rg mojibake sau.

### SLICE 1 — Idempotent upload: files.generateIds + clientGeneratedId (chống file trùng)
- **File**: `src/utils/driveUpload.ts` + `src/utils/uploadManager.ts` (+ test 2 file).
- **Research bắt buộc**: fetch developers.google.com/drive/api/guides/manage-uploads (mục "Upload files with pre-generated IDs") — cite trong report.
- **Thay đổi**:
  1. `driveUpload.ts`: `initiateResumableUpload` thêm bước (nếu opt-in): gọi `POST https://www.googleapis.com/drive/v3/files/generateIds?count=1` (qua driveFetch — có retry sẵn) → lấy id → metadata POST `{ name, parents:[parentId], id: generatedId }` (resumable initiate kèm id).
  2. `uploadFileResumable` (bytes path) + `uploadFileResumableChunked`: thêm option `clientGeneratedId?: boolean` (hoặc param) — mặc định TRUE cho disk/bytes path từ uploadManager. Khi PUT/initiate trả **409 Conflict** → đây là "retry của upload idempotent" → KHÔNG tạo mới: coi như thành công (file đã tồn tại — fetch file đó? hoặc trả 409 lên trên để uploadManager đánh dấu done — CHỐT: trả UploadError kind mới `'conflict-done'`? Đơn giản: map 409 + clientGeneratedId → trả DriveFileItem giả? KHÔNG — phải lấy fileId thật: GET files?q=id=generatedId hoặc dùng 409 body không có id → lấy qua files.get? CHỐT CUỐI: khi 409 → `GET /drive/v3/files/{generatedId}?fields=id,name,mimeType,size,modifiedTime` → trả DriveFileItem (file thật) — uploadManager.markDone bình thường, không toast lỗi.
  3. `mapUploadHttpError`: thêm nhánh 409 (chỉ khi clientGeneratedId) — không log error (log info/warn "idempotent-conflict-resolved").
- **Behavior contract**:
  - Retry timeout mơ hồ → lần 2 tạo session với CÙNG generatedId → nếu file đã tồn tại: 409 → lấy file thật → done. KHÔNG file trùng.
  - 409 khi KHÔNG dùng generateIds (không thể xảy ra — Drive không trả 409 upload thường) → vẫn map 'invalid' như cũ.
  - Luồng bình thường: +1 request generateIds mỗi upload (quota 5 units) — chấp nhận.
- **Test (TDD)**:
  (a) RED: mock generateIds POST → id; initiate POST body CHỨA id; mock PUT 409 → app GET file → markDone với file thật (không error entry).
  (b) PUT 409 + không generateIds → UploadError 'invalid' (giữ cũ).
  (c) generateIds fail (network) → fallback upload KHÔNG id (vẫn upload được — không block; log warn).
  (d) Test hiện có uploadManager (bytes path retry) — giữ xanh.
- **Done**: test xanh + tsc + full suite.

### SLICE 2 — 4xx chunk PUT → restart session 1 lần (chuẩn Google)
- **File**: `src/utils/driveUpload.ts` (+ test).
- **Thay đổi**: `uploadChunksInSession` — hiện 404 → SessionExpiredError (restart ✓). Thêm: `mapUploadHttpError` trả UploadError — phân loại: nếu kind `'invalid'` do HTTP (không phải quota/auth) → QUĂNG SessionExpiredError (restart session 1 lần qua MAX_UPLOAD_ATTEMPTS sẵn có). Cụ thể: trong uploadChunksInSession, sau `mapUploadHttpError` — trả về UploadError nhưng wrapper: bọc lỗi 4xx (trừ 401/quota) thành SessionExpiredError để vòng ngoài restart; restart lần 2 vẫn 4xx → uploadChunksInSession ném UploadError cuối (kind giữ 'invalid' nhưng message có status). ĐỌC code thật trước — có thể cần điều chỉnh cách phân biệt (mapUploadHttpError hiện không lộ status — thêm kind/status field hoặc check trong catch).
- **Behavior contract**: 400/403-permission/409-on-chunk trên PUT chunk → restart session mới 1 lần; lần 2 vẫn lỗi → dừng (entry error + toast như cũ). 401 (auth) / quota → KHÔNG restart (giữ).
- **Test**: chunk PUT 400 lần 1 → session mới được initiate lại (mock đếm) → lần 2 400 → UploadError + entry error. 401 chunk → không restart (1 initiate).
- **Done**: test xanh + tsc + full suite.

### SLICE 3 — Query-status trước restart (resume sau network fail dài)
- **File**: `src/utils/driveUpload.ts` (+ test).
- **Thay đổi**: trong `uploadFileResumableChunked` vòng restart (catch transient/SessionExpired): TRƯỚC khi initiate session mới → gọi `queryResumableStatus(uploadUri, totalSize)`:
  - `PUT uploadUri` body RỖNG + header `Content-Range: */totalSize` (timeout 20s — PUT rỗng nhẹ).
  - 200/201 → upload ĐÃ xong (response JSON file) → trả về luôn.
  - 308 + Range → đã nhận `bytes=0-N` → tiếp tục SAME session từ N+1 (không initiate mới!) — cần refactor nhỏ: tách `uploadChunksInSession` nhận tham số offset khởi đầu.
  - 404 → session chết → initiate mới từ 0 (như cũ).
  - 5xx/429 khi query → backoffDelay retry 2 lần (giống putChunk).
- **Behavior contract**: mạng chết 30s → restart: query status → 308 → tiếp tục từ byte đã nhận (tiết kiệm băng thông); 200 → done; 404 → từ đầu. KHÔNG đổi luồng khi chưa có transient (lần đầu).
- **Test**: mock PUT rỗng → 308 Range bytes=0-524287 → readChunk được gọi với offset 524288 (KHÔNG initiate mới); 200 → return file; 404 → initiate mới từ 0; 5xx query → retry.
- **Done**: test xanh + tsc + full suite.

### SLICE 4 — Pre-check 750GB/ngày + 5TB (phòng vệ)
- **File**: `src/utils/uploadManager.ts` (+ test) — `quotaAllows` / `uploadDiskFileStreaming`.
- **Thay đổi**: thêm hằng `MAX_UPLOAD_BYTES_PER_DAY = 750 * 1024^3`, `MAX_FILE_BYTES = 5 * 1024^3`; pre-check trong quotaAllows (hoặc trước upload):
  - `byteLength > MAX_FILE_BYTES` → UploadError('file exceeds 5TB', 'invalid') + toast thông báo sớm.
  - Daily: không track được dùng bao nhiêu trong ngày (server-side) — chỉ check size file (không làm tracking local — báo cáo là pre-check size; daily 750GB là hướng dẫn, không track) → CHỐT: chỉ check 5TB/1 file (đơn giản, không phức tạp tracking) + ghi comment daily limit.
- **Behavior contract**: file > 5TB → fail sớm (trước khi upload bắt đầu), toast rõ ràng. File 100GB → upload bình thường (chỉ 5TB chặn).
- **Test**: stat size > 5TB → UploadError 'invalid' + không gọi uploadFileResumable; size bình thường → vẫn chạy.
- **Done**: test xanh + tsc + full suite.

### SLICE 5 — [FEATURE LỚN — LÀM SAU, ghi backlog] Persist queue + session URI + resume
- **File**: `src/utils/uploadManager.ts` + `driveUpload.ts` + `src/db/db.ts` (nếu lưu IndexedDB).
- **Ý tưởng (chưa chốt — cần brainstorming riêng)**: persist entries (queue) + session URI + filePath + offset vào IndexedDB (table mới `uploadSessions`); khi app khởi động lại: query status từng session (PUT rỗng */total) → resume hoặc bỏ. UI: danh sách "upload dở dang" trong Settings. TTL session 1 tuần (Google) — quá hạn → hủy entry + báo user.
- **KHÔNG làm trong phiên này** — cần plan riêng (scope lớn: storage schema, UI, race với Drive trạng thái thật).

---

## 3. EDGE CASES BẮT BUỘC (mọi slice — behavior contract)
1. 409 + generateIds → KHÔNG tạo file mới; trả file thật (slice 1).
2. 4xx chunk → restart ĐÚNG 1 lần (slice 2); 401/quota không restart.
3. Query-status: 308 → dùng Range server (KHÔNG tin offset client) (slice 3); 200 → done; 404 → từ đầu.
4. generateIds fail → fallback không-id (không block upload) (slice 1).
5. File > 5TB → fail sớm + toast rõ (slice 4).
6. KHÔNG đổi: 308-resume logic cũ, backoff, quota check, cancel/abort, folder memo.

## 4. ĐỊNH NGHĨA DONE (toàn plan)
- [ ] Slice 1-4 APPROVE (TDD đỏ→xanh, report đủ mục skill)
- [ ] Full suite xanh + tsc clean + eslint . = 0 (verify thật)
- [ ] Grep: không as any mới; mojibake 0
- [ ] codebase-memory ghi (pattern idempotent upload, 4xx-restart, query-status)
- [ ] Commit message gợi ý: `feat(upload): idempotent retry (generateIds), 4xx session restart, status-query resume, 5TB guard`

## 5. NGUỒN THAM KHẢO (đã tra 2026-08-05)
- developers.google.com/workspace/drive/api/guides/manage-uploads (resumable, pre-generated IDs, session TTL 1 tuần, 4xx → restart)
- developers.google.com/workspace/drive/api/guides/handle-errors (retry matrix, exponential backoff, quota 403)
- developers.google.com/workspace/drive/api/guides/limits (750GB/ngày, 5TB max, quota units 2026-05)
- developers.google.com/workspace/drive/api/guides/folder (tạo folder, 1 parent)
