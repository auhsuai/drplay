### Task 3 (🟡 C5): onCanPlay NotAllowedError → handleManualResume

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` — function `onCanPlay` bên trong effect `[isPlaying]` (khoảng dòng 630-638)

**Problem:** Khi audio tự recovery sau error qua effect [isPlaying], `safePlay()` trong `onCanPlay` có thể ném `NotAllowedError`. Hiện tại chỉ log `console.error`, không handoff sang `handleManualResume` → user bị stuck, không play lại được.

**Fix:**
Thay `console.error` bằng set `pendingResumeTime` + `playbackStatus` để handoff sang flow manual resume.

**Code chính xác (dòng ~630-639):**

Hiện tại:
```tsx
          const onCanPlay = () => {
            if (cancelled) return;
            active.removeEventListener('canplay', onCanPlay);
            if (hadErrorPos !== null && hadErrorPos > 0) {
              active.currentTime = hadErrorPos;
            }
            safePlay(active).then(() => { retryCountRef.current = 0; }).catch(e => {
              if (e.name !== 'AbortError') console.error("Playback failed", e);
            });
          };
```

Sửa thành:
```tsx
          const onCanPlay = () => {
            if (cancelled) return;
            active.removeEventListener('canplay', onCanPlay);
            if (hadErrorPos !== null && hadErrorPos > 0) {
              active.currentTime = hadErrorPos;
            }
            safePlay(active).then(() => { retryCountRef.current = 0; }).catch(e => {
              if (e.name === 'NotAllowedError') {
                setPendingResumeTime(active.currentTime);
                setPlaybackStatus('error-needs-manual-resume');
              } else if (e.name !== 'AbortError') {
                console.error("Playback failed", e);
              }
            });
          };
```

**Yêu cầu:**
1. Đọc file hiện tại, tìm `onCanPlay` trong effect `[isPlaying]`
2. Sửa catch block như trên
3. Chạy `npx tsc --noEmit` — phải không lỗi
4. Commit với message: `fix: handoff NotAllowedError to manual resume flow`
