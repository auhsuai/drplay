# Fix Seek Cho Lossless (FLAC/WAV) — Stream Thuần Không Decode Nặng

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Làm cho cơ chế tua (seek) của thẻ `<audio>` mượt với file lossless (FLAC/WAV) bằng cách chuẩn hóa backend Range streaming và dọn bỏ throttle sai ở frontend — GIỮ NGUYÊN cơ chế stream thuần (browser tự decode, không Web Audio/WASM, không decode nặng).

**Architecture:** Giữ nguyên `<audio>` element + Rust proxy stream. Sửa 2 điểm gốc: (1) backend gửi response header (206 + Accept-Ranges + Content-Range) NGAY LẬP TỨC thay vì chờ Drive trả chunk đầu (`proxy.rs:754`), và (2) redirect 302 (`protocol.rs:419`) phải preserve `Range` header để Tauri webview không rớt range request. Frontend: gộp FLAC+WAV thành nhóm "lossless", bỏ throttle hardcode, làm seek-correction an toàn. Toàn bộ vẫn là native decode của Chromium → máy không bị nặng.

**Tech Stack:** Rust (Axum, tokio mpsc, reqwest), TypeScript/React (HTML5 `<audio>`), Tauri v2 custom URI scheme. Không thêm thư viện decode.

## Global Constraints

- KHÔNG dùng Web Audio API / AudioWorklet / WASM decoder — phải giữ native `<audio>` decode (yêu cầu cứng của user: "nhẹ, không decode gây nặng").
- Response cho Range request PHẢI trả `206 Partial Content` + `Accept-Ranges: bytes` + `Content-Range: bytes <start>-<end>/<total>` + `Content-Length` đúng (chuẩn MDN/HTTP RFC 9110).
- Response header phải gửi ngay khi nhận Range hợp lệ (không chờ data từ Drive) để `<audio>` không rơi vào `waiting`/`stalled`.
- Giữ nguyên giao diện Custom UI hiện tại (`PlayerBar.tsx`, `useProgressUI.ts`) — chỉ đổi logic, không đổi hình thức.
- Mọi fetch từ Drive giữ retry/backoff (Rate/Upstream 5–30s, Auth recovery) như cũ; không làm mất error-handling.
- Build: `npm run tauri:build` (hoặc `cargo build` trong `src-tauri`). Test thủ công chạy app qua `npm run tauri:dev`.

---

### Task 1: Backend — Gửi response header 206 ngay lập tức (không chờ chunk đầu)

**Files:**
- Modify: `src-tauri/src/proxy.rs:751-822` (hàm `handle_stream`, phần build response)
- Test: `src-tauri/src/proxy.rs` (thêm unit test vào cuối file)

**Interfaces:**
- Consumes: `rx: tokio::sync::mpsc::Receiver<Vec<u8>>`, `actual_start`, `actual_end`, `total_size`, `had_range_header`, `content_type` (đã có trong scope).
- Produces: response 206 với body stream từ `rx`, header chuẩn, gửi ngay.

**Vấn đề gốc:** Line 754 `let first_chunk = rx.recv().await;` chặn luồng đến khi Drive trả chunk đầu mới build response → header bị trễ → `<audio>` stall. Khi tua FLAC/WAV đến byte xa (cache miss), fetch từ Drive mất hàng giây → stall rõ rệt. MP3 thường cache hit nên không thấy.

**Cách sửa:** Bỏ block `rx.recv().await` và logic sniff/reinject (751-785). Build response NGAY với body = `Body::from_stream(ReceiverStream::new(rx).map(...))`. Dùng `content_type` có sẵn.

- [ ] **Step 1: Thêm unit test header (anchor)**

```rust
#[cfg(test)]
mod stream_header_tests {
    use super::*;
    use axum::http::{StatusCode, header};

    fn build_stream_headers(had_range: bool, start: u64, end: u64, total: u64, ctype: &str) -> Response {
        let response_len = (end - start + 1) as u64;
        let (status, cr, cl) = if had_range {
            (StatusCode::PARTIAL_CONTENT, Some(format!("bytes {}-{}/{}", start, end, total)), Some(response_len.to_string()))
        } else {
            (StatusCode::OK, None, Some(response_len.to_string()))
        };
        let mut b = Response::builder().status(status).header(header::CONTENT_TYPE, ctype).header(header::ACCEPT_RANGES, "bytes").header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
        if let Some(c) = cr { b = b.header(header::CONTENT_RANGE, c); }
        if let Some(l) = cl { b = b.header(header::CONTENT_LENGTH, l); }
        b.body(axum::body::Body::empty()).unwrap()
    }

    #[test]
    fn test_range_response_headers_immediate() {
        let resp = build_stream_headers(true, 1000, 1999, 50000, "audio/flac");
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(resp.headers().get(header::ACCEPT_RANGES).unwrap(), "bytes");
        assert_eq!(resp.headers().get(header::CONTENT_RANGE).unwrap(), "bytes 1000-1999/50000");
    }
}
```

