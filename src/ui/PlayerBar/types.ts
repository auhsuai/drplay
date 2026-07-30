import { Track } from "../../App";


export type PlayerAction =
  | { type: 'PLAY_SUCCESS' }
  | { type: 'ERROR'; error: { type: string; text: string } }
  | { type: 'CLEAR_ERROR' }
  | { type: 'BLOCKED'; time: number | null }
  | { type: 'RESUMED' }
  | { type: 'TRACK_CHANGE' };

export interface PlayerBarProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: (isAutoSkip?: boolean) => void;
  onPrevTrack: () => void;
  isDownloading?: boolean;
  loadNonce?: number;
  playMode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one';
  onTogglePlayMode: () => void;
  onExpandNowPlaying: () => void;
}

export const toastTypes: string[] = ['rate_limited', 'drive_quota_exceeded'];
export const bannerTypes: string[] = ['network_disconnected', 'network_interrupted', 'auth_expired', 'format_error'];
export const TOAST_DURATION = 10;
// Delay (s) before a toast auto-dismisses (used by useErrorDisplay).
// Delay (ms) before the toast slide-in transition starts.
export const TOAST_SLIDE_IN_MS = 10;
// Delay (ms) between clearing the visible toast and dispatching CLEAR_ERROR.
export const TOAST_DISMISS_DELAY_MS = 300;
