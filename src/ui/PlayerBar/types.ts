import type { Track, PlayMode } from "../../types";

export interface PlayerBarProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: (isAutoSkip?: boolean) => void;
  onPrevTrack: () => void;
  isDownloading?: boolean;
  loadNonce?: number;
  playMode: "normal" | "shuffle" | "repeat-all" | "repeat-one";
  onTogglePlayMode: () => void;
  onExpandNowPlaying: () => void;
  onSetPlayMode: (mode: PlayMode) => void;
  onSelectTrack: (track: Track) => void;
}