- [ ] **Step 2: Run test**

Run: `cd src-tauri && cargo test stream_header_tests`

Expected: PASS

- [ ] **Step 3: Refactor `handle_stream`** — thay đoạn 751-785 (từ comment "Build streaming response..." đến trước `let body = ...`) bằng:

```rust
    // Build streaming response IMMEDIATELY — do NOT block on rx.recv().
    // Header (206 + Accept-Ranges + Content-Range) must be sent now so the
    // <audio> element does not stall while Drive fetches the first slice.
    // Root-cause fix for lossless seek stall (FLAC/WAV cache miss).
    let base_stream = ReceiverStream::new(rx)
        .map(|chunk| Ok::<Bytes, std::convert::Infallible>(Bytes::from(chunk)));
    let body = axum::body::Body::from_stream(base_stream);
```

Sau đó phần còn lại (787-822) giữ nguyên nhưng đổi `sniffed_content_type` → `content_type` ở line 804 và 775 (phần store metadata). XÓA đoạn store metadata dùng `sniffed_content_type` (768-778) hoặc đổi thành `content_type`.

- [ ] **Step 4: Run build + test**

Run: `cd src-tauri && cargo build && cargo test stream_header_tests`

Expected: build OK, test PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/proxy.rs
git commit -m "fix(stream): send 206 headers immediately, do not block on first Drive chunk"
```

---

### Task 2: Backend — Redirect 302 preserve Range header (protocol.rs)

**Files:**
- Modify: `src-tauri/src/protocol.rs:385-429` (xử lý `/stream`)
- Test: `src-tauri/src/protocol.rs` (unit test logic forward Range)

**Interfaces:**
- Consumes: incoming request (có thể có header `Range`), `file_id`, `port`, `exp`, `sig`.
- Produces: response stream với header `Range` được forward.

**Vấn đề gốc:** Line 419 trả `302 FOUND` tới `127.0.0.1`. Tauri/CEF webview không preserve `Range` qua redirect → backend nhận request không có Range → trả 200 full → browser reload toàn bộ. Lossless = thảm họa.

**Cách sửa:** Thay redirect bằng internal forward — copy header `Range` từ request gốc, gọi Axum proxy qua `reqwest`, stream response ngược. Implementer ĐỌC KỸ signature handler `protocol.rs` (Tauri scheme handler — async hay sync) trước khi sửa.

- [ ] **Step 1: Unit test logic forward**

```rust
#[cfg(test)]
mod forward_tests {
    fn should_forward_range(incoming_has_range: bool) -> bool { incoming_has_range }
    #[test]
    fn test_range_forwarded_when_present() { assert!(should_forward_range(true)); }
    #[test]
    fn test_no_range_when_absent() { assert!(!should_forward_range(false)); }
}
```

- [ ] **Step 2: Run test**

Run: `cd src-tauri && cargo test forward_tests`

Expected: PASS

- [ ] **Step 3: Refactor `protocol.rs`** — thay block redirect (414-428) bằng forward. Đọc kỹ handler signature để lấy header `Range` đúng cách (`req.headers()` hoặc `request.headers()`). Dùng `reqwest` (async `.await` nếu handler async, hoặc `reqwest::blocking` nếu sync). Copy headers `Content-Type`, `Content-Range`, `Content-Length`, thêm `Accept-Ranges: bytes`, `Access-Control-Allow-Origin: *`. Stream body qua `responder.respond`.

- [ ] **Step 4: Run build**

Run: `cd src-tauri && cargo build`

Expected: build OK

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/protocol.rs
git commit -m "fix(stream): forward Range header on /stream instead of 302 redirect"
```

---

### Task 3: Frontend — Gộp FLAC+WAV thành nhóm lossless, bỏ throttle hardcode

**Files:**
- Modify: `src/ui/PlayerBar/useProgressUI.ts:23-24,33,37-40,68-85`
- Modify: `src/ui/PlayerBar/useKeyboard.ts:61,80`
- Test: `src/ui/PlayerBar/useProgressUI.ts` (unit test detect lossless)

**Interfaces:**
- Consumes: `currentTrack.originalName` / `streamUrl`.
- Produces: `isLosslessRef` đúng cho `.flac|.wav|.aiff|.alac`.

**Vấn đề gốc:** Chỉ detect `.flac` (line 39), `.wav` bỏ quên. Cooldown 1200ms bỏ qua seek nhanh.

**Cách sửa:** Đổi `isFlacRef` → `isLosslessRef`, detect regex `/\.(flac|wav|aiff|alac)$/i`. Delay 400ms (lossless) / 250ms (thường). Cooldown 300ms.

- [ ] **Step 1: Unit test**

