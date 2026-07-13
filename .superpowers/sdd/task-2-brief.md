### Task 2 (🔴 C6): resumeHandlerRef cleanup khi đổi track

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` — effect `[currentTrack?.id]` (khoảng dòng 254-278)

**Problem:** Effect cleanup ở dòng 254 chỉ dọn `resumeSeekRef`, quên `resumeHandlerRef` → handler cũ (đang chờ `loadedmetadata`) vẫn attach, có thể fire nhầm lên audio element đã gán track mới → sai state hoặc sai vị trí seek.

**Fix:**
Thêm cleanup `resumeHandlerRef` ngay sau cleanup `resumeSeekRef` (sau dòng 260).

**Code chính xác:**

Hiện tại trong effect (dòng ~257-260):
```tsx
      if (resumeSeekRef.current) {
        resumeSeekRef.current.audio.removeEventListener('loadedmetadata', resumeSeekRef.current.handler);
        resumeSeekRef.current = null;
      }
```

Thêm sau đó (sau dòng 260):
```tsx
      if (resumeHandlerRef.current) {
        resumeHandlerRef.current.audio.removeEventListener('loadedmetadata', resumeHandlerRef.current.handler);
        resumeHandlerRef.current = null;
      }
```

**Yêu cầu:**
1. Đọc file hiện tại, tìm effect `[currentTrack?.id]` (khoảng dòng 254)
2. Tìm block cleanup `resumeSeekRef`
3. Thêm block cleanup `resumeHandlerRef` tương tự ngay sau đó
4. Chạy `npx tsc --noEmit` — phải không lỗi
5. Commit với message: `fix: cleanup resumeHandlerRef on track change`
