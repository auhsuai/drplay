### Task 7+8 (🟡 B3+B4): Circuit breaker + tách debounce auto-skip

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` — thêm refs + sửa `handleNextClick` + update callsites

**Problem B3:** file_deleted/format_error → handleNextClick liên tục, loop toàn playlist. Không có circuit breaker.

**Problem B4:** `isTransitioningRef` dùng chung cho cả user click và auto-skip → 200ms silent swallow khi auto-skip vừa fire.

**Fix chung:**
1. Thêm `consecutiveAutoSkipRef` và `isAutoTransitioningRef`
2. Sửa `handleNextClick` để nhận param `isAutoSkip`, xử lý riêng
3. Update 2 callsites tự động (file_deleted, format_error)

**Code chính xác:**

**Bước 1:** Thêm 2 ref sau dòng 92 (`const isTransitioningRef = useRef(false);`):
```tsx
  const isAutoTransitioningRef = useRef(false);
  const consecutiveAutoSkipRef = useRef(0);
  const MAX_CONSECUTIVE_AUTO_SKIP = 3;
```

**Bước 2:** Sửa hàm `handleNextClick` và `handlePrevClick` (dòng ~194-206):

Hiện tại handleNextClick:
```tsx
  const handleNextClick = () => {
    if (isTransitioningRef.current) return;
    isTransitioningRef.current = true;
    onNextTrack();
    setTimeout(() => { isTransitioningRef.current = false; }, 200);
  };
```

Sửa thành:
```tsx
  const handleNextClick = (isAutoSkip = false) => {
    if (isAutoSkip) {
      if (isAutoTransitioningRef.current) return;
      isAutoTransitioningRef.current = true;
      consecutiveAutoSkipRef.current += 1;
      if (consecutiveAutoSkipRef.current >= MAX_CONSECUTIVE_AUTO_SKIP) {
        consecutiveAutoSkipRef.current = 0;
        isAutoTransitioningRef.current = false;
        setErrorInfo({ type: 'network_interrupted', text: t('player.playlist_error', 'Nhiều bài liên tiếp bị lỗi, đã dừng phát') });
        scheduleAutoPause();
        return;
      }
    } else {
      consecutiveAutoSkipRef.current = 0;
      if (isTransitioningRef.current) return;
      isTransitioningRef.current = true;
    }
    onNextTrack();
    setTimeout(() => {
      if (isAutoSkip) {
        isAutoTransitioningRef.current = false;
      } else {
        isTransitioningRef.current = false;
      }
    }, 200);
  };
```

**Bước 3:** Update callsites tự động (2 chỗ):

Dòng ~791 (file_deleted): `handleNextClick();` → `handleNextClick(true);`
Dòng ~810 (format_error): `handleNextClick();` → `handleNextClick(true);`

**Yêu cầu:**
1. Đọc file, tìm `isTransitioningRef` (dòng ~92)
2. Thêm 3 dòng ref/constant ngay sau đó
3. Sửa `handleNextClick` hoàn toàn
4. Update 2 callsites `handleNextClick(true);`
5. `npx tsc --noEmit` — không lỗi
6. Commit: "fix: add auto-skip circuit breaker and separate debounce"
