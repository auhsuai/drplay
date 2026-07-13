### Task 1 (🔴 A1): handleCanPlay clear errorInfo + autoPauseTimeout

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` — function `handleCanPlay` (khoảng dòng 1100-1115)

**Problem:** `handleCanPlay` reset `retryCountRef` và gọi `clearRetryTimeout()` nhưng không clear `errorInfo`. Khi retry logic (backoff 1.5s-15s) thành công, audio play lại bình thường, nhưng `errorInfo` vẫn còn và `scheduleAutoPause` timer (2s, set từ lúc lỗi) vẫn còn → sau 2s nó check `isPlayingRef.current && errorInfoRef.current !== null` → **pause nhạc đang phát tốt**.

**Fix:**
- Thêm `clearAutoPauseTimeout()` — hủy timer auto-pause đang pending
- Nếu `errorInfoRef.current` truthy → `setErrorInfo(null)` — clear error vì đã phát lại được

**Code chính xác:**

```tsx
// Sửa hàm handleCanPlay (dòng ~1100-1115) thành:
  const handleCanPlay = () => {
    const audio = getActiveAudio();
    retryCountRef.current = 0;
    clearRetryTimeout();
    clearAutoPauseTimeout();
    if (errorInfoRef.current) {
      setErrorInfo(null);
    }
    if (audio) {
      if (pendingBufferRestoreTimeRef.current !== null) {
        audio.currentTime = pendingBufferRestoreTimeRef.current;
        pendingBufferRestoreTimeRef.current = null;
      }
      if (currentTrack && currentTrack.restoreTime !== undefined && restoredAudioTrackIdRef.current !== currentTrack.id) {
        audio.currentTime = currentTrack.restoreTime;
        restoredAudioTrackIdRef.current = currentTrack.id;
      }
    }
  };
```

**Yêu cầu:**
1. Đọc file hiện tại, tìm hàm `handleCanPlay`
2. Sửa chính xác như code trên
3. Chạy `npx tsc --noEmit` — phải không lỗi
4. Commit với message: `fix: handleCanPlay clears errorInfo and autoPauseTimeout on recovery`
