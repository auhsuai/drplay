import { NowPlayingView } from "./NowPlaying/NowPlayingView";
import type { Track } from "../types";

interface NowPlayingOverlayProps {
  isOpen: boolean;
  currentTrack: Track | null;
  isPlaying: boolean;
  /** Store download flag — feeds the overlay's load spinner (optional so
   *  existing callers stay valid). */
  isDownloading?: boolean | undefined;
  /** Store load nonce — the track-load key for the spinner arm/clear. */
  loadNonce?: number | undefined;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  playMode: "normal" | "shuffle" | "repeat-all" | "repeat-one";
  onTogglePlayMode: () => void;
  onBack: () => void;
  token: string | null;
}

export function NowPlayingOverlay({
  isOpen,
  currentTrack,
  isPlaying,
  isDownloading,
  loadNonce,
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
      className={`fixed inset-0 z-[9999] bg-white dark:bg-[#121212] flex flex-col transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${
        isOpen ? "translate-y-0" : "translate-y-full pointer-events-none"
      }`}
    >
      <NowPlayingView
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        isDownloading={isDownloading}
        loadNonce={loadNonce}
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
