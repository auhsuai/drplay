import { NowPlayingView } from "./NowPlaying/NowPlayingView";
import type { PlayMode, Track } from "../types";
import type { MenuSection } from "../player/menuModel";

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
  isShellLocked: boolean;
  /** Player fullscreen — a refinement of this overlay, never a second surface. */
  isFullscreen?: boolean;
  onToggleFullscreen?: (() => void) | undefined;
  /** Media Information dialog open — the native video host must hide then. */
  isMediaInfoOpen: boolean;
  /** Video playerbar buttons: open one native menu section (D3). */
  onOpenPlayerMenu?: ((section: MenuSection) => void) | undefined;
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
  isShellLocked,
  isFullscreen = false,
  onToggleFullscreen,
  isMediaInfoOpen,
  onOpenPlayerMenu,
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
        isShellLocked={isShellLocked}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
        isMediaInfoOpen={isMediaInfoOpen}
        onOpenPlayerMenu={onOpenPlayerMenu}
      />
    </div>
  );
}