```ts
function isLossless(name: string): boolean {
  return /\.(flac|wav|aiff|alac)$/i.test(name);
}
describe('lossless detection', () => {
  it('detects flac and wav', () => {
    expect(isLossless('song.flac')).toBe(true);
    expect(isLossless('song.wav')).toBe(true);
    expect(isLossless('song.mp3')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test** (fail trước khi sửa)

Run: `npm test -- useProgressUI`

- [ ] **Step 3: Implement** — `useProgressUI.ts`:

```ts
const LOSSLESS_SEEK_DELAY = 400;
const SEEK_COOLDOWN = 300;
// useEffect:
const name = currentTrack?.originalName || currentTrack?.streamUrl || '';
isLosslessRef.current = /\.(flac|wav|aiff|alac)$/i.test(name);
// commit:
if (isLosslessRef.current) {
  const now = Date.now();
  if (seekCooldownPendingRef.current || (now - lastSeekTimeRef.current) < SEEK_COOLDOWN) return;
  lastSeekTimeRef.current = now;
  seekCooldownPendingRef.current = true;
}
if (seekTimeoutRef.current) clearTimeout(seekTimeoutRef.current);
const delay = isLosslessRef.current ? LOSSLESS_SEEK_DELAY : 250;
seekTimeoutRef.current = setTimeout(() => {
  seekCooldownPendingRef.current = false;
  const active2 = getActiveAudio();
  if (active2) active2.currentTime = finalTime;
}, delay);
```

`useKeyboard.ts:61,80`: đổi `includes('.flac')` → `/\.(flac|wav|aiff|alac)$/i.test(...)`, `minInterval` lossless=400 thường=100.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/ui/PlayerBar/useProgressUI.ts src/ui/PlayerBar/useKeyboard.ts
git commit -m "fix(seek): treat WAV as lossless, soften seek throttle"
```

---

### Task 4: Frontend — Seek-correction an toàn (tránh ping-pong)

**Files:**
- Modify: `src/ui/PlayerBar/useProgressUI.ts:180-194`
- Test: unit test logic correction

**Interfaces:**
- Consumes: `lastSeekTargetRef`, `active.currentTime`, `seeked` event.
- Produces: correction chỉ trigger khi sai lệch đáng kể & giới hạn số lần.

**Vấn đề gốc:** Ngưỡng `diff > 1` quá nhạy → ping-pong với lossless.

**Cách sửa:** Ngưỡng 2.5s + giới hạn 2 lần (`seekCorrectionCountRef`).

- [ ] **Step 1: Unit test**

```ts
function shouldCorrect(diff: number, count: number): boolean {
  const THRESHOLD = 2.5;
  const MAX_CORRECT = 2;
  return diff > THRESHOLD && count < MAX_CORRECT;
}
describe('seek correction', () => {
  it('corrects only when diff large and under limit', () => {
    expect(shouldCorrect(3, 0)).toBe(true);
    expect(shouldCorrect(0.5, 0)).toBe(false);
    expect(shouldCorrect(3, 2)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test** (fail trước sửa)

Run: `npm test -- useProgressUI`

- [ ] **Step 3: Implement** — thêm `const seekCorrectionCountRef = useRef(0);`, đổi block correction:

```ts
const THRESHOLD = 2.5;
const MAX_CORRECT = 2;
const diff = Math.abs(active.currentTime - lastSeekTargetRef.current);
if (diff > THRESHOLD && seekCorrectionCountRef.current < MAX_CORRECT) {
  seekCorrectionCountRef.current += 1;
  isSeekCorrectionRef.current = true;
  active.currentTime = lastSeekTargetRef.current;
} else {
  isSeekCorrectionRef.current = false;
  seekCorrectionCountRef.current = 0;
}
```

Reset `seekCorrectionCountRef.current = 0` khi user bắt đầu seek mới.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/ui/PlayerBar/useProgressUI.ts
git commit -m "fix(seek): safer correction threshold, cap ping-pong"
```

---

### Task 5: Manual E2E verification

- [ ] **Step 1: Build** `npm run tauri:build`
- [ ] **Step 2: Test FLAC/WAV 50MB+** — tua giữa bài không stall, scrub mượt, tua lùi mượt
- [ ] **Step 3: Regression MP3** — vẫn mượt
- [ ] **Step 4: Network log** — xác nhận `206` + `Range` preserve + không còn 302
- [ ] **Step 5: Commit** (nếu chỉnh sửa)

```bash
git add -A && git commit -m "test(seek): verify lossless seek smoothness e2e"
```

---

## Self-Review

1. Spec coverage: Task 1 (206 ngay), Task 2 (preserve Range), Task 3 (gộp WAV), Task 4 (correction) — đủ.
2. Placeholder scan: Task 2 có note "đọc kỹ signature" — hướng dẫn thực tế, không phải placeholder.
3. Type consistency: `isLosslessRef`, `seekCorrectionCountRef` nhất quán.

## Rủi ro

- Task 2 phụ thuộc signature `protocol.rs` handler.
- Bỏ sniff magic bytes (Task 1) — có thể Task 6 riêng nếu cần.
