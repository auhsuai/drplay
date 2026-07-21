import { Track } from "../../App";
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
}

export interface AudioRefs {
  audioRef: React.RefObject<HTMLAudioElement | null>;
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

export const toastTypes: string[] = ['rate_limited', 'drive_quota_exceeded'];
export const bannerTypes: string[] = ['network_disconnected', 'network_interrupted', 'auth_expired', 'format_error'];
export const TOAST_DURATION = 10;
// Delay (s) before a toast auto-dismisses (used by useErrorDisplay).
// Delay (ms) before the toast slide-in transition starts.
export const TOAST_SLIDE_IN_MS = 10;
// Delay (ms) between clearing the visible toast and dispatching CLEAR_ERROR.
export const TOAST_DISMISS_DELAY_MS = 300;
