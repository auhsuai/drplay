### Task 4 (🟡 C7): Guard rate-limit trong isPlaying effect

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` — effect `[isPlaying]` (khoảng dòng 617-653)

**Problem:** User bấm Play khi đang trong window rate-limit (5 phút từ lần 429 cuối) → gọi safePlay ngay → ăn 429 tiếp. Cần block early và show toast.

**Fix:**
Thêm guard ở đầu effect [isPlaying], sau `let cancelled = false;`.

**Code chính xác:**

Hiện tại dòng ~617-618:
```tsx
  useEffect(() => {
    let cancelled = false;
    if (isPlaying) {
      clearAutoPauseTimeout();
```

Sửa thành:
```tsx
  useEffect(() => {
    let cancelled = false;
    if (rateLimitUntilRef.current && Date.now() < rateLimitUntilRef.current) {
      if (!errorInfo || errorInfo.type !== 'rate_limited') {
        setErrorInfo({ type: 'rate_limited', text: t('player.rate_limited', 'Google Drive tạm thời quá tải, đang thử lại...') });
      }
      return;
    }
    if (isPlaying) {
      clearAutoPauseTimeout();
```

Chèn block mới sau dòng 618 (`let cancelled = false;`).

**Yêu cầu:**
1. Đọc file hiện tại, tìm effect `[isPlaying]`
2. Thêm rate-limit guard ngay sau `let cancelled = false;`
3. Chạy `npx tsc --noEmit` — không lỗi
4. Commit: `fix: guard play action during rate-limit window`
