# Audit Batch 3 — Core network/async utils

Ngày: 2026-08-09
Scope: 6 file (apiClient, driveHttp, asyncLimit, streamPrefetcher, resumableSession, driveApi) — audit-only, KHÔNG sửa code.
Project: drplay (Tauri v2 + React 19.2 + TypeScript 5.8 strict + WebView2 evergreen)

**LƯU Ý KHÁC BIỆT SO VỚI MÔ TẢ GIAO VIỆC (5C.1):**
1. **`driveApi.ts` KHÔNG phải file 1000+ dòng** — chỉ 35 dòng, là barrel re-export thuần (split thành driveTypes/driveHttp/driveFiles/driveConfig/driveQuota đã xong từ trước). Toàn bộ pattern thật nằm ở 4 module con — đã đọc kỹ cả 4 để audit thay thế.
2. **`resumableSession.ts` KHÔNG có persistence** (không IndexedDB/localStorage) — mô tả "upload session persistence" lệch; thực tế là logic khởi tạo session resumable upload thuần (generateClientId / initiate / idempotent 409-resolution). Không có schema versioning để audit.
3. **`apiClient.ts` thực tế 536 dòng** (mô tả ghi ~490).
4. **`as any` tại resumableSession.ts:75 là comment** (xác nhận bằng grep: "Never `as any` casts.") — 0 `as any` thật trong 6 file (toàn `src/utils/` chỉ 2 match, đều trong comment).

---

## File 1: `src/utils/apiClient.ts` (536 dòng)

