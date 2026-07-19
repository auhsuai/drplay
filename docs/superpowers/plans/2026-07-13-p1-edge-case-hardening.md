# P1 Edge-Case Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cứng hóa 4 edge case P1 tác động cao: audio-focus (bind cả 2 audio element), crossfade cho track ngắn, seek thả pointer ngoài cửa sổ, và search bỏ dấu tiếng Việt + empty-state.

**Architecture:** Tauri v2 desktop (Windows), React/TS. Phát nhạc Drive qua 2 phần tử `<audio>` với crossfade (Web Audio GainNode). Sửa tại call-site/hook UI, giữ engine thuần. Thêm 1 util thuần `normalizeText` có unit test (vitest, node env).

**Tech Stack:** React, TypeScript, Web Audio API, react-i18next, vitest, Tauri v2.

## Global Constraints

- Platform: Tauri v2 DESKTOP Windows. Bỏ qua mọi case mobile/native.
- `npx tsc --noEmit` phải sạch.
- `cargo check --manifest-path src-tauri\Cargo.toml` phải Finished.
- `npm test` (vitest run) phải pass.
- KHÔNG thêm comment vào code trừ khi cần thiết theo convention hiện có.
- Locale keys phải thêm cho cả `vi` và `en`.
- Ngoài phạm vi: Queue người dùng, playback-speed, sleep-timer, RTL, SMTC setPositionState, Drive-locked, mọi P2/P3.

---

### Task D: Search bỏ dấu tiếng Việt + empty-state

**Files:**
- Create: `src/utils/normalizeText.ts`
- Test: `src/utils/normalizeText.test.ts`
- Modify: `src/ui/MainContent/MainContent.tsx:146-150`, `:224-226`, `:579-582`
- Modify: `src/locales/vi/translation.json`, `src/locales/en/translation.json`

**Interfaces:**
- Produces: `normalizeText(s: string): string` — lowercase, NFD, strip combining marks, `đ→d`.

- [ ] **Step 1: Viết test fail** `src/utils/normalizeText.test.ts` — assert `normalizeText('Nhạc')==='nhac'`, `normalizeText('Đàn')==='dan'`, emoji giữ nguyên.
- [ ] **Step 2: Chạy fail** `npx vitest run src/utils/normalizeText.test.ts` → FAIL (module chưa có).
- [ ] **Step 3: Cài đặt** `normalizeText.ts`: `return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d');`
- [ ] **Step 4: Chạy pass** `npx vitest run src/utils/normalizeText.test.ts` → PASS.
- [ ] **Step 5: Áp dụng vào filter** MainContent `:148-150`: `const query = normalizeText(searchQuery);` và filter `normalizeText(f.name).includes(query)`.
- [ ] **Step 6: Empty-state** Đổi `:579` `items.length === 0` → `filteredItems.length === 0`; khi `searchQuery` truthy hiển thị `t('drive.no_search_results')`, ngược lại `t('drive.no_audio')`.
- [ ] **Step 7: Locale** Thêm `drive.no_search_results` vào vi ("Không tìm thấy bài hát phù hợp.") và en ("No matching songs found.").
- [ ] **Step 8: Verify** `npx tsc --noEmit` sạch.

---

### Task C: Seek thả pointer ngoài cửa sổ

**Files:**
- Modify: `src/ui/PlayerBar/useProgressUI.ts:31-72`
- Modify: `src/ui/NowPlaying/NowPlayingView.tsx:248-269` (và pointerdown tương ứng)

**Interfaces:**
- Consumes: `progressBarRef` (PlayerBar), thanh progress div (NowPlaying).

- [ ] **Step 1:** Trong `handlePointerDown` (cả 2 file): gọi `e.currentTarget.setPointerCapture(e.pointerId)` (guard try/catch).
- [ ] **Step 2:** Thêm handler `onPointerCancel` = commit `finalTime` giống `onPointerUp` (reset dragging + set currentTime).
- [ ] **Step 3:** Đăng ký `pointercancel` trên window cùng lúc với `pointermove`/`pointerup`; cleanup gỡ cả 3.
- [ ] **Step 4:** Verify `npx tsc --noEmit` sạch.

---

### Task B: Crossfade clamp theo độ dài track

**Files:**
- Modify: `src/ui/PlayerBar/useAudioEngine.ts:532-534`

**Interfaces:**
- Consumes: `crossfadeDurationRef.current`, `fromEl`, `toEl`, `engine.crossfade(fromIndex,toIndex,ms)`.

- [ ] **Step 1:** Tính `effectiveFadeMs`: min của `fadeMs`, `toEl.duration*1000` (nếu finite), `max(0,(fromEl.duration-fromEl.currentTime)*1000)` (nếu finite); nếu >0 kẹp sàn 150ms; nếu ≤0 truyền 0 (engine tự instant-switch).
- [ ] **Step 2:** Truyền `effectiveFadeMs` vào `engine.crossfade`.
- [ ] **Step 3:** Verify `npx tsc --noEmit` sạch.

---

### Task A: Audio-focus bind cả 2 audio element

**Files:**
- Modify: `src/ui/PlayerBar/usePlaybackControl.ts:330-354`

**Interfaces:**
- Consumes: `audioRef`, `audioRef2`, `isPlayingRef`, `onTogglePlayRef`, `isProgrammaticActionRef` (nếu có sẵn scope).

- [ ] **Step 1:** Trong effect, gom `[audioRef.current, audioRef2.current].filter(Boolean)`; add `pause`/`play` listener cho từng element; return chỉ khi cả hai null.
- [ ] **Step 2:** Trong `handleSystemPause`/`handleSystemPlay`, bỏ qua nếu hành động là programmatic (kiểm ref hiện có) để tránh vòng lặp toggle khi app tự play lúc crossfade.
- [ ] **Step 3:** Cleanup gỡ listener khỏi cả hai element.
- [ ] **Step 4:** Verify `npx tsc --noEmit` sạch.

---

## Final Verification

- [ ] `npm test` → pass.
- [ ] `npx tsc --noEmit` → sạch.
- [ ] `cargo check --manifest-path src-tauri\Cargo.toml` → Finished.
