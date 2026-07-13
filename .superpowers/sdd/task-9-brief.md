### Task 9 (🟡 B5): Offline listener chủ động

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` — thêm useEffect mới (sau effect online ở dòng ~1041)

**Problem:** Chỉ có `window.addEventListener('online')`, không có `'offline'` listener chủ động → phải chờ audio error mới biết mất mạng.

**Fix:**
Thêm effect mới lắng nghe sự kiện `offline`. Khi offline và đang play: lưu position + toast + scheduleAutoPause.

**Code chính xác:**

Thêm effect mới sau effect online hiện tại (khoảng dòng ~1037-1041):

```tsx
  // Auto-pause on network offline
  useEffect(() => {
    const handleOffline = () => {
      if (isPlayingRef.current && currentTrackRef.current) {
        errorPositionRef.current = Math.max(0, lastKnownPositionRef.current - 0.5);
        setErrorInfo({ type: 'network_disconnected', text: t('player.network_disconnected', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') });
        scheduleAutoPause();
      }
    };
    window.addEventListener('offline', handleOffline);
    return () => window.removeEventListener('offline', handleOffline);
  }, []);
```

**Yêu cầu:**
1. Đọc file, tìm effect `window.addEventListener('online', ...)` ở khoảng dòng ~1037
2. Thêm effect mới NGAY SAU effect đó (không xen vào bên trong)
3. `npx tsc --noEmit` — không lỗi
4. Commit: "feat: add proactive offline listener for immediate pause"
