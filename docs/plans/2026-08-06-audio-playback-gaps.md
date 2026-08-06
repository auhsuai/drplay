# Audio Playback Gaps Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 4 priority gaps from the audio-playback review (2026-08-06): Media Session API, mediaError.code classification, pause-save race, repeat-all infinite loop guard.

**Architecture:** 4 independent fixes — one new hook (useMediaSession) + 3 targeted bugfixes in AudioController/usePlayerSession/usePlayerQueue. Sequential on the same working tree.

**Tech Stack:** Web platform APIs (Media Session API, HTMLMediaElement.mediaError), React 19, existing player stack.

## Global Constraints

- **NGHIÊM CẤM tự nghĩ ra cơ chế fix** (user requirement): MỌI task PHẢI tra cứu chuẩn ngành trước khi code — DuckDuckGo MCP (search + fetch_content) + context7 cho phần liên quan lib/API; nguồn chính thức (MDN/W3C/web.dev/Chromium blog) qua webfetch nếu MCP không khả dụng. GHI RÕ nguồn + ngày truy cập trong report. Nếu implementation lệch chuẩn ngành → BẮT BUỘC báo cáo deviation kèm lý do, không âm thầm tự chế.
- TDD: test trước (red), code sau (green). Regression test bắt buộc với bugfix.
- TypeScript strict, không as any; hằng số có tên; captureError thống nhất; hàm ≤100 dòng; lint/tsc sạch; comment "why" tiếng Anh.
- Không đổi UI/i18n ngoài phạm vi task được giao; không tự merge/commit.
- Error handling chuẩn (AGENTS.md Luật 4): try/catch phân loại, không nuốt lỗi, log có ngữ cảnh không lộ secret.
- Baseline hiện tại: 86 files / 1140 tests pass, build sạch, lint sạch (commit 042f391).

---

### Task A: Media Session API (feature)

**Files:**
- Create: `src/hooks/useMediaSession.ts`
- Create: `src/hooks/useMediaSession.test.tsx`
- Modify: `src/hooks/usePlayer.ts` (mount hook — xem vị trí hợp lý)
- Test: `src/hooks/usePlayer.test.ts` (tạo mới nếu phù hợp — bổ sung luôn gap test coverage usePlayer)

**Industry standard (đã verify sơ bộ — subagent bắt buộc re-verify + fetch đầy đủ):**
- MDN Media Session API: metadata (MediaMetadata: title/artist/album/artwork), playbackState ('playing'|'paused'), setActionHandler('play'|'pause'|'nexttrack'|'previoustrack'|'seekto'|'seekbackward'|'seekforward'), positionState {duration, playbackRate, position} + updatePositionState() khi seek/timeupdate.
- Chỉ hoạt động khi navigator.mediaSession tồn tại (WebView2/Chromium có; phải guard).

**Behavior contract:**
- Hook mount khi player có track; update metadata khi currentTrack đổi (title real metadata nếu có, artist, album undefined — track không có, artwork bỏ trống — KHÔNG bịa artwork URL).
- playbackState theo isPlaying; action handlers gọi handler hiện có (togglePlay/playNext/playPrev/seek) qua props hoặc playerStore — KHÔNG tạo pipeline mới.
- positionState: duration/position/playbackRate, updatePositionState() sau seek + sau timeupdate (throttle theo AudioController 200ms là đủ).
- Unmount/test: guard navigator.mediaSession undefined → no-op, không throw.
- Không đụng AudioController.

- [ ] Step 1: Research (DDG/context7/MDN) — ghi nguồn.
- [ ] Step 2: Test red → implement → green.
- [ ] Step 3: Lint + tsc + commit-ready report.

---

### Task B: mediaError.code classification (bugfix)

**Files:**
- Modify: `src/lib/AudioController.ts` (error handler ~224-262, error event payload)
- Modify: `src/lib/AudioController.test.ts`
- Có thể: `src/ui/PlayerBar/PlayerBar.tsx` (error banner mapping — chỉ nếu cần)

**Industry standard (verify):** MDN MediaError.code — 1=MEDIA_ERR_ABORTED (user/seek, không phải lỗi — bỏ qua im lặng), 2=MEDIA_ERR_NETWORK (retry được — giữ retry hiện tại), 3=MEDIA_ERR_DECODE (file hỏng — retry không cứu → skip ngay), 4=MEDIA_ERR_SRC_NOT_SUPPORTED (format/URL — skip ngay). Không có mediaError (null) → coi như lỗi khác (retry giữ nguyên hoặc xử lý theo chuẩn).

