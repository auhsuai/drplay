import { NowPlayingView } from "./NowPlaying/NowPlayingView";
import type { PlayMode, Track } from "../types";

interface NowPlayingOverlayProps {
  isOpen: boolean;
  currentTrack: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  playMode: PlayMode;
  onTogglePlayMode: () => void;
  onBack: () => void;
  token: string | null;
}

export function NowPlayingOverlay({
  isOpen,
  currentTrack,
  isPlaying,
  onTogglePlay,
  onNextTrack,
  onPrevTrack,
  playMode,
  onTogglePlayMode,
  onBack,
  token,
}: NowPlayingOverlayProps) {
  return (
    <div
      aria-hidden={!isOpen}
      inert={!isOpen}
      className={`fixed inset-0 z-[9999] bg-white dark:bg-[#121212] flex flex-col transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${
        isOpen ? "translate-y-0" : "translate-y-full pointer-events-none"
      }`}
    >
      <NowPlayingView
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        onTogglePlay={onTogglePlay}
        onNextTrack={onNextTrack}
        onPrevTrack={onPrevTrack}
        playMode={playMode}
        onTogglePlayMode={onTogglePlayMode}
        onBack={onBack}
        isOpen={isOpen}
        token={token}
      />
    </div>
  );
}
