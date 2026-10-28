import type { CSSProperties } from "react";
import type { PlayMode, Track } from "../../types";
import { memo } from "react";

import type { MenuSection } from "../../player/menuModel";
import type { VideoMenuAnchor } from "../../player/useVideoMenu";
import { NowPlayingEmptyState } from "./NowPlayingEmptyState";
import { NowPlayingStage } from "./NowPlayingStage";
import { useNowPlayingViewModel } from "./useNowPlayingViewModel";

interface NowPlayingViewProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  playMode: PlayMode;
  onTogglePlayMode: () => void;
  onBack: () => void;
  isOpen: boolean;
  token: string | null;
  /** A full-screen modal covers the shell (login / folder selection). The
   *  native video host must hide then: CSS cannot blur or clip native child
   *  content, so the host would punch an unblurred hole through the modal. */
  isShellLocked: boolean;
  /**
   * Player fullscreen. A REFINEMENT of this overlay, not a second surface: it
   * is only ever true while `isOpen` (App opens the overlay when entering it),
   * and it never changes what `shouldShowVideoHost` decides. Owned by App so
   * the Escape handler (useNowPlayingShortcuts) can peel one layer at a time.
   */
  isFullscreen?: boolean;
  /** Enter/leave fullscreen. Omitted => no toggle is offered.
   *  Spelled `| undefined` rather than `?:` so a caller that has no handler
   *  can pass `undefined` through under exactOptionalPropertyTypes. */
  onToggleFullscreen?: (() => void) | undefined;
  /**
   * Open the DrPlay video menu (Slice 2) for `section`. The bar's More button
   * passes the measured trigger anchor; the video area's right-click passes a
   * pointer anchor through `onOpenVideoMenuAt`. Both reach the SAME renderer
   * and the SAME menuModel tree — the anchor is the only difference.
   * Optional so the view still renders without a menu owner; the bar's menu
   * button is a safe no-op then.
   */
  onOpenPlayerMenu?:
    ((section: MenuSection, anchor: VideoMenuAnchor) => void) | undefined;
  /**
   * Right-click on the video area opens the same menu at the pointer. Optional
   * (the audio surface has no menu at all).
   */
  onOpenVideoMenuAt?: ((x: number, y: number) => void) | undefined;
  /**
   * Should the floating fullscreen bar be painted? Owned by
   * useFullscreenChrome in App and threaded down unchanged; omitted (or false)
   * outside fullscreen has no effect on the windowed layout, which is a plain
   * in-flow row that is always visible.
   */
  chromeVisible?: boolean | undefined;
  /**
   * Player activity inside the video area (Slice 1/C): pointer movement or a
   * click. Optional so the view renders without the chrome owner (the bar
   * simply never auto-hides then).
   */
  onRevealChrome?: (() => void) | undefined;
  /**
   * The PiP window currently OWNS the native video surface. This window then
   * has nothing to measure or show: the picture lives in another window, and
   * mounting a second `VideoSurface` here would toggle the global
   * `html.drplay-host-visible` class (that component has no owner guard on the
   * root class), which App.css turns into "hide the sidebar and the content
   * area" — the shell would ghost out behind an overlay that is only a
   * placeholder. So the view paints a black panel instead of the surface and
   * never punches the host hole in its background layer.
   */
  isPipActive?: boolean;
}

export const NowPlayingView = memo(function NowPlayingView({
  currentTrack,
  isPlaying,
  onTogglePlay,
  onNextTrack,
  onPrevTrack,
  playMode,
  onTogglePlayMode,
  onBack,
  isOpen,
  token,
  isShellLocked,
  isFullscreen = false,
  onToggleFullscreen,
  onOpenPlayerMenu,
  onOpenVideoMenuAt,
  chromeVisible = true,
  onRevealChrome,
  isPipActive = false,
}: NowPlayingViewProps) {
  const vm = useNowPlayingViewModel({
    currentTrack,
    token,
    isOpen,
    isShellLocked,
    isPipActive,
    onTogglePlay,
    onNextTrack,
    onPrevTrack,
  });

  if (!currentTrack) {
    return <NowPlayingEmptyState onBack={onBack} />;
  }

  // Fullscreen is offered for the VIDEO surface only: it exists to give the
  // video the window's space. Enlarging the audio cover-art square is not the
  // same affordance and is not asked for, so the toggle stays hidden there.
  // The header copy of that toggle is gone (user decision): the floating bar
  // carries its own, and `f` / Escape exist.

  // S4: the player background. VIDEO mode moves it off <main> onto the
  // dedicated layer inside NowPlayingStage, which clips the native host rect
  // out while the host is visible — the DComp video visual composites BELOW the
  // webview (VIDEO-RENDER-ARCHITECTURE-ADR), so nothing in the page may paint
  // over that rect. AUDIO mode keeps the paint inline on <main> exactly as
  // before.
  const playerBackgroundStyle: CSSProperties =
    vm.bgPalette.length === 4
      ? {
          background: `
          linear-gradient(to bottom, transparent 65%, var(--player-bg-fade) 100%),
          radial-gradient(circle at 0% 0%, ${vm.bgPalette[0] ?? ""} 0%, transparent 75%),
          radial-gradient(circle at 100% 0%, ${vm.bgPalette[1] ?? ""} 0%, transparent 75%),
          radial-gradient(circle at 0% 100%, ${vm.bgPalette[2] ?? ""} 0%, transparent 75%),
          radial-gradient(circle at 100% 100%, ${vm.bgPalette[3] ?? ""} 0%, transparent 75%),
          var(--player-bg-solid)
        `,
        }
      : {
          background: vm.bgColor
            ? `linear-gradient(to bottom, ${vm.bgColor} 0%, var(--player-bg-solid) 100%)`
            : "var(--player-bg-solid)",
        };

  return (
    <NowPlayingStage
      vm={vm}
      currentTrack={currentTrack}
      playback={{
        isPlaying,
        playMode,
        onTogglePlayMode,
        isOpen,
      }}
      chrome={{
        isFullscreen,
        chromeVisible,
        onToggleFullscreen,
        onRevealChrome,
        onBack,
      }}
      menu={{
        onOpenPlayerMenu,
        onOpenVideoMenuAt,
      }}
      backgroundStyle={playerBackgroundStyle}
      isPipActive={isPipActive}
    />
  );
});