**Behavior contract:**
- ABORTED(1) → không retry, không emit ended, không toast (im lặng — đúng chuẩn MDN).
- NETWORK(2) → giữ nguyên retry 3×2s hiện tại + toast network_interrupted.
- DECODE(3)/SRC_NOT_SUPPORTED(4) → bỏ retry, emit error format_error + ended (skip bài) NGAY (thay vì 6s lãng phí).
- mediaError null → hành vi cũ (retry).
- Emit error payload kèm code (kiểm tra PlayerBar dùng code thế nào — i18n đã có sẵn).

- [ ] Step 1: Research MDN MediaError.code (fetch đầy đủ).
- [ ] Step 2: Regression test đỏ (DECODE không retry) → fix → green.
- [ ] Step 3: Lint/tsc + report.

---

### Task C: Pause-save race (bugfix)

**Files:**
- Modify: `src/lib/AudioController.ts` (playTrack thứ tự pause/flip)
- Có thể: `src/hooks/player/usePlayerSession.ts`
- Modify: test liên quan (AudioController.test.ts / usePlayerSession.test.ts)

**Root cause (đã xác nhận):** playTrack: oldAudio.pause() (:317, pause handler đọc audio.getCurrentTime() = element CŨ vẫn active) TRƯỚC khi flip activeIndex (:323); store.currentTrack đã là track MỚI (usePlayer set trước) → session lưu "track mới @ vị trí track cũ".

**Fix phải dựa chuẩn ngành** (subagent research: MDN event order, cách music app lưu session position — save tại thời điểm track thật sự kết thúc/pause với đúng track id; không tự chế). Hướng gợi ý (PHẢI verify bằng research): flip activeIndex trước khi pause element cũ (pause handler có guard `audio === activeAudio` → bỏ qua pause của element cũ → không save sai; nhịp kế từ new track) +/hoặc session save dùng track id gắn với element. Báo cáo deviation nếu chọn cách khác.

**Behavior contract:**
- Không bao giờ lưu "track X @ vị trí track Y".
- Pause thủ công của user vẫn save đúng.
- Restore sau crash/đóng app vẫn đúng vị trí track đang phát.

- [ ] Step 1: Research chuẩn (event order, session-save pattern).
- [ ] Step 2: Regression test đỏ (mô phỏng playTrack: save position phải thuộc track đúng) → fix → green.
- [ ] Step 3: Lint/tsc + report.

---

### Task D: Repeat-all infinite loop guard (bugfix)

**Files:**
- Modify: `src/hooks/player/usePlayerQueue.ts` (handleNextTrack ~74-99)
- Có thể: `src/lib/AudioController.ts` (give-up emit ended — xem có cần signal "track bị skip do lỗi" không)
- Modify: test (usePlayerQueue.test.ts + AudioController.test.ts nếu cần)

**Root cause (đã xác nhận):** error give-up → emit ended → auto-next (handlePlayTrack(next, undefined, true)) → repeat-all quay đầu → cùng bài hỏng lặp vô hạn (mỗi vòng ≥6s).

**Fix theo chuẩn ngành** (research: Spotify/app lớn làm gì khi bài fail — skip tiếp; nếu cả queue fail/loop → dừng phát + thông báo; không tự chế). Gợi ý: guard "track vừa give-up" — set brokenTrackIds trong session; auto-next skip bài broken; nếu toàn bộ queue (độ dài hợp lệ) đều broken → dừng (pause, không lặp). Báo cáo deviation.

**Behavior contract:**
- 1 bài hỏng + queue bình thường → skip tiếp bình thường (như hiện tại, nhưng không lặp lại bài hỏng đó trong vòng lặp).
- Toàn queue hỏng + repeat-all/shuffle → dừng phát, không loop vô hạn.
- Repeat-one: bài hỏng → không lặp vô hạn trên chính nó.

- [ ] Step 1: Research.
- [ ] Step 2: Regression test đỏ → fix → green.
- [ ] Step 3: Lint/tsc + report.

---

## Self-Review
- Spec coverage: 4 gap của dossier đều có task (1-4 tương ứng). Media Session = feature (skill closed-loop-feature-development); B/C/D = bugfix (skill closed-loop-bugfix).
- Research-first: Global Constraints ép mọi task; report phải có mục "Chuẩn ngành vs implementation" và deviation.
- Type consistency: các tên handler dùng lại từ playerStore/usePlayer hiện có (togglePlay/handleNextTrack/handlePrevTrack/seek).
- Rủi ro còn lại: playback core — mọi thay đổi phải qua review nghiêm + verify full suite; Media Session artwork bỏ trống (không có nguồn ảnh hợp lệ — track không có cover URL).
