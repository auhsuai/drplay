# ADR: Legacy `/drive-stream/` lane — metadata/download lane, không phải playback lane

- **Trạng thái:** Proposed (chưa triển khai)
- **Ngày:** 2026-09-19
- **Commit tham chiếu:** 7252004 (main)
- **Phạm vi:** RC-9 (§13 FINAL-ARCHITECTURE-AUDIT), debt G6 (§12), P1 F4/F9/S3, H2 (§12-H)
- **Ngoài phạm vi:** sửa `public/sw.js`, `streamPrefetcher.ts`, `swPrefetch.ts`, kiểu `Track` (quyết định tài liệu hóa, không code)

## 1. Bối cảnh (đọc từ code thật tại 7252004)

### 1.1 Hai hệ URL song song

| Lane | URL | Ai phục vụ | Ai dùng |
|---|---|---|---|
| Metadata/download (SW) | `/drive-stream/{fileId}[?ext=...]` — build tại `streamPrefetcher.ts:4,23-27`; serve tại `sw.js:851-868` | SW tự gọi Drive kèm Bearer, byte-cache IDB, override MIME theo `?ext` (66-80) | Range reads metadata + cover: `driveRangeChunkFetcher.ts:125` ← `DriveRangeTokenizer` ← `fetchPipeline.ts:125,179` (music-metadata); prefetch next-track (`usePlayerTrackPlayback.ts:262-281`) |
| Playback (Rust proxy) | `http://127.0.0.1:{port}/stream/{fileId}` — `mpvProtocol.ts:66-67`, dựng tại `mpvAudio.ts:979-981` | Rust `stream_proxy` (Bearer + Range, data plane độc lập) | mpv: `loadfile` (`mpvAudio.ts:763-767`) và stall reload (`1025`) |

### 1.2 `track.streamUrl` không phải đầu vào playback

- Được ghi lúc play: `usePlayerTrackPlayback.ts:186-189` (`buildStreamUrl` → SW lane).
- Được ghi lúc restore session: `usePlayerSession.ts:57-98`, và persist trong payload session (`writeSession({ track: currentTrack, ... })`, dòng 166-187).
- Được đọc làm **gate resume**: `usePlayer.ts:160` (`!currentTrack.streamUrl && !isPlaying` → dựng URL + `triggerReload`); và làm `refreshKey` hiển thị metadata NowPlaying (`useNowPlayingMetadata.ts:36,157`).
- **Engine không đọc**: `loadTrack` chỉ dùng `track.id` + port để dựng URL Rust proxy (`mpvAudio.ts:755-767`).
- `prefetchVisibleTracks` chỉ cache chuỗi URL (~20 byte/URL), không tải byte (`streamPrefetcher.ts:5,43-50`).

### 1.3 SW prefetch next-track: best-effort, chưa đo

`prefetchTrackInServiceWorker` (`swPrefetch.ts:4-12`) gửi `PREFETCH_TRACK`; SW tải **toàn bộ file** (`Range: bytes=0-`, `prefetchTrackBytes`, sw.js:736-773) vào IDB, chạy sau `first-audio`, không có fallback (`usePlayerTrackPlayback.ts:250-281`). Vì mpv không đi qua SW, byte-cache này **không tăng tốc playback**; khả năng thực tế chỉ là hâm nóng metadata/cover range reads cho track kế — chưa có số đo. Audit xếp H2 là "nghi vấn waste quota, CHƯA ĐO" (§12-H, §17 Q14).

### 1.4 Đối chiếu audit ↔ code

- Audit RC-9/P1 F4 mô tả `track.streamUrl` "ghi/persist nhưng engine không đọc" — **khớp code**, và còn đọc làm gate (`usePlayer.ts:160`) — audit S3 cũng ghi nhận gate `!streamUrl`.
- Số dòng audit cite (`usePlayerSession.ts:70-90`) đã lệch nhẹ so với code tại 7252004 (57-98) do các refactor sau commit audit (6abe754 → 7252004). ADR bám code thật.
- Audit P8 §16 mục 14 giữ nguyên "SW prefetch best-effort + metadata cooldown" — ADR này ghi nhận là ranh giới bất biến.

## 2. Quyết định

1. **Chốt boundary thành 2 lane có tên:**
   - `/drive-stream/` = **metadata/download lane** (SW byte-cache, range reads, prefetch best-effort). Được phép phụ thuộc `?ext=`, byte-cache IDB, circuit-breaker metadata.
   - Rust proxy `/stream/` = **playback lane duy nhất**. Không thêm consumer mới vào `/drive-stream/` cho playback.
