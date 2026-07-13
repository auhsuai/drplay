### Task 10 (🟡 C8): Token refresh thất bại → UI fallback

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` — `catch` block trong `listen('token-expired', ...)` (khoảng dòng ~678-680)

**Problem:** Token refresh fail chỉ `console.error`, không thông báo user → user không biết phiên đăng nhập hết hạn.

**Fix:**
Thêm `setErrorInfo` + `scheduleAutoPause()` khi refresh token thất bại, để user thấy thông báo và app tự pause.

**Code chính xác:**

Hiện tại (dòng ~678-680):
```tsx
      } catch (err) {
        console.error('[Player] Refresh token failed', err);
      }
```

Sửa thành:
```tsx
      } catch (err) {
        console.error('[Player] Refresh token failed', err);
        setErrorInfo({ type: 'network_interrupted', text: t('player.auth_expired', 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại') });
        scheduleAutoPause();
      }
```

**Yêu cầu:**
1. Đọc file, tìm `listen('token-expired',` (khoảng dòng ~665), tìm catch block
2. Thêm 2 dòng vào catch
3. `npx tsc --noEmit` — không lỗi
4. Commit: "fix: show error toast when token refresh fails"
