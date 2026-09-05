# PLAN — Byte-range cache trong Service Worker (stream nhạc Drive)

> Note dở dang — tạo 06/09/2026. Trạng thái: **HOÀN TẤT 06/09/2026** (Slice 1 + Slice 2).
> Dispatch subagent lại vẫn treo (rỗng) → làm tay theo mục 5, full suite 1942/1942 + build xanh.

---

## 6. Việc mai làm (checklist)

- [x] Dispatch subagent Slice 1 (prompt gọn: repo path + contract + verify + timebox research) — **treo lần 2 (kết quả rỗng) → làm tay theo mục 5**
- [x] Review report: đủ 8 mục? RED→GREEN có log cụ thể? → (tự verify: RED 6/7 fail đúng lý do → GREEN 7/7, test cũ 24/24 giữ nguyên)
- [x] `git diff --stat` đúng scope (sw.js + test + usePlayer hook) + tsc 1 lần + commit
- [x] Slice 2 (prefetch + retry 5xx/429): SW retry/backoff [400, 1200]ms cho 429/500/502/503/504; PREFETCH_TRACK message → SW stream bytes=0- qua backoff → write-through IDB + học total; usePlayer gửi PREFETCH_TRACK cho track kế tiếp trong queue
- [x] Ghi codebase-memory: interface byte-range store + quyết định (IDB thay HTTP cache do bug 1026876)

### Kết quả thực tế (06/09/2026)
- File đụng: public/sw.js (579 dòng mới), src/utils/swByteCache.test.ts (7 test),
  swStreamRetry.test.ts (5 test), swPrefetch.test.ts (4 test), swPrefetch.ts (util),
  src/hooks/usePlayer.ts (hook gửi PREFETCH_TRACK), swMime.test.ts (mock trả Response
  mới mỗi call — byte-cache tee() locks body dùng chung).
- Verify: RED→GREEN đầy đủ (baseline 24 pass → 6/7 fail đúng lý do → GREEN) +
  full suite 1942/1942 + `npm run build` xanh + eslint 0 error + tsc 0 error.
- Rủi ro còn lại: cache-serve và Drive-serve trộn nhau giữa các range request
  (không trong 1 media load) — cần chạy thử thật trên app; quota IDB lớn (512MB cap,
  LRU) chưa đo trên máy thật.

---

## 1. Bối cảnh đã nghiên cứu (cross-verified, có file:line)

App `E:\drplay` stream nhạc từ Google Drive qua Service Worker, KHÔNG qua Rust:

- `<audio>` xin `/drive-stream/{fileId}?ext=...` → SW chặn (`public/sw.js:251-275`)
- `fetchDriveStream()` (sw.js:221-249) forward Range header + `Authorization: Bearer`
  tới `https://www.googleapis.com/drive/v3/files/{fileId}?alt=media`
- Fetch có `cache: 'no-store'` (sw.js:231) — **bắt buộc**, do Chromium bug 1026876. KHÔNG đổi thành true
- `ensureContentRange` (sw.js:106-196): SW tự tái tạo Content-Range cho 206
  (Drive CORS không expose header này). Closed-range cần biết total size
- total size cache trong Map LRU 1000 entries `totalSizeByFileId` (sw.js:114-147)
  → **evict xong closed-range seek chết** (`SRC_NOT_SUPPORTED`, comment "verified experimentally" tại sw.js:188-195)
- `overrideContentType` (sw.js:66-104): Drive trả `application/octet-stream` → đè MIME theo `?ext=`
- Flow 401: SW postMessage `SW_TOKEN_EXPIRED` (sw.js:237-240) → main refresh → retry 1 lần
- Auth: OAuth native Rust (src-tauri/src/auth.rs), refresh token ở OS keyring,
  `getValidToken()` single-flight ở src/utils/tokenRefresh.ts
- Metadata path (KHÔNG đụng): src/utils/driveRangeChunkFetcher.ts (64KB aligned,
  semaphore 3, timeout 45s), driveRangeChunkCache.ts (LRU in-memory main thread)

