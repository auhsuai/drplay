### Task 5 (🟡 C11): handleEnded check playbackStatus

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` — function `handleEnded` (dòng ~718-728)

**Problem:** Audio ended trong lúc `playbackStatus === 'error-needs-manual-resume'` → next track sai ngữ cảnh.

**Fix:**
Thêm guard ở đầu `handleEnded` — nếu playbackStatus đang là `'error-needs-manual-resume'` thì return ngay.

**Code chính xác (dòng ~718-728):**

Hiện tại:
```tsx
  const handleEnded = () => {
    if (playMode === 'repeat-one') {
      const active = getActiveAudio();
      if (active) {
        active.currentTime = 0;
        safePlay(active).catch(e => console.error("Replay failed", e));
      }
    } else {
      handleNextClick();
    }
  };
```

Sửa thành:
```tsx
  const handleEnded = () => {
    if (playbackStatus === 'error-needs-manual-resume') return;
    if (playMode === 'repeat-one') {
      const active = getActiveAudio();
      if (active) {
        active.currentTime = 0;
        safePlay(active).catch(e => console.error("Replay failed", e));
      }
    } else {
      handleNextClick();
    }
  };
```

**Yêu cầu:**
1. Đọc file, tìm `handleEnded`
2. Thêm guard dòng đầu
3. `npx tsc --noEmit` — không lỗi
4. Commit: `fix: guard handleEnded during manual-resume state`
