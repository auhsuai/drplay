### Task 6 (🟡 C3): Crossfade error handler cho toEl

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` — crossfade block (dòng ~859-909)

**Problem:** Crossfade mode không có error handler cho toEl (target element). Nếu toEl load thất bại (stream error), crossfade vẫn tiếp tục, fromEl bị pause/xóa src → mất âm thanh hoàn toàn.

**Fix:**
Thêm error handler + fallback: nếu toEl lỗi, hủy crossfade (không pause fromEl, không xóa src fromEl), và return.

**Code chính xác:**

Hiện tại (dòng ~859-909):
```tsx
      if (shouldCrossfade) {
        const fromIndex = activeAudioIndexRef.current;
        const toIndex = (fromIndex === 0 ? 1 : 0) as 0 | 1;
        const fromEl = fromIndex === 0 ? audio : audio2;
        const toEl = toIndex === 0 ? audio : audio2;

        isProgrammaticActionRef.current = true;
        toEl.src = currentTrack.streamUrl;
        toEl.load();
        setTimeout(() => { isProgrammaticActionRef.current = false; }, 50);

        if (cancelled) return;

        await new Promise<void>(resolve => {
          const handler = () => {
            toEl.removeEventListener('canplay', handler);
            resolve();
          };
          toEl.addEventListener('canplay', handler);
        });
        // ... phần còn lại của crossfade
```

Sửa thành:
```tsx
      if (shouldCrossfade) {
        const fromIndex = activeAudioIndexRef.current;
        const toIndex = (fromIndex === 0 ? 1 : 0) as 0 | 1;
        const fromEl = fromIndex === 0 ? audio : audio2;
        const toEl = toIndex === 0 ? audio : audio2;

        isProgrammaticActionRef.current = true;
        toEl.src = currentTrack.streamUrl;
        let toElFailed = false;
        const onToElError = () => {
          if (toElFailed) return;
          toElFailed = true;
          toEl.removeEventListener('error', onToElError);
          console.warn('[Player] Crossfade target error, keeping current track');
          setTimeout(() => { isProgrammaticActionRef.current = false; }, 50);
        };
        toEl.addEventListener('error', onToElError);
        toEl.load();
        setTimeout(() => { isProgrammaticActionRef.current = false; }, 50);

        if (cancelled) return;

        await new Promise<void>(resolve => {
          const handler = () => {
            toEl.removeEventListener('canplay', handler);
            toEl.removeEventListener('error', onToElError);
            resolve();
          };
          toEl.addEventListener('canplay', handler);
          toEl.addEventListener('error', () => {
            toEl.removeEventListener('canplay', handler);
            onToElError();
            resolve();
          });
        });

        if (cancelled || toElFailed) return;
        // ... phần còn lại của crossfade giữ nguyên
```

**Lưu ý:** Phần code sau `if (cancelled || toElFailed) return;` ở cuối (phần còn lại của crossfade: crossfade engine, safePlay, fade, cleanup) giữ NGUYÊN như hiện tại.

**Yêu cầu:**
1. Đọc file, tìm crossfade block (khoảng dòng ~859-909)
2. Sửa theo code trên, giữ nguyên phần code còn lại sau đó
3. `npx tsc --noEmit` — không lỗi
4. Commit: `fix: add crossfade target error handler with fromEl fallback`