### Pattern: `withTimeout` — new Promise executor + setTimeout + two-arg `.then` (dòng 80-98)
- Hiện tại (80-98, 19 dòng):
```ts
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Token refresh timeout (no response within ${String(ms)}ms)`));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))); },
    );
  });
}
```
- Search đã làm: duckduckgo "MDN Promise.withResolvers Baseline 2024 browser support Chrome" → https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers (Baseline **March 2024**); https://caniuse.com/wf-promise-withresolvers (Chrome/Edge **119+** → WebView2 evergreen ≥119 an toàn, không cần polyfill).
- 2026 khuyến nghị: **giữ nguyên — ĐÍNH CHÍNH ƯỚC LƯỢNG BATCH 1** (batch 1 ghi "ngắn hơn ~20-25%").
- Lý do: đếm dòng thật. Bản vớiResolvers bắt buộc phải GIỮ `promise.then` two-arg (comment 78-79 giải thích đúng: handlers gắn ngay để rejection muộn sau timeout không thành unhandled rejection — `Promise.race` KHÔNG thay thế được vì sẽ tạo unhandled rejection cho promise thua cuộc). Sau khi bỏ executor ceremony, format chuẩn prettier cho ra **20 dòng vs 19 dòng hiện tại** (≈0%, thậm chí dài hơn 1 dòng) — KHÔNG đạt threshold 20%. Lợi ích duy nhất là giảm 1 cấp nesting (cosmetic).
- Mức độ tự tin: Cao (đếm dòng trực tiếp từ code thật + MDN chính thức)
- Rủi ro nếu nâng cấp: thấp nhưng vô nghĩa — đổi 19 dòng chạy đúng + có test (apiClient.test.ts) lấy 0 lợi ích. Không làm.

### Pattern: Single-flight shared promise + two-arg `.then` (dòng 104, 355-362, 364-449)
- Đã kết luận GIỮ ở batch 1 (metadata/api.ts + apiClient.ts:87). Xác nhận lại trên code thật: `refreshPromise` null trong `finally` (447-449), follower share cùng promise (355-361), lead caller xử lý side-effect 1 lần (426-446), nulled đúng lúc — không race (check `signal?.aborted` cả trước readRefreshToken lẫn sau — dòng 340, 353).
- 2026 khuyến nghị: **giữ nguyên** (không đề xuất lại theo chỉ thị).
- Mức độ tự tin: Cao

### Pattern: AbortSignal.any guard + AbortSignal.timeout (dòng 499-505)
- Hiện tại: `typeof AbortSignal.any === "function"` guard, fallback timeout-only; merge caller-signal + timeout "neither wins".
- Search đã làm: MDN AbortSignal.any_static (ví dụ gộp controller.signal + timeoutSignal y hệt) — https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static ; AbortSignal.timeout_static; caniuse AbortSignal (Chrome 116+, Baseline 2024). Batch 1 đã xác nhận chuẩn.
- 2026 khuyến nghị: **giữ nguyên** — đúng best practice MDN 2026; guard hợp lý cho WebView2 cũ (dù rủi ro ~0).
- Mức độ tự tin: Cao

### Pattern: Error classification + retry bounded (dòng 67-73, 202-213, 373-389, 426-449)
- Hiện tại: `classifyRequestError` phân biệt TimeoutError/AbortError vs network; `TokenRefreshError` typed với kind (`network|invalid_grant|timeout|unknown`); invalid_grant → `auth-logout`, transient → `scheduleRetryRefresh()` 1 lần sau RETRY_DELAY_MS=30s (giới hạn, không vô hạn); mọi catch `err: unknown` + captureError có source/context, KHÔNG log token (comment 233-234, 296-297).
- 2026 khuyến nghị: **giữ nguyên** — đã vượt chuẩn Luật 4.
- Mức độ tự tin: Cao

### Pattern: Magic numbers (dòng 29-60)
- `MAX_SAFE_TIMEOUT`, `FETCH_TIMEOUT_MS`, `REFRESH_TIMEOUT_MS`, `KEYRING_TIMEOUT_MS`, `REVOKE_TIMEOUT_MS`, `RETRY_DELAY_MS`, `TOKEN_EXPIRY_MS`, `PROACTIVE_REFRESH_*` — tất cả có tên + comment giải thích why (32-bit overflow, tauri#8351, keyring stall, v.v.).
- 2026 khuyến nghị: **giữ nguyên** — không magic number.
- Mức độ tự tin: Cao

### Pattern: 401-retry trong fetchWithAuth (dòng 513-533)
- `getValidToken(true)` 1 lần, retry dùng CÙNG merged signal (không phải signal mới — đúng: aborted giữa chừng không fire retry vô ích), lỗi retry classify thành TokenRefreshError typed, không nuốt lỗi.
- 2026 khuyến nghị: **giữ nguyên**.
- Mức độ tự tin: Cao

---

## File 2: `src/utils/driveHttp.ts` (235 dòng)

### Pattern: `mergeWithTimeoutSignal` — ĐÃ là helper extract (dòng 30-38)
- Hiện tại: helper export riêng, guard `typeof AbortSignal.any === "function"` + timeout, dùng trong `driveFetch` (145) và các upload loops.
- 2026 khuyến nghị: **giữ nguyên** — đúng chuẩn MDN; đây là kết quả DRY đã làm. Ghi chú: `apiClient.fetchWithAuth` (499-505) vẫn có logic Y HỆT nhưng không dùng được helper này vì circular import (driveHttp → apiClient) → xem Cross-file #2.
- Mức độ tự tin: Cao

### Pattern: `driveFetch` retry loop — `for (let attempt = 0; ; attempt++)` (dòng 132-182)
- Hiện tại: bounded MAX_RETRIES=4; backoff `backoffDelay` (Retry-After → exponential + jitter, cap MAX_DELAY_MS=32s); 429/5xx retry + 403 rate-limit reason (clone body chỉ khi còn retry — body trả caller không bị consume, comment 148-152); aborted caller signal KHÔNG retry (171-173); timeout trên merged signal VẪN retry (transient); mọi catch typed + không nuốt lỗi.
- Lưu ý micro: vòng lặp viết dạng non-terminating với comment giải thích TS shape (137-139); có thể viết `for (let attempt = 0; attempt <= MAX_RETRIES; attempt++)` rõ hơn nhưng behavior không đổi, không đạt threshold.
- 2026 khuyến nghị: **giữ nguyên** — đã vượt chuẩn ngành (retry bounded + phân loại + backoff giới hạn, đúng Luật 4).
- Mức độ tự tin: Cao

### Pattern: `shouldRetryDriveResponse` — dedup retry decision ×3 loops (dòng 85-117)
- Đã được extract (task trước, comment 85-92 giải thích lịch sử whitelist hẹp vs rộng và lý do giữ 2 predicate). Đúng single-source-of-truth.
- 2026 khuyến nghị: **giữ nguyên**.
- Mức độ tự tin: Cao

### Pattern: `classifyDriveError` — log-safe (dòng 40-63)
- Chỉ derive từ message, không log error object/stack (file id/user data/token leak). Đúng chuẩn.
- 2026 khuyến nghị: **giữ nguyên**.
- Mức độ tự tin: Cao

### Pattern: `sleep` (dòng 23-24) — DUPLICATE với asyncLimit.ts:72-74
- Cùng signature `(ms: number) => Promise<void>`, 2 định nghĩa ở 2 file (grep xác nhận). → Cross-file #1.
- 2026 khuyến nghị: giữ nguyên tại file này; backlog extract.
- Mức độ tự tin: Cao

### Pattern: `catch (err)` không annotate (dòng 166)
- Style-only: TS strict `useUnknownInCatchVariables` → vẫn unknown, type-safe. Không nhất quán với `catch (e: unknown)` chỗ khác. → nối backlog batch 1 #3.
- 2026 khuyến nghị: **giữ nguyên**.
- Mức độ tự tin: Cao

---

## File 3: `src/utils/asyncLimit.ts` (74 dòng)

### Pattern: `createSemaphore` custom (dòng 19-69)
- Hiện tại: FIFO queue (`waiters` array + `pump`), `run()` try/finally release slot (không leak slot khi task reject), `release()` clamp `active = Math.max(0, active-1)` (không âm), guard `maxConcurrent < 1` → TypeError có message rõ, không có race (JS single-thread + pump chỉ chạy khi slot free).
- Search đã làm: duckduckgo "p-limit npm concurrency limiter semaphore 2026 best practice" → p-limit vẫn là lib tham chiếu chuẩn ngành (npm-compare.com/async-lock,async-mutex,async-sema,p-limit,semaphore-async-await; hirenodejs.com concurrency patterns 2026); nhưng: (a) p-limit không có API `acquire()` (behavior khác — consumer có dùng acquire? kiểm tra: `coverStore.ts:25` dùng `createSemaphore(3)` với `run`); (b) custom đã có test (asyncLimit.test.ts); (c) thêm dependency không đạt threshold nào ("ngắn hơn code project" không áp dụng cho dep).
- 2026 khuyến nghị: **giữ nguyên** — implementation 74 dòng đúng chuẩn, có test, không race, không cleanup leak (không có dispose API nhưng semaphore sống suốt app — không cần).
- Mức độ tự tin: Cao
- Rủi ro nếu nâng cấp (nếu ai đó đề xuất p-limit): phá API public `acquire`/`active`, đổi behavior, thêm dep 1.2MB node_modules — không đáng.

### Pattern: `sleep` (dòng 72-74) — DUPLICATE driveHttp.ts:23-24
- Giống hệt. → Cross-file #1.
- 2026 khuyến nghị: giữ nguyên; backlog extract.
- Mức độ tự tin: Cao

---

## File 4: `src/utils/streamPrefetcher.ts` (58 dòng)

### Pattern: Map LRU evict thủ công (dòng 33-41)
- Hiện tại: `prefetchedStreams.delete + set` (đẩy lên đầu insertion order) + `while (size > MAX_CACHE) keys().next().value` xoá oldest.
- Search đã làm: Map insertion-order iteration là đặc tả ECMAScript ổn định (không có API LRU native mới hơn trong ES2026); pattern `Map.keys().next().value` là cách chuẩn cho LRU nhỏ.
- 2026 khuyến nghị: **giữ nguyên** — Map + keys().next() là best practice hiện tại cho cache nhỏ; MAX_CACHE=200 có tên + comment giải thích (dòng 5: cache URL string ~20 byte, không prefetch data — việc prefetch thật do nextTrackPrefetcher đảm nhiệm).
- Mức độ tự tin: Cao

### Pattern: So sánh với nextTrackPrefetcher (đã upgrade async/await ở batch trước)
- File này KHÔNG có async chain — sync thuần (loop + Map ops). Không có `.then` chain để nâng cấp. `buildStreamUrl` + `encodeURIComponent` + `?ext=` (23-27) đúng hợp đồng SW proxy (comment 19-22 giải thích vì sao ext phải đi qua query).
- 2026 khuyến nghị: **giữ nguyên** — không có pattern cũ.
- Mức độ tự tin: Cao

---

## File 5: `src/utils/resumableSession.ts` (176 dòng)

### Pattern: Idempotent upload + pre-generated id (dòng 44-71, 130-176)
- Hiện tại: `generateClientId` (1 id, driveFetch retry bên trong), `initiateResumableUpload` bind id vào metadata POST (idempotent — retry gặp file đã tạo → 409 → `resolveIdempotentConflict` fetch file thật → `IdempotentConflictError`). Đúng guide chính thức Google (comment cite manage-uploads "Use a pre-generated ID to upload files").
- Search đã làm: pattern không cần tra ngoài — cite nguồn Google đã có sẵn trong comment; N/A tra mới (không đổi pattern, chỉ xác nhận).
- 2026 khuyến nghị: **giữ nguyên** — đúng best practice Google Drive upload.
- Mức độ tự tin: Cao

### Pattern: Type narrowing — `as any` line 75 là comment (xác nhận), cast hẹp có guard
- Hiện tại: `data as { ids?: unknown }` (65) + `asDriveFileItem` (76-94) narrow từng field bằng typeof check, trả null khi malformed; `data as Record<string, unknown>` (78) an toàn (runtime check sau). Không `as any` thật (grep).
- 2026 khuyến nghị: **giữ nguyên** — type-safe đúng chuẩn.
- Mức độ tự tin: Cao

### Pattern: Magic number / hằng số URL (dòng 13-37)
- RESUMABLE_UPLOAD_URL, GENERATE_IDS_COUNT=1, FILE_GET_FIELDS, RANGE_HEADER_PATTERN (regex có tên), UPLOAD_TIMEOUT_MS=120s (comment giải thích 50MB/slow-connection), QUERY_STATUS_TIMEOUT_MS=20s (comment: status PUT không mang bytes) — tất cả có tên + why.
- 2026 khuyến nghị: **giữ nguyên**.
- Mức độ tự tin: Cao

### Pattern: Error handling (dòng 56-61, 114-119, 155-166)
- `mapUploadHttpError(status, body)` — phân loại lỗi HTTP thành UploadError/IdempotentConflictError typed; `readDriveErrorBody` (driveHttp, try/catch → null); không nuốt lỗi (throw để uploadManager quyết định fallback — comment 42-43).
- 2026 khuyến nghị: **giữ nguyên**.
- Mức độ tự tin: Cao

### Ghi chú test: KHÔNG có test companion (grep `resumableSession|initiateResumableUpload|generateClientId` trong `src/**/*.test.ts` = 0 match; consumers uploadFileResumable.ts/Chunked/resumableStatus.ts cũng không có test riêng). Risk note cho Main Agent nếu dispatch upgrade vào file này: không có regression net bảo vệ — cần viết test mới kèm.

---

## File 6: `src/utils/driveApi.ts` (35 dòng — barrel, KHÁC mô tả)

### Pattern: Barrel re-export thuần
- KHÔNG chứa logic — chỉ re-export từ driveTypes/driveHttp/driveFiles/driveConfig/driveQuota. Không có pattern cũ để audit. Các pattern thật đã audit qua 4 module con:

### Pattern (trong `driveFiles.ts`): `authHeaders` + `assertDriveOk` + parse* narrow
- `authHeaders` (20-22) — single source of truth "Bearer" format (comment 16-19); `assertDriveOk` (31-35) — throw chuẩn `Failed to <action> (status)`, có comment giải thích ngoại lệ (không dùng khi cần null-return/log riêng); `parseParentsList`/`parseFilesList`/`parseName` — narrow từng field, malformed → fallback an toàn.
- Micro-nit: `return data as DriveFileItem;` ở createFolder/deleteFile/restoreFile/moveFile (102, 134, 229, 200) — cast trực tiếp không runtime guard (KHÔNG nhất quán với parseFilesList/asDriveFileItem có guard). KHÔNG phải `as any`, runtime risk thấp (ok-status + API ổn định); không đạt threshold type-safety "rõ rệt" → giữ, ghi backlog.
- 2026 khuyến nghị: **giữ nguyên**.

### Pattern (trong `driveConfig.ts`): `withSaveConfigLock` promise-chain mutex (dòng 73-88)
- Đã refactor trước (comment 63-71 giải thích FIFO fairness, không busy-wait, deadlock caveat giữ nguyên). Đúng chuẩn.
- 2026 khuyến nghị: **giữ nguyên**.

### Pattern (trong `driveQuota.ts`): non-critical chrome — fail → null + warn (dòng 36-88)
- catch typed, `classifyDriveError`, không throw (quota outage không crash sidebar — comment 28-32), malformed-response detection riêng. `catch (err)` dòng 81 không annotate — style-only.
- 2026 khuyến nghị: **giữ nguyên**.

---

## Cross-file findings (backlog — KHÔNG sửa)

1. **`sleep` định nghĩa DUPLICATE ×2**: `src/utils/driveHttp.ts:23-24` + `src/utils/asyncLimit.ts:72-74` — cùng signature `(ms: number) => Promise<void>` và cùng doc. Đề xuất backlog: extract `src/utils/delay.ts` (hoặc một file chung), cả 2 import lại. Thuộc nhánh REFACTOR (không phải modernize — không đổi pattern, chỉ dedup). Kiểm tra test dùng trước khi gộp (driveApi.test.ts / asyncLimit.test.ts có thể assert sleep).
2. **Merge signal+timeout logic trùng ×4 chỗ**: `apiClient.ts:501-505` (guard + timeout, inline), `driveHttp.ts:34-36` (ĐÃ extract thành `mergeWithTimeoutSignal`), `driveRangeTokenizer.ts:149-151` (guard + timeout, inline), `nextTrackPrefetcher.ts:47-49` (KHÔNG guard — dùng vô điều kiện). apiClient KHÔNG dùng helper của driveHttp được vì circular import (driveHttp → apiClient). Đề xuất backlog: extract vào module thứ 3 (VD `src/utils/timeoutSignal.ts`), 4 chỗ dùng chung; thống nhất guard. Đồng thời xử lý điểm không nhất quán guard (đã ghi batch 1 #2).
3. **`catch (err)` không annotate** ở `driveHttp.ts:166`, `driveQuota.ts:81` — style-only, nối vào backlog batch 1 #3 (100+ chỗ toàn codebase).
4. **`data as DriveFileItem` cast không runtime guard** ở `driveFiles.ts:102, 134, 200, 229` — không nhất quán với `parseFilesList`/`asDriveFileItem` (có guard). Micro-nit, không đạt threshold, backlog tuỳ chọn.
5. **`workers/driveFetch.ts:120`** — dùng `AbortSignal.timeout` trực tiếp, không merge caller signal (worker sync context — không có caller cancel, hợp lý). Chỉ ghi nhận, không cần đổi.

## Test companions (kiểm tra bằng glob + grep)

| File | Test companion | Ghi chú |
|---|---|---|
| apiClient.ts | `src/utils/apiClient.test.ts` ✓ | Test AbortSignal.timeout (dòng 170), timeoutMs override (188), AbortSignal.any merge (253) |
| driveHttp.ts | KHÔNG có file riêng; cover qua `src/utils/driveApi.test.ts` ✓ | 46 match driveFetch/shouldRetryDriveResponse/mergeWithTimeoutSignal |
| asyncLimit.ts | `src/utils/asyncLimit.test.ts` ✓ | |
| streamPrefetcher.ts | `src/utils/streamPrefetcher.test.ts` ✓ | |
| resumableSession.ts | KHÔNG có test trực tiếp ✗ | 0 match trong `src/**/*.test.ts`; consumers uploadFileResumable/Chunked/resumableStatus cũng không có test riêng — RISK nếu upgrade |
| driveApi.ts | `src/utils/driveApi.test.ts` ✓ | Barrel + logic driveHttp |

## MCP fallback note
DuckDuckGo MCP khả dụng (3 search + 2 fetch_content thành công). context7 KHÔNG dùng — không có lib/framework ngoài trong 6 file (toàn platform APIs: Promise/AbortSignal/fetch/Map + Tauri invoke đã có comment cite issue #8351); MDN + caniuse là nguồn phù hợp → ghi `N/A — file không dùng lib ngoài, tra MDN/caniuse trực tiếp`.

## Tổng kết đề xuất
| File | Pattern | Quyết định | Threshold |
|---|---|---|---|
| apiClient.ts | `withTimeout` executor (80-98) | **giữ nguyên** (đính chính batch 1: vớiResolvers ≈ 0% ngắn hơn sau prettier, không đạt 20%) | — (không đạt) |
| apiClient.ts | single-flight shared promise | giữ nguyên (batch 1 đã chốt) | — |
| apiClient.ts | AbortSignal.any guard + timeout | giữ nguyên | — (đã chuẩn MDN) |
| apiClient.ts | error classify/retry/log | giữ nguyên | — (vượt chuẩn) |
| driveHttp.ts | mergeWithTimeoutSignal helper | giữ nguyên | — (đã extract) |
| driveHttp.ts | driveFetch retry loop | giữ nguyên | — (vượt chuẩn) |
| driveHttp.ts | classifyDriveError / shouldRetry | giữ nguyên | — |
| asyncLimit.ts | createSemaphore custom | giữ nguyên (p-limit: behavior khác + dep mới + đã có test) | — |
| streamPrefetcher.ts | Map LRU | giữ nguyên | — (chuẩn ES) |
| resumableSession.ts | idempotent upload / narrowing / constants | giữ nguyên | — (đã chuẩn Google docs) |
| driveApi.ts (+4 con) | barrel / assert / mutex / quota | giữ nguyên | — |

**Kết luận: 0 đề xuất nâng cấp đạt threshold trong 6 file — code đã đạt chuẩn 2026.** 1 đính chính so với backlog batch 1 (withResolvers không đáng làm). Backlog thật: 2 cross-file DRY item (sleep ×2, merge-signal ×4) — thuộc nhánh refactor orchestration.