## 2. Bottleneck đã xác định (đúng trong code)

1. **Không cache byte nhạc** — no-store + `usePlayer.ts:256-263` có `TODO(chunk-store)`
   thừa nhận. Mỗi play/seek đánh Drive lại → quota + latency (Drive media endpoint
   first-byte delay 30±5s, ghi tại driveRangeChunkFetcher.ts:23-28)
2. **5xx/429 khi play không retry** — retry/backoff chỉ có trên đường metadata
3. **LRU total-size 1000 entries** — evict → seek chết
4. **Không decoder ngoài** — chỉ 7 ext: mp3 flac wav ogg m4a aac opus (audioQuery.ts:10-18);
   ape/wv/dsf/nrg bị loại chủ đích; không có ffmpeg trong repo

## 3. Plan — 2 slice (tuần tự, cùng working tree — không song song)

### Slice 1: Byte-range store (IndexedDB) trong SW ← LÀM TRƯỚC
File đụng: **chỉ `public/sw.js`** + file test mới (pattern theo swMime.test.ts — mock IDB + fetch).

Behavior contract (bảo toàn 100%):
1. Range được cache phủ ĐỦ → serve từ IDB, fetch Drive = 0 lần (test assert)
2. Range thiếu → fetch Drive như cũ + write-through vào IDB + response như trước (206 + Content-Range + MIME)
3. totalSize persist vào IDB theo fileId → evict in-memory xong seek vẫn sống (có test)
4. IDB fail/quota → pass-through y như cũ, log warn, không crash
5. Cap ~512MB (hằng số có tên) + LRU last-access
6. swMime.test.ts + 401 flow + no-store giữ nguyên — test cũ vẫn xanh
7. Chunk aligned 256KB (hằng số; metadata path 64KB không đụng)

Tiêu chuẩn code: try/catch phân loại lỗi cụ thể (QuotaExceededError, InvalidStateError,
HTTP 4xx/5xx, timeout) — cấm catch(e) chung; log có ngữ cảnh không log token;
không magic number; song song cùng fileId phải an toàn (coalescing nếu cần).

### Slice 2: Prefetch next-track + retry/backoff 5xx/429 trên đường play (sau Slice 1)

## 4. Verify (quy trình 2 tầng 5B.7)

Subagent tự chạy: vitest file test của sw + test mới → `npx tsc --noEmit` →
`npx eslint` file đụng → ghi RED→GREEN (baseline + log FAIL `expected X to be Y` + log PASS).
Main agent: đọc diff + `npx tsc --noEmit` 1 lần + commit.

## 5. Bài học dispatch hôm nay (tránh lặp lại)

- Prompt subagent bị treo khi yêu cầu "tra cứu tiêu chuẩn ngàn" mở đầu — lần sau:
  research timebox 2 lượt, quá 30s thì bỏ qua, ghi nguồn "N/A"; trọng tâm code+test
- Nhớ ghi rõ REPO PATH (E:\drplay) ngay dòng đầu
- Nếu dispatch lại vẫn treo >5-10 phút → tự làm tay theo plan này là nhanh nhất
  (code + test theo contract trên, làm trong worktree hoặc branch)
  → **ĐÃ XẢY RA LẦN 2 (subagent về rỗng) → làm tay, nhanh và có verify đầy đủ**

## 6. Việc mai làm (checklist)

- [ ] Dispatch subagent Slice 1 (prompt gọn: repo path + contract + verify + timebox research)
- [ ] Review report: đủ 8 mục? RED→GREEN có log cụ thể? → REJECT/APPROVE
- [ ] `git diff --stat` đúng scope (chỉ sw.js + test) + tsc 1 lần + commit
- [ ] Slice 2 (prefetch + retry 5xx/429)
- [ ] Ghi codebase-memory: interface byte-range store + quyết định (IDB thay HTTP cache do bug 1026876)
