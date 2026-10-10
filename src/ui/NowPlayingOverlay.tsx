import { NowPlayingView } from "./NowPlaying/NowPlayingView";
import type { PlayMode, Track } from "../types";
import type { MenuSection } from "../player/menuModel";
import type { VideoMenuAnchor } from "../player/useVideoMenu";

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
  /** Video playerbar More button: open the DrPlay video menu (Slice 2). */
  onOpenPlayerMenu?:
    ((section: MenuSection, anchor: VideoMenuAnchor) => void) | undefined;
  /** Right-click on the video area opens the same menu at the pointer. */
  onOpenVideoMenuAt?: ((x: number, y: number) => void) | undefined;
  /** Fullscreen chrome visibility, owned by App's useFullscreenChrome. */
  chromeVisible?: boolean | undefined;
  /** Player activity inside the video area reveals the chrome. */
  onRevealChrome?: (() => void) | undefined;
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
  onOpenPlayerMenu,
  onOpenVideoMenuAt,
  chromeVisible,
  onRevealChrome,
}: NowPlayingOverlayProps) {
  return (
    // drplay-host-clear (S4): redundant while NowPlayingView paints (it
    // always covers this shell), but must not paint over the host rect —
    // App.css drops it while the video host is visible.
    //
    // The collapse/expand is ONE property: `translate`. Tailwind v4's
    // `transition-transform` would expand to `transform, translate, scale,
    // rotate`, and `transition-all` would take the geometry too — neither is
    // needed for a slide, and animating anything else at the same time is what
    // makes the video look like it is being resized under the page. 200ms is
    // inside the 180-250ms target, and `motion-reduce` drops the motion
    // entirely for users who asked for that.
    <div
      aria-hidden={!isOpen}
      inert={!isOpen}
      className={`drplay-host-clear fixed inset-0 z-[9999] bg-white dark:bg-[#121212] flex flex-col transition-[translate] duration-200 ease-out motion-reduce:transition-none ${
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
        onOpenPlayerMenu={onOpenPlayerMenu}
        onOpenVideoMenuAt={onOpenVideoMenuAt}
        chromeVisible={chromeVisible}
        onRevealChrome={onRevealChrome}
      />
    </div>
  );
}
