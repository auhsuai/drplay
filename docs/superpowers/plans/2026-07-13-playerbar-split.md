# PlayerBar Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split 1529-line PlayerBar.tsx into ~8 focused files (<300 lines each) with explicit dependency injection.

**Architecture:** Pure reducer (`playerReducer.ts`) + 6 custom hooks (useAudioEngine, usePlaybackControl, useKeyboard, useTrackMetadata, useErrorDisplay, useProgressUI) + simplified PlayerBar.tsx. Cross-hook communication via typed ref-objects and returned APIs.

**Tech Stack:** React (useRef, useEffect, useReducer, useCallback, useState), TypeScript, CrossfadeEngine, Tauri events, idb-keyval

## Global Constraints
- `npx tsc --noEmit` must pass at every step
- No regressions in functionality
- Keep existing imports and file structure

---

### Task 0: Create types.ts

**Files:**
- Create: `src/ui/PlayerBar/types.ts`
- Modify: (none yet)

**Interfaces:**
- Consumes: `Track` from `../../App`, `CrossfadeEngine` from `../../utils/crossfade`
- Produces: All shared interfaces

**Content:**
```typescript
import { Track } from "../../App";
import { CrossfadeEngine } from "../../utils/crossfade";
import React from "react";

export type PlayerAction =
  | { type: 'PLAY_SUCCESS' }
  | { type: 'ERROR'; error: { type: string; text: string } }
  | { type: 'CLEAR_ERROR' }
  | { type: 'BLOCKED'; time: number | null }
  | { type: 'RESUMED' }
  | { type: 'TRACK_CHANGE' };

export interface PlayerState {
  error: { type: string; text: string } | null;
  manualResume: boolean;
  pendingResumeTime: number | null;
}

export interface PlayerBarProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  isDownloading?: boolean;
  loadNonce?: number;
  playMode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one';
  onTogglePlayMode: () => void;
  onExpandNowPlaying: () => void;
  crossfadeEnabled: boolean;
  crossfadeDuration: number;
}

export interface AudioRefs {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  audioRef2: React.RefObject<HTMLAudioElement | null>;
  activeAudioIndexRef: React.MutableRefObject<0 | 1>;
  crossfadeEngineRef: React.MutableRefObject<CrossfadeEngine | null>;
}

export interface PositionRefs {
  lastKnownPositionRef: React.MutableRefObject<number>;
  errorPositionRef: React.MutableRefObject<number | null>;
  lastSeekTargetRef: React.MutableRefObject<number | null>;
  lastSeekTimestampRef: React.MutableRefObject<number>;
  isSeekCorrectionRef: React.MutableRefObject<boolean>;
  arrowSeekBaseRef: React.MutableRefObject<number | null>;
  isArrowSeekingRef: React.MutableRefObject<boolean>;
  arrowTargetTimeRef: React.MutableRefObject<number>;
  pendingBufferRestoreTimeRef: React.MutableRefObject<number | null>;
  restoredAudioTrackIdRef: React.MutableRefObject<string | null>;
  tauriBufferEndRef: React.MutableRefObject<number | null>;
}

export interface CallbackRefs {
  onTogglePlayRef: React.MutableRefObject<() => void>;
  onNextTrackRef: React.MutableRefObject<() => void>;
  onPrevTrackRef: React.MutableRefObject<() => void>;
  onTogglePlayModeRef: React.MutableRefObject<() => void>;
  onToggleNowPlayingRef: React.MutableRefObject<() => void>;
  handleManualResumeRef: React.MutableRefObject<(() => void) | null>;
  toastDismissRef: React.MutableRefObject<(() => void) | null>;
}

export interface PlaybackRefs {
  isTransitioningRef: React.MutableRefObject<boolean>;
  isAutoTransitioningRef: React.MutableRefObject<boolean>;
  consecutiveAutoSkipRef: React.MutableRefObject<number>;
  isProgrammaticActionRef: React.MutableRefObject<boolean>;
  retryCountRef: React.MutableRefObject<number>;
  retryTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  rateLimitUntilRef: React.MutableRefObject<number>;
}

export const MAX_CONSECUTIVE_AUTO_SKIP = 3;

export const toastTypes = ['rate_limited', 'drive_quota_exceeded'];
export const bannerTypes = ['network_disconnected', 'network_interrupted', 'auth_expired'];
export const TOAST_DURATION = 10;
```

---

### Task 1: Extract playerReducer.ts