2. **`track.streamUrl` là UI-resume marker, không phải playback input.** ADR ghi rõ ngữ nghĩa này. **Follow-up (không làm bây giờ):** thay gate `!streamUrl` bằng cờ semantic (`hasStream`/`playable`) trong một session riêng — vì `streamUrl` đang là field persist (session cũ) nên đổi bây giờ cần migration payload, không đáng trong slice tài liệu này.
3. **SW prefetch next-track: HOÃN thay đổi cho tới khi có đo runtime.** Không tắt, không sửa bây giờ (giữ silent-drop + best-effort). Cách đo (nếu tiến hành) ghi ở mục 5.
4. **Không đụng:** SW prefetch best-effort + metadata cooldown (§16 mục 14); data plane boundary của Rust proxy (§16 mục 4); circuit-breaker/range retry của metadata lane (đang chạy đúng).

### Hệ quả chấp nhận
- Drift MIME/ext giữa 2 lane vẫn tồn tại (SW-only `?ext=`; Rust proxy không cần vì mpv nhận `Content-Type` gốc + decode theo nội dung — xem `mpvAudio.test` behaviors). Chấp nhận vì đã có boundary rõ + test `swMime.test.ts` giữ đồng bộ bảng MIME.
- `streamUrl` tiếp tục là field persist lịch sử; không rename để tránh vỡ session cũ.

## 3. Vì sao không xoá `track.streamUrl` và không hợp nhất 2 lane (bây giờ)

1. **Không xoá `streamUrl`:** field này là payload đã persist trong session/queue cũ (`writeSession({ track: currentTrack, ... })`, `usePlayerSession.ts:166-187`); bỏ ngay sẽ cần migration + version schema cho dữ liệu đã lưu trên máy user. Gate `!streamUrl` (`usePlayer.ts:160`) còn quyết định nhánh resume — thay một field ghi/đọc 4 chỗ bằng cờ mới là slice riêng, không phải việc tài liệu hóa.
2. **Không hợp nhất 2 lane:** SW lane là nền của metadata/cover + byte-cache (range reads nhỏ, chịu circuit-breaker riêng); Rust proxy là data plane streaming cho mpv (không biết track state — §16 mục 4). Gộp sẽ đổi data plane đang "bền vững tốt" (§16 mục 3-4) hoặc bắt webview/SW phụ thuộc tiến trình Rust — rủi ro cao hơn lợi ích.
3. **Không đổi prefetch bây giờ:** chưa có số đo (H2); sửa khi chưa đo là đổi hành vi best-effort dựa trên suy đoán — vi phạm chính nguyên tắc "không nâng HYP thành FACT" của audit (§12-H, §17 Q14).

## 4. Open questions

1. Số đo waste quota thực tế của prefetch (H2) — chưa có; quyết định tắt/thu hẹp hoãn tới khi đo.
2. SW byte-cache có thực sự giảm range read trùng cho metadata của track kế không (lợi ích bù trừ)? Chưa đo.
3. Session schema version nào phù hợp để bỏ/đổi tên `streamUrl` sang cờ semantic (follow-up của mục 2.2)?
4. Có lane download/export nào khác đang ngầm dùng `/drive-stream/` không? Hiện grep chỉ thấy metadata pipeline + prefetch (mục 1.1); cần grep lại trước khi thực hiện follow-up.

## 5. Cách đo waste quota nếu tiến hành sau (chưa thực hiện)

Mục tiêu: trả lời H2 bằng số, không bằng suy đoán. Các bước đề xuất:

1. **Instrument (không đổi hành vi):** thêm đếm tại SW — byte tải cho `PREFETCH_TRACK` (trong `prefetchTrackBytes`, sw.js:736-773) vs byte phục vụ từ byte-cache cho range request thật của cùng `fileId` (nhánh `serveFromByteCache`, sw.js:839-841). Ghi log tổng hợp theo phiên, không log nội dung/token.
2. **Đối chiếu chéo:** với mỗi file được prefetch, đánh dấu (a) có range read nào sau đó không, (b) có được phát qua Rust proxy không (suy ra tổng egress = prefetch + playback). Nguồn log sẵn có: `driveRangeTokenizer` (driveRangeChunkFetcher.ts:106,148) + SW `byteCacheLog`.
3. **A/B:** bật/tắt prefetch bằng flag nháp trong N phiên trên tài khoản test; so request/byte lên Drive giữa 2 nhánh; nếu có quyền truy cập Google API quota/console thì đối chiếu dashboard.
4. **Ngưỡng quyết định:** chỉ mở slice tắt/thu hẹp khi số đo cho thấy phần lớn byte prefetch không được tái sử dụng trong cùng phiên. Mọi thay đổi phải giữ hợp đồng best-effort: lỗi prefetch không nổi lên UI, không chặn playback (`swPrefetch.ts:4-12`).

## 6. Ranh giới không đụng (nhắc lại có chủ đích)

- Không sửa `sw.js`, `streamPrefetcher.ts`, `swPrefetch.ts`, kiểu `Track` trong slice này.
- Không đổi cơ chế SW wait-token/401 (`sw.js:775-833`).
- Không đổi hành vi silent-drop của prefetch (`swPrefetch.ts:4-12`; SW:717, 757-772).
- Không đổi metadata defer `first-audio` + fallback 9s (`usePlayerTrackPlayback.ts:197-281`).
