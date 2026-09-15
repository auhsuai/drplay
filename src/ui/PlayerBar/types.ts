import type { PlayMode, Track } from "../../types";

export interface PlayerBarProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: (isAutoSkip?: boolean) => void;
  onPrevTrack: () => void;
  isDownloading?: boolean;
  loadNonce?: number;
  playMode: PlayMode;
  onTogglePlayMode: () => void;
  onExpandNowPlaying: () => void;
  onSelectTrack: (track: Track) => void;
  isQueueOpen: boolean;
  onToggleQueue: () => void;
}