**Files:**
- Create: `src/ui/PlayerBar/playerReducer.ts`
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` (import from new file)

**Interfaces:**
- Consumes: `PlayerAction`, `PlayerState` from types.ts
- Produces: `playerReducer`, `initialPlayerState`

---

### Task 2: Extract useAudioEngine.ts

**Files:**
- Create: `src/ui/PlayerBar/useAudioEngine.ts`
- Modify: `src/ui/PlayerBar/PlayerBar.tsx` (import and call hook)

**Content:** Audio engine hook managing:
- audioRef, audioRef2, activeAudioIndexRef, crossfadeEngineRef
- getActiveAudio(), loadNormalAudio(), performRetry(), cleanupResumeHandlers()
- handleEnded, handleAudioError, handleTimeUpdate, handleLoadedMetadata, handleCanPlay
- Crossfade engine init effect, crossfade main effect (loadNonce), volume sync effect
- Refs: resumeHandlerRef, resumeSeekRef, isProgrammaticActionRef, retryCountRef, retryTimeoutRef, rateLimitUntilRef, lastSaveTimeRef, errorPositionRef, lastKnownPositionRef, pendingBufferRestoreTimeRef, restoredAudioTrackIdRef, tauriBufferEndRef
- Internal dispatch calls for PLAY_SUCCESS, BLOCKED, ERROR (rate_limited, file_deleted, format_error, network_disconnected, network_interrupted)
- Uses ErrorIcon from errorDisplay... wait, ErrorIcon is a component.

Let me reconsider. ErrorIcon is used in JSX. It should stay in the error display module or be a separate component.

---

### Task 3: Extract usePlaybackControl.ts

**Files:**
- Create: `src/ui/PlayerBar/usePlaybackControl.ts`

**Content:** Playback control hook managing:
- handleNextClick, handlePrevClick
- Tauri listeners (token-expired, drive-quota)
- handleOnline, handleOffline (event effects)
- handleManualResume
- isPlaying bridge effect (play/pause audio)
- Media Session API effect
- player-stop listener
- Bluetooth devicechange listener  
- Audio focus sync (system pause/play on audio element)
- isPlayingRef, errorInfoRef, handleManualResumeRef syncing

---

### Task 4: Extract useKeyboard.ts

**Files:**
- Create: `src/ui/PlayerBar/useKeyboard.ts`

**Content:** Keyboard hook managing:
- keydown listener with all shortcuts (arrows, volume, m/M, n/N, p/P, s/S, F11, space)
- keyup listener for arrow seeking completion
- triggerVolumeActive, volumeTimeoutRef

---

### Task 5: Extract useTrackMetadata.ts

**Files:**
- Create: `src/ui/PlayerBar/useTrackMetadata.ts`

**Content:** Track metadata hook managing:
- isTrustedStreamUrl, track change effect (metadata fetch, cover, title/artist)
- isLiked, toggleFavorite, favorites listeners
- buffer-status Tauri listener
- Session save (beforeunload + track change)
- coverUrl, realTitle, realArtist states
- lastSaveTimeRef

---

### Task 6: Extract useErrorDisplay.ts

**Files:**
- Create: `src/ui/PlayerBar/useErrorDisplay.ts`

**Content:** Error display hook managing:
- toastIntervalRef, toastTimeoutRef, clearToastTimer, startToastTimer
- dismissToast, toastSlideIn state
- ErrorIcon component (pure function)
- Visibility change effect for toast lifecycle
- clearRetryTimeout cleanup effect for track changes
- dispatch for CLEAR_ERROR

---

### Task 7: Extract useProgressUI.ts

**Files:**
- Create: `src/ui/PlayerBar/useProgressUI.ts`

**Content:** Progress UI hook managing:
- handlePointerDown (progress bar drag)
- handleVolumePointerDown
- updateProgressUI (timeupdate effect)
- Seek correction effect (seeked event)
- duration, isDragging state
- setDuration, setIsDraggingUI, seekTimeoutRef

---

### Task 8: Rewrite PlayerBar.tsx

**Files:**
- Modify: `src/ui/PlayerBar/PlayerBar.tsx`

**Content:** Simplified ~250-line component:
- Import all hooks and types
- Compose hooks in dependency order
- Render JSX (~200 lines)
- Volume state (volume, isMuted, setIsMuted, renderVolumeIcon, toggleMute)
- isVolumeActive state + triggerVolumeActive

```
