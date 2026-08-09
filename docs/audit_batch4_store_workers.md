# Audit Batch 4 — Store + Workers

Ngày: 2026-08-09
Scope: 6 file (3 zustand stores + 2 search engine/worker + 1 sync worker), audit-only — KHÔNG sửa code.
Project: drplay (Tauri v2 + React 19.2 + TypeScript 5.8 strict + zustand **5.0.14** + minisearch **7.2.0**)

**Version xác nhận từ node_modules:** `node_modules/zustand/package.json` → 5.0.14; `node_modules/minisearch/package.json` → 7.2.0.

**LƯU Ý KHÁC BIỆT SO VỚI MÔ TẢ GIAO VIỆC (5C.1):**
1. `playerStore.ts` KHÔNG có middleware persist — session persistence nằm ở `usePlayerSession.ts` (localStorage dòng 43/192 + IDB kv), không phải thiếu sót.
2. `searchEngine.ts` comment dòng 113-115 mô tả "constructor-level boost không còn ở v6+, sống trong SearchOptions" — xác nhận ĐÚNG qua changelog chính thức (v5.0.0: "field boosting effect now different" + v6.0.1 boost search option) và d.ts v7.2.0 (constructor option `searchOptions?: SearchOptions` — `dist/es/index.d.ts:568`).
3. Toàn bộ consumer selector object-literal ĐÃ bọc `useShallow` (8 file) — không nơi nào trả new-reference không-shallow → không dính vấn đề "stable selector" của v5.

---

## File 1: `src/store/playerStore.ts` (127 dòng)

### Pattern: Zustand v5 `create<PlayerState>((set) => ...)` — named import, không deprecated API
- Hiện tại (dòng 1, 65-127): `import { create } from "zustand";` + `create<PlayerState>((set) => ({...}))` — toàn bộ action dùng `set((state) => ...)` / `set({...})`, không dùng `get()`, không `setState` replace flag, không custom equality fn, không persist.
- Search đã làm:
  - Zustand v5 migration guide (chính thức): https://zustand.docs.pmnd.rs/reference/migrations/migrating-to-v5 — "Drop default exports", "Drop deprecated features", "Persist middleware no longer stores item at store creation", "Requiring stable selector outputs"
  - context7 `/pmndrs/zustand` v5.0.12 docs: create/set/subscribe/persist
- 2026 khuyến nghị: **giữ nguyên**
- Lý do: code đã là v5 chuẩn. `import { create }` là named import đúng v5 (v5 drop default export — code không dùng default). Không dùng bất kỳ API deprecated nào của v4 (createWithEqualityFn/shallow ở middleware không cần — vì consumer đã dùng `useShallow` hook đúng cách v5). Không có gì để migrate.
- Mức độ tự tin: Cao (migration guide chính thức + version 5.0.14 xác nhận)
- Rủi ro nếu nâng cấp: không áp dụng (đã là chuẩn mới nhất)

