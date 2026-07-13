# PlayerBar Bug Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 10 confirmed bugs in PlayerBar audio error handling, auto-pause, leak, and edge-case flows.

**Architecture:** Single file (`PlayerBar.tsx`, 1494 dòng). Mỗi task là 1 edit cục bộ, không ảnh hưởng module khác. Test bằng cách build (`npx tsc --noEmit`) + verify flow manual.

**Tech Stack:** React + TypeScript, single component file.

**File:** `src/ui/PlayerBar/PlayerBar.tsx`

---

### Task 1 (🔴 A1): handleCanPlay clear errorInfo + autoPauseTimeout

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx:1100-1115`

**Problem:** handleCanPlay reset retryCount nhưng không clear errorInfo → scheduleAutoPause timer (2s) pause nhạc đã hồi phục.

**Steps:**

- [ ] **Step 1: Thêm clearAutoPauseTimeout + setErrorInfo(null) vào handleCanPlay**

```tsx
// dòng 1100-1115, sửa thành:
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

- [ ] **Step 2: Build check**
```powershell
npx tsc --noEmit
```
Expected: no errors

---

### Task 2 (🔴 C6): resumeHandlerRef cleanup khi đổi track

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx:254-278`

**Problem:** Effect `[currentTrack?.id]` cleanup `resumeSeekRef` nhưng quên `resumeHandlerRef` — handler cũ attach trên audio cũ vẫn có thể fire lên audio mới.

**Steps:**

- [ ] **Step 1: Thêm cleanup resumeHandlerRef**

```tsx
// Trong effect dòng 254-278, thêm sau dòng 260 (resumeSeekRef.current = null;):
      if (resumeHandlerRef.current) {
        resumeHandlerRef.current.audio.removeEventListener('loadedmetadata', resumeHandlerRef.current.handler);
        resumeHandlerRef.current = null;
      }
```

- [ ] **Step 2: Build check**
```powershell
npx tsc --noEmit
```

---

### Task 3 (🟡 C5): onCanPlay NotAllowedError → handleManualResume

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx:630-638`

**Problem:** onCanPlay (dòng 636) catch NotAllowedError chỉ log, không handoff sang handleManualResume → user bị stuck, không play lại được.

**Steps:**

- [ ] **Step 1: Sửa onCanPlay catch để handoff**

```tsx
// dòng 630-639, sửa onCanPlay thành:
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

- [ ] **Step 2: Build check**
```powershell
npx tsc --noEmit
```

---

### Task 4 (🟡 C7): Guard rate-limit trong isPlaying effect

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx:617-653`

**Problem:** User bấm Play khi đang trong window rate-limit (5 phút) → gọi safePlay ngay → 429 tiếp.

**Steps:**

- [ ] **Step 1: Thêm rate-limit guard vào đầu effect isPlaying**

```tsx
// dòng 617, chèn sau dòng 618 (let cancelled = false;):
    if (rateLimitUntilRef.current && Date.now() < rateLimitUntilRef.current) {
      if (!errorInfo || errorInfo.type !== 'rate_limited') {
        setErrorInfo({ type: 'rate_limited', text: t('player.rate_limited', 'Google Drive tạm thời quá tải, đang thử lại...') });
      }
      return;
    }
```

- [ ] **Step 2: Build check**
```powershell
npx tsc --noEmit
```

---

### Task 5 (🟡 C11): handleEnded check playbackStatus

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx:718-728`

**Problem:** Audio ended trong lúc error-needs-manual-resume → next track sai ngữ cảnh.

**Steps:**

- [ ] **Step 1: Thêm guard vào handleEnded**

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

- [ ] **Step 2: Build check**
```powershell
npx tsc --noEmit
```

---

### Task 6 (🟡 C3): Crossfade error handler cho toEl

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx:859-909`

**Problem:** Crossfade mode không có error handler cho toEl. Nếu toEl load thất bại, không fallback về fromEl.

**Steps:**

- [ ] **Step 1: Thêm error handler + fallback logic vào crossfade block**

```tsx
// Sửa khối crossfade (dòng 859-909):
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

        if (toElFailed) {
          toEl.removeEventListener('error', onToElError);
          toEl.removeAttribute('src');
          toEl.load();
          return;
        }

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
        // ... phần còn lại của crossfade
```

- [ ] **Step 2: Build check**
```powershell
npx tsc --noEmit
```

---

### Task 7 (🟡 B3): Circuit breaker cho auto-skip liên tiếp

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` — thêm ref + guard + update callsites

**Problem:** file_deleted/format_error → handleNextClick liên tục, loop toàn playlist.

**Steps:**

- [ ] **Step 1: Thêm ref đếm + constant sau dòng 102**

```tsx
  const consecutiveAutoSkipRef = useRef(0);
  const MAX_CONSECUTIVE_AUTO_SKIP = 3;
```

- [ ] **Step 2: Sửa handleNextClick (dòng 194-199)**

```tsx
  const handleNextClick = (isAutoSkip = false) => {
    if (isAutoSkip) {
      if (isTransitioningRef.current) return;
      isTransitioningRef.current = true;
      consecutiveAutoSkipRef.current += 1;
      if (consecutiveAutoSkipRef.current >= MAX_CONSECUTIVE_AUTO_SKIP) {
        consecutiveAutoSkipRef.current = 0;
        isTransitioningRef.current = false;
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
    setTimeout(() => { isTransitioningRef.current = false; }, 200);
  };
```

- [ ] **Step 3: Update auto-skip callsites**

```tsx
// dòng 791 (file_deleted): handleNextClick(); → handleNextClick(true);
// dòng 810 (format_error): handleNextClick(); → handleNextClick(true);
```

- [ ] **Step 4: Build check**
```powershell
npx tsc --noEmit
```

---

### Task 8 (🟡 B4): Tách debounce auto-skip vs user click

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx:92,194-206`

**Problem:** `isTransitioningRef` dùng chung cho cả user click và auto-skip → 200ms silent swallow.

**Steps:**

- [ ] **Step 1: Thêm ref mới + sửa handleNextClick**

```tsx
// Sau dòng 92 (isTransitioningRef), thêm:
  const isAutoTransitioningRef = useRef(false);

// Sửa handleNextClick thành:
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
    const ms = 200;
    setTimeout(() => {
      if (isAutoSkip) {
        isAutoTransitioningRef.current = false;
      } else {
        isTransitioningRef.current = false;
      }
    }, ms);
  };
```

- [ ] **Step 2: Build check**
```powershell
npx tsc --noEmit
```

---

### Task 9 (🟡 B5): Offline listener chủ động

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` — thêm useEffect sau dòng 1041

**Problem:** Chỉ có online listener, không có offline listener → phải chờ audio error mới biết mất mạng.

**Steps:**

- [ ] **Step 1: Thêm offline listener effect**

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

- [ ] **Step 2: Build check**
```powershell
npx tsc --noEmit
```

---

### Task 10 (🟡 C8): Token refresh thất bại → UI fallback

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx:678-680`

**Problem:** Token refresh fail chỉ console.error, không thông báo user.

**Steps:**

- [ ] **Step 1: Thêm setErrorInfo khi token refresh fail**

```tsx
      } catch (err) {
        console.error('[Player] Refresh token failed', err);
        setErrorInfo({ type: 'network_interrupted', text: t('player.auth_expired', 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại') });
        scheduleAutoPause();
      }
```

- [ ] **Step 2: Build check**
```powershell
npx tsc --noEmit
```
