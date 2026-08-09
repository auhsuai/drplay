# Audit Batch 1 — Core utils

Ngày: 2026-08-09
Scope: 6 file core (hooks + utils), audit-only — KHÔNG sửa code.
Project: drplay (Tauri v2 + React 19.2 + TypeScript 5.8 strict + zustand 5 + dexie 4)

**LƯU Ý KHÁC BIỆT SO VỚI MÔ TẢ GIAO VIỆC (5C.1):**
1. **Mojibake `�?"` KHÔNG tồn tại.** Grep `rg -n "�"` toàn `src\` = 0 kết quả; grep mojibake sequences (`â€|Ã|Â§|â€™|â€œ`...) = 0 kết quả. Các comment trong 6 file dùng em-dash UTF-8 hợp lệ `—` (VD `useServiceWorker.ts:31`, `coverStore.ts:31`, `sessionCleanup.ts:5`...). Không có gì để sửa.
2. **`coverStore.ts` KHÔNG dùng localStorage** — không có "localStorage guard" để audit.
3. **`sessionCleanup.ts` ĐÃ dùng `Promise.allSettled`** (dòng 34) — không phải `Promise.all` như mô tả.

---

## File 1: `src/hooks/useServiceWorker.ts` (184 dòng)

### Pattern: Service Worker register + token push qua `.then()` chain (pyramid)
- Hiện tại (dòng 44-94, 127-142): `navigator.serviceWorker.register().then((reg) => { navigator.serviceWorker.ready.then(...).catch(...); reg.addEventListener("updatefound", ...) }).catch(...)` — nested 2 tầng; thêm effect thứ 2 (dòng 127-142) `navigator.serviceWorker.ready.then(...).catch(...)` cho token-watcher.
- Search đã làm:
  - react.dev useEffect: https://react.dev/reference/react/useEffect (cleanup + race handling)
  - MDN ServiceWorkerContainer.ready: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/ready
- 2026 khuyến nghị: **giữ nguyên**
- Lý do: chuyển async/await chỉ được qua IIFE (`void (async () => {...})()`) vì effect không thể là async; ước lượng tiết kiệm ~10-15% số dòng (effect 1: 73 → ~62 dòng), KHÔNG đạt threshold ≥20%. Mọi catch đã typed `err: unknown` + log có ngữ cảnh + không nuốt lỗi. Comment tại chỗ giải thích "why" (worker đang installing, idempotent push, vì sao watcher thứ 2 cần thiết) — chuẩn ngành đạt.
- Mức độ tự tin: Cao
- Rủi ro nếu nâng cấp: thấp (pure refactor) nhưng không đáng — lợi ích không qua threshold.

### Pattern: `catch (e: unknown)` + captureError có ngữ cảnh
- Hiện tại (dòng 21, 61, 88, 135, 171): toàn bộ catch typed `unknown`, log kèm `source: "useServiceWorker"` + prefix `sw-...` + phân loại `e instanceof Error`.
- Search đã làm: MDN try/catch (chuẩn TS 4.4+ `useUnknownInCatchVariables` — tsconfig.json:18 `"strict": true`).
- 2026 khuyến nghị: **giữ nguyên** — đây đúng chuẩn 2026 (không `catch (e)` bừa, không nuốt lỗi, log có context).
- Mức độ tự tin: Cao

### Pattern: cast hẹp có kiểm tra (`(ev as CustomEvent<{token?: unknown}|null>).detail`, `event.data as {type?: unknown}|null`)
- Hiện tại (dòng 146, 169): cast tới type có `unknown` field + kiểm tra `typeof t === "string"` / `data.type !==` trước khi dùng.
- 2026 khuyến nghị: **giữ nguyên** — guard trước cast đúng chuẩn, không phải `as any` (grep xác nhận: `as any` chỉ xuất hiện trong comment, 0 trong code 6 file).
- Mức độ tự tin: Cao

### Pattern: 2 useEffect cùng dep `[token]` (lifecycle push + watcher push)
- Hiện tại (dòng 41-116 + 127-142): chủ đích, có comment giải thích (duplicates harmless vì SW handler idempotent; watcher cần thiết vì register/claim xong trước khi OAuth xong).
- 2026 khuyến nghị: **giữ nguyên** — gộp 2 effect lại sẽ phá logic race mà comment mô tả.
- Mức độ tự tin: Cao

---

## File 2: `src/hooks/useTauriEvents.ts` (35 dòng)

### Pattern: `listen().then((fn) => ...)` + `cancelled` flag trong useEffect
- Hiện tại (dòng 8-34): `void listen(TAURI_EVENT_QUOTA, ...).then((fn) => { if (cancelled) { fn(); return; } quotaFn = fn; }).catch(...)`; cleanup: `cancelled = true; quotaFn?.();`.
- Search đã làm: context7 `/websites/v2_tauri_app` — tài liệu chính thức v2:
  - https://v2.tauri.app/reference/javascript/api/namespaceevent (`listen<T>(event, handler, options?): Promise<UnlistenFn>`)
  - https://v2.tauri.app/develop/_sections/frontend-listen — ví dụ useEffect cleanup chính thức: `return () => { unlisten.then((fn) => fn()); };`
- 2026 khuyến nghị: **giữ nguyên**
- Lý do: đây CHÍNH LÀ pattern docs chính thức Tauri v2 (`.then((fn) => fn())` trong useEffect); `cancelled` flag còn CẢI TIẾN hơn docs (chống race khi unmount nhanh). `listen` không hỗ trợ AbortController nên flag pattern là chuẩn duy nhất. Chuyển async/await ước lượng ~15% ngắn hơn — dưới threshold 20%.
- Mức độ tự tin: Cao (tài liệu chính thức)
- Rủi ro nếu nâng cấp: không đáng; đổi khỏi pattern docs chính thức.

---

## File 3: `src/utils/nextTrackPrefetcher.ts` (91 dòng)

### Pattern: `fetch` + `AbortSignal.any([controller.signal, AbortSignal.timeout(...)])` + `classifyError` + `.finally` cleanup
- Hiện tại (dòng 40-79): kết hợp manual-cancel + timeout đúng MDN; `classifyError` (dòng 23-32) phân biệt `timeout | aborted | network | unknown`; `finally` xoá khỏi map; LRU-ish evict (dòng 16-21) + semaphore MAX_CONCURRENT=3.
- Search đã làm:
  - MDN AbortSignal.any (Baseline 2024, March 2024, có trong Web Workers): https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static — ví dụ MDN gộp `controller.signal + timeoutSignal` bằng `AbortSignal.any` y hệt code này
  - MDN AbortSignal.timeout: https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static
  - caniuse AbortSignal: https://caniuse.com/?search=AbortSignal
- 2026 khuyến nghị: **giữ nguyên** — đây là best practice MDN 2026 (Baseline 2024), không còn cách mới hơn.
- Mức độ tự tin: Cao (MDN chính thức)
- Ghi chú nhỏ: `AbortSignal.any` dùng vô điều kiện ở đây (dòng 45) trong khi `apiClient.ts:503`, `driveHttp.ts:35`, `driveRangeTokenizer.ts:150` có guard `typeof AbortSignal.any === "function"` → xem Cross-file findings #2.

### Pattern: `.then().catch().finally()` fire-and-forget (dòng 50-79)
- Hiện tại (dòng 50-79): `.then((response) => { if (!response.ok) return; try { void response.body?.cancel().catch(logCancelError); } catch (err) {...} })` + `.catch(classifyError + log)` + `.finally(delete map)`.
- Search đã làm: MDN fetch/Response.body.cancel; MDN Promise finally.
- 2026 khuyến nghị: **nâng cấp TÙY CHỌN (ưu tiên thấp)** — chuyển sang `void (async () => { try { const r = await fetch(...); ... } catch { ... } finally { ... } })()`
- Lý do nếu nâng cấp: ước lượng ~47 → ~33 dòng (~30% ngắn hơn, ĐẠT threshold số dòng); flatten nested callback; pure refactor, hành vi không đổi. NHƯNG: phải GIỮ try/catch lồng cho `body.cancel()` (đường lỗi riêng — cancel-fail KHÔNG được đi qua `classifyError` vì sẽ gán nhầm kind), nên lợi ích đọc mã là có nhưng khiêm tốn. Để Main Agent quyết định; nếu làm → cần regression test (nextTrackPrefetcher.test.ts tồn tại, assert eviction + cancel).
- Mức độ tự tin: Trung bình
- Rủi ro nếu nâng cấp: thấp (pure refactor, không đổi public API `prefetchNextTrackAudio`/`clearNextTrackPrefetches`/`getPendingPrefetchCount`); consumer: `usePlayer.ts:244`, `MainContent.tsx:240`, `cache.ts:248`.

---

## File 4: `src/utils/sessionCleanup.ts` (51 dòng)

### Pattern: `Promise.allSettled([...]).then(...)` fire-and-forget + try/catch localStorage
- Hiện tại (dòng 18-50): localStorage removeItem trong try/catch (log `kind: "localstorage-cleanup-failed"`); kv cleanup qua `void Promise.allSettled([...]).then((results) => { rejected → captureError })`.
- Search đã làm: MDN Promise.allSettled (Baseline, July 2020): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled — "used when you have multiple async tasks not dependent on each other, and you'd always like to know the result of each promise".
- 2026 khuyến nghị: **giữ nguyên**
- Lý do: ĐÃ dùng đúng `allSettled` (đúng chuẩn — cần biết kết quả TỪNG task, không fail-fast). `.then` bắt buộc vì hàm phải giữ sync (`: void`) — comment nói rõ "logout must not block on kv cleanup"; chuyển async sẽ đổi signature + đổi hành vi logout (block). Consumer: `App.tsx:95` (`clearSessionState()`).
- Mức độ tự tin: Cao
- Ghi chú: `catch (err)` (dòng 22) không annotate — với TS strict `useUnknownInCatchVariables` vẫn là `unknown` nên type-safe; chỉ khác style so với `catch (e: unknown)` trong codebase. Không đáng sửa.

---

## File 5: `src/utils/metadata/api.ts` (113 dòng)

### Pattern: Single-flight shared promise (`inflightMetadata: Map<string, Promise<CachedMetadata>>`) + `.then(onFulfilled, onRejected)` side-effect
- Hiện tại (dòng 18, 34-79): dedupe bằng trả về CHÍNH promise đang in-flight (`if (existing) return existing;`); `.then(result → cleanup, e → log + cleanup)` KHÔNG rethrow; `setTimeout(cleanup, INFLIGHT_TIMEOUT)` làm lưới an toàn.
- Search đã làm: pattern single-flight/dedupe in-flight request — https://maxrozen.com/race-conditions-fetching-data-react-with-useeffect ; MDN Promise.then hai đối số (onFulfilled/onRejected tách biệt → không unhandled rejection). Xác nhận trong repo: `apiClient.ts:87` dùng Y HỆT pattern này cho token refresh (single-flight + two-arg .then) → pattern CÓ CHỦ ĐÍCH, không phải code cũ.
- 2026 khuyến nghị: **giữ nguyên**
- Lý do phân tích kỹ (như cảnh báo trong nhiệm vụ): (a) shared-promise LÀ bắt buộc cho dedupe — giữ nguyên. (b) Chuyển async/await về mặt kỹ thuật KHẢ THI (giữ dedupe qua early-return) nhưng: phải `throw e` trong catch để bảo toàn rejection propagation (hiện tại rejection lan truyền vì trả về promise GỐC — nếu quên rethrow khi chuyển async/await sẽ nuốt lỗi, phá consumer `useTrackMetadata`); ước lượng chỉ ~24% ngắn hơn và ăn vào cấu trúc try/catch/rethrow. Two-arg `.then` trên shared promise là canonical cho side-effect logging — không deprecated, không lỗi thời.
- Mức độ tự tin: Cao
- Rủi ro nếu nâng cấp: TRUNG BÌNH — trap "quên rethrow" đổi hành vi lỗi âm thầm; lợi ích không bù rủi ro → khuyến nghị giữ nguyên.

### Pattern: `updateTrackDuration` async/await + try/catch phân loại
- Hiện tại (dòng 81-113): đã async/await, catch typed, log `classifyMetaError(e).message`, fallback (memory cache là source of truth), vẫn dispatch event sau fail. 
- 2026 khuyến nghị: **giữ nguyên** — đã chuẩn 2026.
- Mức độ tự tin: Cao

---

## File 6: `src/utils/coverStore.ts` (167 dòng)

### Pattern: Semaphore giới hạn concurrency + retry phân loại + circuit breaker `schemeUnavailable`
- Hiện tại (dòng 25-33, 82-143): `createSemaphore(3)`; retry chỉ cho 5xx/429 (`isRetryableStatus`, dòng 73-75) tối đa 1 lần; TypeError → `schemeUnavailable = true` vĩnh viễn (comment giải thích Chromium ERR_UNKNOWN_URL_SCHEME); `AbortSignal.timeout(10_000)`.
- Search đã làm: MDN AbortSignal.timeout: https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static; retry/backoff giới hạn — chuẩn AGENTS.md Luật 4.
- 2026 khuyến nghị: **giữ nguyên** — đã vượt chuẩn (phân loại 4xx vs 5xx/429, retry giới hạn, không nuốt lỗi, log có `kind`).
- Mức độ tự tin: Cao

### Pattern: `catch (e)` không annotate (dòng 133)
- Hiện tại (dòng 133-141): `catch (e) { if (e instanceof TypeError) schemeUnavailable = true; throw e; }` — rethrow có kiểm soát, phân loại đúng.
- 2026 khuyến nghị: **giữ nguyên** (style-only; TS strict đã coi là unknown; chính xác về mặt type).
- Mức độ tự tin: Cao

### Pattern: magic number `status === 200` (dòng 107)
- Hiện tại: `if (status === 200) return;` — HTTP 200 là hằng số domain phổ quát; 429/5xx đã có tên qua `isRetryableStatus`.
- 2026 khuyến nghị: **giữ nguyên** — không phải "magic number" gây hiểu nhầm; đổi thành `const HTTP_OK = 200` chỉ thêm noise. Ghi nhận là micro-nit.
- Mức độ tự tin: Cao

### Pattern: `buildCoverBlobUrl` không revoke blob (dòng 55-67)
- Hiện tại: cố ý không revoke, comment giải thích đầy đủ (blob nhỏ, revoke khi `<img>` còn reference → vỡ ảnh; browser tự dọn khi unload).
- 2026 khuyến nghị: **giữ nguyên** — quyết định có chủ đích + có lý do kỹ thuật đúng.
- Mức độ tự tin: Cao

---

## Cross-file findings (backlog — KHÔNG sửa)

1. **`src/utils/apiClient.ts:80-98`** — `withTimeout` dùng `new Promise` + `setTimeout` + two-arg `.then`; có thể viết lại bằng `Promise.withResolvers()` (Baseline 2024, https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers) — ngắn hơn ~20-25%, bỏ executor ceremony. Cũng là shared-promise `.then` pattern (xác nhận metadata/api.ts giữ nguyên là đúng).
2. **`src/utils/apiClient.ts:499-504`, `src/utils/driveHttp.ts:29-36`, `src/utils/driveRangeTokenizer.ts:149-151`** — guard `typeof AbortSignal.any === "function"` trước khi dùng; `nextTrackPrefetcher.ts:45` dùng vô điều kiện → không nhất quán (rủi ro thực tế ~0 vì WebView2 evergreen ≥ Chromium 116, nhưng nếu muốn thống nhất: hoặc thêm guard, hoặc gỡ guard 3 chỗ kia).
3. **Toàn codebase — `catch (err)`/`catch (e)` không annotate**: 100+ chỗ (VD `src/workers/syncRunner.ts` ~15 chỗ, `src/ui/Playlist/PlaylistView.tsx:44,98,113,168`, `src/utils/upload/retry.ts:56,79,110,144`, `src/utils/errorLog.ts:42,50,59,83,144`, `src/ui/Settings/TrashScreen.tsx` ~5 chỗ...). Không phải bug (TS strict = unknown), chỉ không nhất quán style với 6 file audit (`catch (e: unknown)`). Backlog nếu muốn chuẩn hoá.
4. **`src/search/search.worker.ts:113`, `src/utils/upload/queue.ts:251`** — `Promise.all` trong production code: ĐÚNG (must-await-all semantics: cần cả 2 kết quả / tất cả DB writes phải thành công), không phải chỗ phải đổi allSettled.
5. **Mojibake**: 0 chỗ trong `src\` (đã grep `�` + các chuỗi mojibake thường gặp) → không có backlog sửa encoding.

## MCP fallback note
N/A — DuckDuckGo MCP (search + fetch_content) và context7 đều khả dụng, không cần fallback. Nguồn đã dùng: MDN (AbortSignal.any/timeout, Promise.allSettled, Promise.withResolvers), react.dev (useEffect), Tauri v2 docs chính thức (context7, namespaceevent + frontend-listen), caniuse.

## Tổng kết đề xuất
| File | Pattern | Quyết định | Threshold đạt |
|---|---|---|---|
| useServiceWorker.ts | `.then()` pyramid (dòng 44-94, 127-142) | giữ nguyên | — (dưới 20%) |
| useServiceWorker.ts | catch/cast/log | giữ nguyên | — |
| useTauriEvents.ts | `listen().then()` + cancelled flag | giữ nguyên | — (đúng docs Tauri v2) |
| nextTrackPrefetcher.ts | AbortSignal.any + timeout + classify | giữ nguyên | — (đã chuẩn MDN) |
| nextTrackPrefetcher.ts | `.then().catch().finally()` chain | **nâng cấp tùy chọn (thấp)** | ~30% ngắn hơn (dòng) |
| sessionCleanup.ts | allSettled + `.then` | giữ nguyên | — (đã đúng chuẩn) |
| metadata/api.ts | shared-promise single-flight | giữ nguyên | — (phân tích: bắt buộc) |
| coverStore.ts | semaphore/retry/circuit-breaker | giữ nguyên | — |
