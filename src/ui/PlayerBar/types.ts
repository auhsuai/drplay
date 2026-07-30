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
  playbackQueue: Track[];
  onPlayTrack: (track: Track) => void;
  onRemoveTrack: (trackId: string) => void;
  onReorderQueue: (fromIndex: number, toIndex: number) => void;
}

export interface CallbackRefs {
  onTogglePlayRef: React.MutableRefObject<() => void>;
  onNextTrackRef: React.MutableRefObject<() => void>;
  onPrevTrackRef: React.MutableRefObject<() => void>;
  onTogglePlayModeRef: React.MutableRefObject<() => void>;
  handleManualResumeRef: React.MutableRefObject<(() => void) | null>;
}

export const MAX_CONSECUTIVE_AUTO_SKIP = 3;

export const toastTypes: string[] = ['rate_limited', 'download_quota'];
export const bannerTypes: string[] = ['network_disconnected', 'network_interrupted', 'auth_expired', 'format_error'];
export const TOAST_DURATION = 10;
// Delay (s) before a toast auto-dismisses (used by useErrorDisplay).
// Delay (ms) before the toast slide-in transition starts.
export const TOAST_SLIDE_IN_MS = 10;
// Delay (ms) between clearing the visible toast and dispatching CLEAR_ERROR.
export const TOAST_DISMISS_DELAY_MS = 300;