### Pattern: Updater-function actions lặp ×4 (`typeof track === "function" ? track(prev) : track`)
- Hiện tại (dòng 75-80 setCurrentTrack, 84-91 setIsPlaying, 95-100 setPlayMode, 104-109 setPlaybackQueue): cùng 1 shape 4 lần, mỗi lần ~6 dòng.
- Search đã làm: context7 zustand docs (set API: `set(partial | fn(prev))`) — updater thủ công này không phải pattern cũ; zustand hỗ trợ `set(fn)` nhưng action nhận tham số `T | ((prev) => T)` nên cần map thủ công.
- 2026 khuyến nghị: **giữ nguyên**
- Lý do: extract helper (VD `applyUpdater<T>(arg, prev)`) tiết kiệm ~8-10 dòng trên 127 = ~8% < threshold 20%. DRY có nhưng không đạt ngưỡng hiệu quả; hành vi hiện tại rõ ràng, không bug. Backlog refactor nếu muốn chuẩn hoá (xem Cross-file #3).
- Mức độ tự tin: Cao
- Rủi ro nếu nâng cấp: không đáng — lợi ích dưới threshold.

### Pattern: Không persist middleware (session qua usePlayerSession)
- Hiện tại: store thuần in-memory; `usePlayerSession.ts:43,192` (localStorage) + IDB kv lưu session. Comment dòng 59-64 giải thích tách rời media engine.
- Search đã làm: zustand v5 persist docs (https://zustand.docs.pmnd.rs/integrations/persisting-store-data) + migration guide ("persist no longer stores initial state at creation").
- 2026 khuyến nghị: **giữ nguyên** — persistence qua hook chuyên biệt có chủ đích (session restore flow phức tạp: hydration + replay). Đưa vào persist middleware v5 sẽ đổi hành vi (cần `setState` explicit sau create) + trùng logic với usePlayerSession = 2 nguồn sự thật (vi phạm Luật 4 "1 nguồn sự thật").
- Mức độ tự tin: Cao
- Rủi ro nếu nâng cấp: behavior change + duplicate logic → không nâng cấp.

### Pattern: Consumer selector stability (nguy cơ v5 infinite loop)
- Hiện tại: `usePlayer.ts:51-69` bọc `useShallow((state) => ({...}))`; `useMediaSession.ts:147,164` dùng selector đơn field `(state) => state.currentTrack` — cả 2 pattern đều an toàn v5.
- Search đã làm: zustand v5 migration guide — "Requiring stable selector outputs" (selector trả new reference → `Maximum update depth exceeded`).
- 2026 khuyến nghị: **giữ nguyên** — đã đúng chuẩn, không có chỗ nào vi phạm.
- Mức độ tự tin: Cao

### Test companion
- **KHÔNG có** `playerStore.test.ts`. Coverage gián tiếp qua: `usePlayer.test.ts` (16 refs), `usePlayerQueue.test.ts`, `usePlayerSession.test.ts`, `useMediaSession.test.tsx` (15), `PlayerBar.test.tsx` (28), `AudioController.test.ts`, `TrackInfo.tsx` (2). Nếu Giai đoạn 3 sửa file này → regression coverage dựa vào các test consumer này (nhiều nhất là PlayerBar.test.tsx + usePlayer.test.ts).

---

## File 2: `src/store/driveStore.ts` (89 dòng)

### Pattern: Zustand v5 `create<DriveState>` thuần
- Hiện tại (dòng 1, 57-89): `create<DriveState>((set) => ...)` — 7 state fields + 7 setters đơn giản; `setFolderHistory` (dòng 77-82) dùng updater-function 1 lần.
- Search đã làm: như File 1 (migration guide v5, context7).
- 2026 khuyến nghị: **giữ nguyên**
- Lý do: đúng chuẩn v5; không deprecated; không persist (nav state persist nằm ở `useNavStatePersistence.ts:42-73` → dexie `syncState`, có chủ đích — grep xác nhận). Magic string "name" (dòng 62 sortOption default) — là giá trị domain sort, đã có constant phía consumer, không phải magic number gây hiểu nhầm.
- Mức độ tự tin: Cao
- Rủi ro nếu nâng cấp: không áp dụng.

### Test companion
- **CÓ** `driveStore.test.ts` (5 refs) — dùng `useDriveStore.setState(...)` (dòng 20, API hợp lệ của zustand v5).

---

## File 3: `src/store/authStore.ts` (41 dòng)

### Pattern: Zustand v5 + token handling
- Hiện tại (dòng 1, 28-41): `create<AuthState>` — 3 fields (isLoggedIn, accessToken, userProfile) + 3 setters. `accessToken: string | null` lưu trực tiếp trong store.
- Search đã làm: như File 1; thêm AGENTS.md Phần 7.4 cảnh báo "auth/token/storage key → không fast-lane, lịch sử bug token".
- 2026 khuyến nghị: **giữ nguyên**
- Lý do: (a) Đúng chuẩn v5 API. (b) **KHÔNG log token** — grep xác nhận file có 0 console/captureError/log (chỉ JSDoc). (c) Comment dòng 23-27 nói rõ kiến trúc: token lifecycle ở apiClient/useAuth, store chỉ là projection cho UI render — 1 nguồn sự thật duy nhất (không duplicate). (d) Không persist middleware cho token (đúng — token không được lưu storage bền, session ở useAuth/apiClient).
- Mức độ tự tin: Cao
- Rủi ro nếu nâng cấp: không áp dụng — bất kỳ thay đổi nào đụng token PHẢI qua quy trình đầy đủ (không fast-lane) theo AGENTS.md.

### Test companion
- **KHÔNG có** `authStore.test.ts`. Coverage gián tiếp: `useAuth.test.ts`, `PlayerBar.test.tsx`, `TrackInfo.tsx`. Nếu sửa → regression qua các file này.

---

## File 4: `src/search/searchEngine.ts` (203 dòng)

### Pattern: MiniSearch v7 constructor + search options
- Hiện tại (dòng 97-123): `new MiniSearch<SearchDoc>({ idField: "id", fields: ["name","title","artist"], storeFields: [...8 fields], searchOptions: { boost: {...} }, processTerm: (term) => normalizeText(term) || null })`; `index.addAll(docs)` (dòng 148); `index.search(tokens.join(" "), { combineWith: "AND", prefix: true, fuzzy: 0.2 })` (dòng 160-164); `index.getStoredFields(result.id)` (dòng 169).
- Search đã làm:
  - MiniSearch CHANGELOG (chính thức, GitHub): https://github.com/lucaong/minisearch/blob/master/CHANGELOG.md — v7.0.0: "only real breaking change is ES6 target", combineWith strict typing, loadJSONAsync; v7.1.0 boostTerm; v7.2.0 stringifyField
  - context7 `/lucaong/minisearch`: SearchOptions type — boost/boostTerm/boostDocument/combineWith/fuzzy/prefix/processTerm
  - Xác nhận d.ts local: `node_modules/minisearch/dist/es/index.d.ts:568` `searchOptions?: SearchOptions` (constructor-level), `:412` `boost: {[field: string]: number}` trong SearchOptions, `getStoredFields`/`discard`/`discardAll`/`has` tồn tại
- 2026 khuyến nghị: **giữ nguyên**
- Lý do: MỌI API dùng đều là v7 hiện tại: constructor-level `searchOptions` (đúng v7, d.ts 568), `boost` trong SearchOptions (đúng v7, d.ts 412 — code dùng qua searchOptions nên áp dụng cho mọi search), `storeFields` + `getStoredFields` (v6.1.0+, v7 vẫn chuẩn), fractional `fuzzy: 0.2` (0-1 = fraction of term length — đúng semantic v7), `combineWith: "AND"` typed strict v7. Comment dòng 113-115 giải thích v6→v7 CHÍNH XÁC (verified). `processTerm` trả `null` drop term — đúng chuẩn (context7 README: processTerm null → skip). Không deprecated API nào.
- Mức độ tự tin: Cao (changelog chính thức + d.ts local + context7)
- Rủi ro nếu nâng cấp: không áp dụng. Ghi chú: có `boostTerm` (v7.1.0+) để boost theo term — nhưng không cần, field boost hiện tại đủ; không phải pattern cũ cần thay.

### Pattern: Type-narrowing của stored fields (dòng 166-193)
- Hiện tại: `stored` typed `any` (index signature của minisearch) → `typeof stored?.name === "string"` narrowing + optional field guard `if (typeof stored?.size === "number") hit.size = stored.size` (exactOptionalPropertyTypes).
- 2026 khuyến nghị: **giữ nguyên** — guard trước khi dùng đúng chuẩn type-safe (không `as SearchHit` bừa); exactOptionalPropertyTypes bắt buộc cách viết này.
- Mức độ tự tin: Cao

### Test companion
- **CÓ** `searchEngine.test.ts` ✓.

---

## File 5: `src/search/search.worker.ts` (211 dòng)

### Pattern: Web worker glue + dual-use guard
- Hiện tại (dòng 198-210): `if (typeof self !== "undefined" && typeof window === "undefined")` → gắn `self.onmessage`; main-thread import không cài listener. Injectable deps (dòng 24-35) để test không cần Worker/IDB thật.
- Search đã làm: MDN Web Workers API (structured clone, postMessage): https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm ; https://developer.mozilla.org/en-US/docs/Web/API/Worker/postMessage
- 2026 khuyến nghị: **giữ nguyên**
- Lý do: guard dual-use là pattern chuẩn (cho phép cùng module chạy worker + main-thread fallback — comment dòng 195-197 giải thích "why"); postMessage data đều JSON-plain (requestId/hits/query) → structured clone đủ, không cần transferable (không ArrayBuffer/ImageData lớn); không có worker nào tạo ra cần terminate (worker sống theo app lifecycle — không leak, không cần cleanup timer).
- Mức độ tự tin: Cao
- Rủi ro nếu nâng cấp: không áp dụng.

### Pattern: Typed message protocol + runtime guards
- Hiện tại (dòng 12-20 type union; 59-102 `isSearchWorkerRequest`/`isSearchWorkerResponse` type-guard thu hẹp từng field; 106-108 `errorMessage` classified).
- 2026 khuyến nghị: **giữ nguyên** — wire protocol typed + runtime validate trước khi dispatch là chuẩn ngành cao nhất (chống message nhiễu từ bên ngoài, tự document protocol).
- Mức độ tự tin: Cao

### Pattern: Single-flight rebuild (`rebuildPromise`) + stale flag
- Hiện tại (dòng 40-57 state, 112-135 ensureFreshIndex/performRebuild): concurrent stale queries share 1 rebuild promise; fail → promise cleared nhưng stale giữ true → query sau retry (comment dòng 123-124). `Promise.all` (dòng 113) ĐÚNG semantics (cần cả files+metadata trước khi build).
- Search đã làm: MDN Promise.all vs allSettled (đã cite trong audit_batch1 #4 — `Promise.all` đúng khi must-await-all); pattern shared-promise single-flight (đã xác nhận trong batch 1: `metadata/api.ts:34-79` cùng pattern).
- 2026 khuyến nghị: **giữ nguyên** (single-flight đúng chuẩn, trùng pattern đã audit chuẩn).
- Mức độ tự tin: Cao

### Pattern: Error handling classified
- Hiện tại: mọi fail post `{type:"error", requestId, message: "<phase>: <detail>"}` với phase rõ (rebuild-failed/query-failed, dòng 146-174); không throw ra ngoài worker glue (test 6 "posts error and does NOT throw"); empty query short-circuit không đụng index (dòng 141-145).
- 2026 khuyến nghị: **giữ nguyên** — đạt chuẩn Luật 4 (phân loại phase, log có ngữ cảnh, không nuốt lỗi, fallback đúng kiểu dữ liệu).
- Mức độ tự tin: Cao

### Pattern: **RACE TIỀM ẨN — `invalidate` trong lúc rebuild đang chạy** (finding)
- Hiện tại: case "invalidate" (dòng 186-188) chỉ set `stale = true`; `performRebuild` (dòng 112-120) khi xong set `stale = false` VÔ ĐIỀU KIỆN. Nếu invalidate tới giữa rebuild (sau `toArray()` resolve, trước `stale = false`) → rebuild xong ghi đè `stale = false` → mất tín hiệu invalidate → query kế tiếp dùng index snapshot CŨ (thiếu file vừa đổi trong DB). Cửa sổ hẹp (giữa 2 await) nhưng là race condition thật.
- Search đã làm: pattern shared-promise + stale-flag (xác nhận từ source); kiểm tra test suite — `search.worker.test.ts` có 8 cases (test 4 invalidate khi index sẵn sàng, test 8 concurrent queries chia sẻ rebuild) nhưng KHÔNG có case "invalidate mid-rebuild".
- 2026 khuyến nghị: **nâng cấp TÙY CHỌN (hardening 2-3 dòng)** — sau `performRebuild` chỉ set `stale = false` nếu không có invalidate mới: VD `if (searchWorkerState.stale) { index = built; stale = false }` với đánh dấu invalidate riêng (VD `rebuildToken` counter — invalidate tăng counter, rebuild capture token lúc start, chỉ commit index nếu token không đổi).
- Lý do nếu nâng cấp: **thiếu chuẩn ngành (race condition)** — đạt threshold; fix tối thiểu, không đổi protocol/API.
- Mức độ tự tin: Trung bình (race có thật về mặt lý thuyết; chưa có evidence bug xảy ra ở runtime; cần Main Agent cân nhắc route: nếu coi là bug → closed-loop-bugfix với regression test RED→GREEN; nếu coi là hardening → modernize task riêng, TDD test "invalidate mid-rebuild").
- Rủi ro nếu nâng cấp: thấp — thay đổi nội bộ worker state; protocol/export không đổi; test cũ (8 cases) phải vẫn xanh.

### Test companion
- **CÓ** `search.worker.test.ts` ✓ (8 cases: init/rebuild/no-rebuild/invalidate/empty/rebuild-fail/query-fail/concurrency).

---

## File 6: `src/workers/proSync.worker.ts` (51 dòng)

### Pattern: Worker glue bridge (`addEventListener` + guard) + typed message
- Hiện tại (dòng 11-12 union type; 14-25 `isWorkerRequestMessage` guard; 30-34 `if (typeof self !== "undefined") self.addEventListener("message", ...)`; 36-46 handleWorkerMessage → pushToken / runSync).
- Search đã làm: MDN Worker/structured clone (như File 5).
- 2026 khuyến nghị: **giữ nguyên**
- Lý do: guard testable (vitest node scope — comment dòng 27-29); message guard đủ (type + token typeof string); glue mỏng đúng trách nhiệm. Khác biệt nhỏ: dùng `addEventListener` (dòng 31) trong khi search.worker dùng `self.onmessage` (search.worker.ts:207) — cả 2 đều hợp lệ, style-only (xem Cross-file #2).
- Mức độ tự tin: Cao

### Pattern: handleWorkerMessage không try/catch trực tiếp
- Hiện tại (dòng 36-46): không catch — `runSync`/`pushToken` xử lý lỗi nội bộ.
- Search đã làm: đọc `syncRunner.ts` (sibling): `runSync` (dòng 30-46) wrap try/catch + retryFullSync loop (dòng 81-114) + refreshTokenAndRetry với max retries (syncRetry, dòng 25) + try/catch các bước nhỏ (dòng 126-220); `pushToken` (dòng 49-67) có catch typed.
- 2026 khuyến nghị: **giữ nguyên** — catch ở glue là thừa (double-handling); error handling đã đầy đủ ở layer dưới với retry giới hạn + log có ngữ cảnh (đúng Luật 4). Không nuốt lỗi.
- Mức độ tự tin: Cao (verified source syncRunner.ts)
- Rủi ro nếu nâng cấp: không áp dụng.

### Test companion
- **CÓ** `proSync.worker.test.ts` ✓ (+ `workerError.test.ts` cùng thư mục).

---

## Cross-file findings (backlog — KHÔNG sửa)

1. **`src/hooks/useNavStatePersistence.ts:28-39`** — dùng `useShallow` + object selector cho `useDriveStore`: đã chuẩn v5 (không phải finding sửa, ghi nhận để Giai đoạn 3 không động vào).
2. **Worker glue style không nhất quán** — `search.worker.ts:207` dùng `self.onmessage = ...`; `proSync.worker.ts:31` dùng `self.addEventListener("message", ...)`. Cả 2 hợp lệ; nếu chuẩn hoá là refactor cosmetic — KHÔNG đạt threshold.
3. **Updater-function action pattern lặp** — `playerStore.ts:75-109` ×4 (setCurrentTrack/setIsPlaying/setPlayMode/setPlaybackQueue) + `driveStore.ts:77-82` ×1 (setFolderHistory). Extract helper chung tiết kiệm ~8-10 dòng/file = ~8% < 20% → không đạt threshold; backlog refactor nếu Main Agent muốn gộp (cần test consumer hiện có cover).
4. **`src/workers/syncRunner.ts`** (sibling của proSync.worker) — đã có retry/backoff giới hạn + catch phân loại đầy đủ; không cần backlog. `src/workers/tokenRefresh.ts`, `driveFetch.ts`, `driveMapping.ts` là deps được re-export ở proSync.worker.ts:48-51 (export surface có chủ đích cho test) — giữ nguyên.
5. **Toàn codebase — zustand chỉ có 3 store files** (`grep -l zustand src` = App.tsx + 7 hooks consumers + 3 stores). Không có store khác bị bỏ sót. Consumer hooks (useAuth, useDrive, useDriveInit, useDriveNavigation, useDriveRootSelector, useNavStatePersistence, usePlayer) ĐỀU bọc `useShallow` — không có nơi nào vi phạm stable-selector v5.
6. **MiniSearch v7.1+ `boostTerm`** — có sẵn trong version 7.2.0 đang dùng nhưng chưa dùng; KHÔNG phải backlog (không phải pattern cũ cần thay, chỉ là option mới nếu sau này cần boost theo term).

## MCP fallback note
N/A — DuckDuckGo MCP (search + fetch_content) và context7 đều khả dụng từ đầu, không cần fallback. Nguồn đã dùng: zustand.docs.pmnd.rs migration v5 (chính thức), GitHub minisearch CHANGELOG (chính thức), context7 `/pmndrs/zustand` + `/lucaong/minisearch`, MDN (structured clone/postMessage), node_modules d.ts (zustand 5.0.14, minisearch 7.2.0 `dist/es/index.d.ts`).

## Tổng kết đề xuất

| File | Pattern | Quyết định | Threshold đạt |
|---|---|---|---|
| playerStore.ts | zustand v5 create API | giữ nguyên | — (đã chuẩn v5) |
| playerStore.ts | updater-function ×4 | giữ nguyên | — (~8% < 20%) |
| playerStore.ts | không persist (session ngoài) | giữ nguyên | — (có chủ đích, tránh 2 nguồn sự thật) |
| playerStore.ts | consumer stable selector | giữ nguyên | — (đã useShallow) |
| driveStore.ts | zustand v5 create | giữ nguyên | — (đã chuẩn) |
| authStore.ts | zustand v5 + token | giữ nguyên | — (không log token; không persist) |
| searchEngine.ts | minisearch v7 API | giữ nguyên | — (mọi API đúng v7, comment chính xác) |
| search.worker.ts | worker glue + protocol + single-flight + error | giữ nguyên | — (đã chuẩn) |
| search.worker.ts | **race invalidate-mid-rebuild** | **nâng cấp tùy chọn (hardening 2-3 dòng)** | **thiếu chuẩn ngành (race condition)** |
| proSync.worker.ts | worker glue + no-catch bridge | giữ nguyên | — (error ở layer dưới, verified) |

**Khuyến nghị hành động duy nhất:** race trong `search.worker.ts` — Main Agent quyết định route (bugfix có regression test "invalidate mid-rebuild" RED→GREEN, hoặc modernize hardening TDD). Còn lại 6 file đều đã đạt chuẩn 2026 của zustand 5.0.14 / minisearch 7.2.0 / Web Worker.
