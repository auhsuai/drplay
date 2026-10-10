import type { CSSProperties } from "react";
import type { PlayMode, Track } from "../../types";
import { ChevronDown, Music } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";

import { useTranslation } from "react-i18next";
import { AudioController } from "../../lib/AudioController";
import { isForeignTrackEvent } from "../../lib/audioNativeEvents";
import { usePlayerStore } from "../../store/playerStore";
import { resetAdvanceGuard, retryCurrentTrack } from "../../utils/playerError";
import { useNowPlayingMetadata } from "./hooks/useNowPlayingMetadata";
import { NowPlayingControls } from "./components/NowPlayingControls";
import { VideoSurface } from "./components/VideoSurface";
import { VideoPlayerBar } from "./components/VideoPlayerBar";
import { SeekBar } from "../components/SeekBar";
import { VolumeSlider } from "../PlayerBar/VolumeSlider";
import { ErrorToast } from "../PlayerBar/ErrorToast";
import { classifyMediaKind, MEDIA_KIND_VIDEO } from "../../utils/mediaKind";
import { shouldShowVideoHost } from "../../lib/videoHost";
import { useVideoFirstFrame } from "../../player/useVideoFirstFrame";
import type { MenuSection } from "../../player/menuModel";
import type { VideoMenuAnchor } from "../../player/useVideoMenu";

/**
 * S4: clips the player background layer to everything EXCEPT the native host
 * rect. The rect arrives as CSS custom properties published by VideoSurface
 * (CSS px, relative to <main>); while unset they resolve to a 0-size hole at
 * the corner — no hole — which keeps the layer fully opaque until the first
 * measurement. `evenodd` turns the inner rectangle into a hole; the syntax is
 * Baseline CSS (MDN: available across browsers since January 2020) and
 * WebView2 is Chromium.
 */
const HOST_HOLE_CLIP_PATH =
  "polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, " +
  "var(--drplay-hole-l, 0px) var(--drplay-hole-t, 0px), " +
  "var(--drplay-hole-r, 0px) var(--drplay-hole-t, 0px), " +
  "var(--drplay-hole-r, 0px) var(--drplay-hole-b, 0px), " +
  "var(--drplay-hole-l, 0px) var(--drplay-hole-b, 0px))";

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
}: NowPlayingViewProps) {
  const { t } = useTranslation();

  // Same store source PlayerBar's transport row resolves isDownloading from
  // (playerStore.isDownloading, set by usePlayer.handlePlayTrack) — it covers
  // the "preparing to play" intent window (token fetch → stream URL →
  // loadfile) where the buffering event has not fired yet.
  const isDownloading = usePlayerStore((state) => state.isDownloading);

  // Shared error surface (P2-12-6): PlayerBar publishes the error + storm
  // banner here, and the full-screen view renders the same banner inline +
  // the retry affordance — without duplicating the audio error subscription
  // or the storm guard (those stay single-owner in PlayerBar/playerError).
  const errorInfo = usePlayerStore((state) => state.errorInfo);

  // Media kind of the loaded track (same derivation mpvAudio.loadTrack uses for
  // the `video` property). A video track replaces the cover-art square with the
  // VideoSurface; an audio track is untouched by anything in this slice.
  const isVideoTrack =
    currentTrack !== null &&
    classifyMediaKind(currentTrack.originalName ?? currentTrack.title) ===
      MEDIA_KIND_VIDEO;

  // Ended (F5): mpv's `end-file` already reaches the app as the `ended` engine
  // event (mpvProtocol -> mpvAudio -> AudioController.on("ended")) — the very
  // same event that drives auto-advance in usePlayerPlaybackPolicy. The surface
  // listens to it here rather than inventing a second subscription, so a
  // finished video stops showing a live-looking surface (frozen last frame)
  // while the queue advances. Cleared on the next track, because the store's
  // currentTrack changing means playback restarted.
  const [isEnded, setIsEnded] = useState(false);
  useEffect(() => {
    const audio = AudioController.getInstance();
    return audio.on("ended", (identity) => {
      if (
        isForeignTrackEvent(
          identity,
          usePlayerStore.getState().currentTrack?.id,
        )
      ) {
        return;
      }
      setIsEnded(true);
    });
  }, []);

  const currentTrackId = currentTrack?.id;
  useEffect(() => {
    setIsEnded(false);
  }, [currentTrackId]);

  const showVideoHost = shouldShowVideoHost({
    hasTrack: currentTrack !== null,
    isVideo: isVideoTrack,
    isOpen,
    isShellLocked,
    hasError: errorInfo !== null,
    hasEnded: isEnded,
  });

  // Has the render thread presented a frame of THIS media item yet? Host
  // visibility cannot answer that — it flips when a track is SELECTED, which is
  // long before mpv has anything to show — and until a frame exists the video
  // rect must stay opaque, because the whole page is deliberately transparent
  // while the host is visible (App.css `html.drplay-host-visible`).
  const hasVideoFrame = useVideoFirstFrame(currentTrackId ?? null);
  const videoReady = showVideoHost && hasVideoFrame;

  const { coverUrl, setCoverUrl, realTitle, realArtist, bgColor, bgPalette } =
    useNowPlayingMetadata(currentTrack, token);

  // Buffering state for the play-button spinner — same source/condition
  // as PlayerBar (audio "buffering" event + isPlaying). R2.1: identity guard
  // like PlayerBar — a stale track's buffering event must not spin this view.
  const [isBuffering, setIsBuffering] = useState(false);
  useEffect(() => {
    const audio = AudioController.getInstance();
    return audio.on("buffering", ({ isBuffering: buffering, ...identity }) => {
      if (
        isForeignTrackEvent(
          identity,
          usePlayerStore.getState().currentTrack?.id,
        )
      ) {
        return;
      }
      setIsBuffering(buffering);
    });
  }, []);

  // F7-7 parity: the full-screen transport buttons are manual transport
  // actions, exactly like PlayerBar's (which reset the shared storm guard in
  // its own wrappers). Wrap locally and hand the wrapped versions down —
  // retryCurrentTrack already resets the guard it shares.
  const handleManualTogglePlay = useCallback(() => {
    resetAdvanceGuard();
    onTogglePlay();
  }, [onTogglePlay]);

  const handleManualNext = useCallback(() => {
    resetAdvanceGuard();
    onNextTrack();
  }, [onNextTrack]);

  const handleManualPrev = useCallback(() => {
    resetAdvanceGuard();
    onPrevTrack();
  }, [onPrevTrack]);

  if (!currentTrack) {
    return (
      // No media at all is still "no usable frame", so this surface is solid
      // opaque black: an empty player must not let anything show through the
      // composition transparency.
      <main className="flex-1 bg-black overflow-hidden flex flex-col items-center justify-center relative">
        <button
          onClick={onBack}
          aria-label={t("common.close")}
          className="absolute top-8 left-8 p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95 z-50"
        >
          <ChevronDown className="w-6 h-6" />
        </button>
        <div className="w-48 h-48 rounded-2xl bg-gradient-to-br from-brand-primary/10 to-[#34A853]/10 flex items-center justify-center mb-6">
          <Music className="w-24 h-24 text-brand-text/40 dark:text-[#34A853]/50 drop-shadow-sm" />
        </div>
        <h2 className="text-xl font-bold text-gray-500 dark:text-gray-400">
          {t("player.no_track")}
        </h2>
      </main>
    );
  }

  // Fullscreen is offered for the VIDEO surface only: it exists to give the
  // video the window's space. Enlarging the audio cover-art square is not the
  // same affordance and is not asked for, so the toggle stays hidden there.
  // The header copy of that toggle is gone (user decision): the floating bar
  // carries its own, and `f` / Escape exist.

  // The header chevron survives AUDIO only. The video surface has no header
  // chrome at all — the bar's controls plus Escape / `f` are the way out, and
  // that is asserted by tests, not by a comment.
  const showBackButton = !isVideoTrack;

  // S4: the player background. VIDEO mode moves it off <main> onto the
  // dedicated layer below, which clips the native host rect out while the
  // host is visible — the DComp video visual composites BELOW the webview
  // (VIDEO-RENDER-ARCHITECTURE-ADR), so nothing in the page may paint over
  // that rect. AUDIO mode keeps the paint inline on <main> exactly as before.
  const playerBackgroundStyle: CSSProperties =
    bgPalette.length === 4
      ? {
          background: `
          linear-gradient(to bottom, transparent 65%, var(--player-bg-fade) 100%),
          radial-gradient(circle at 0% 0%, ${bgPalette[0] ?? ""} 0%, transparent 75%),
          radial-gradient(circle at 100% 0%, ${bgPalette[1] ?? ""} 0%, transparent 75%),
          radial-gradient(circle at 0% 100%, ${bgPalette[2] ?? ""} 0%, transparent 75%),
          radial-gradient(circle at 100% 100%, ${bgPalette[3] ?? ""} 0%, transparent 75%),
          var(--player-bg-solid)
        `,
        }
      : {
          background: bgColor
            ? `linear-gradient(to bottom, ${bgColor} 0%, var(--player-bg-solid) 100%)`
            : "var(--player-bg-solid)",
        };

  return (
    <main
      className="h-full overflow-hidden flex flex-col relative transition-all duration-1000 ease-in-out"
      style={isVideoTrack ? undefined : playerBackgroundStyle}
    >
      {/* S4: video-mode background layer — same paint the audio branch keeps
          on <main>; while the host is visible it punches the host rect hole
          (evenodd polygon) with the CSS variables VideoSurface publishes.
          z-0 keeps it behind the z-10 video column and the z-50 controls. */}
      {isVideoTrack && (
        <div
          aria-hidden="true"
          data-testid="drplay-player-bg"
          className="absolute inset-0 z-0 pointer-events-none"
          style={
            videoReady
              ? { ...playerBackgroundStyle, clipPath: HOST_HOLE_CLIP_PATH }
              : playerBackgroundStyle
          }
        />
      )}

      {/* Error surface (P2-12-6): the PlayerBar toast is portaled into
          #content-area at z-50, i.e. BEHIND this z-[9999] overlay — the
          full-screen view renders the same banner inline so the error state
          stays visible (and the center button below becomes the retry). */}
      <ErrorToast errorInfo={errorInfo} inline />

      {/* Back Button — AUDIO only (see `showBackButton`). The video surface
          has no header chrome. */}
      {showBackButton && (
        <div className="absolute top-6 left-6 z-50">
          <button
            onClick={onBack}
            aria-label={t("common.close")}
            className="p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95"
          >
            <ChevronDown className="w-6 h-6" />
          </button>
        </div>
      )}

      {isVideoTrack ? (
        /* D3 media-player layout (spec §15/§16/§34): the video fills the
           flexible area and ONE horizontal bar with every control sits BELOW
           it. The bar is a sibling AFTER the area in the same column, so the
           native host rect never covers a control — same structural guarantee
           as the old stacked layout. Audio keeps its layout untouched.

           The column carries NO padding in either mode: the old `pt-14 px-3
           pb-2` band only reserved space for the removed video header, so both
           windowed and fullscreen give the whole content area to the video
           viewport and align the bar with the player bounds. mpv letterboxes
           the picture itself, so the aspect ratio is never stretched. */
        <div
          className="relative z-10 flex flex-col h-full w-full"
          // Activity seam (Slice 1/C): pointer movement or a click anywhere in
          // the player area reveals the fullscreen chrome. The listener lives
          // in useFullscreenChrome and is attached ONLY while fullscreen; this
          // is just the React-side forwarding. It is on the COLUMN (not on the
          // bar) so movement over the picture counts, and so the bar keeps
          // itself visible while the pointer is on it.
          onPointerMove={onRevealChrome}
          onPointerDown={onRevealChrome}
        >
          {/* Right-click (Slice 2): React owns pointer input over the video
              rect now — the legacy HWND host that used to emit
              `video-context-menu` does not exist under the in-process libmpv
              renderer, so the native popup was dead code. preventDefault is
              required even though useAppGlobalEvents blocks the document-wide
              browser menu: this handler must own the anchor AND stop a native
              menu from being requested at all. It is on the VIDEO AREA only,
              so the bar and the audio layout are untouched. */}
          <div
            data-testid="video-area"
            className="flex-1 min-h-0 w-full flex items-center justify-center"
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenVideoMenuAt?.(e.clientX, e.clientY);
            }}
          >
            <VideoSurface
              fill
              active={showVideoHost}
              hasFirstFrame={hasVideoFrame}
              fullscreen={isFullscreen}
              isPlaying={isPlaying}
              isBuffering={isBuffering}
              isDownloading={isDownloading}
              hasError={errorInfo !== null}
              isEnded={isEnded}
            />
          </div>
          <VideoPlayerBar
            currentTrack={currentTrack}
            isPlaying={isPlaying}
            isBuffering={isBuffering}
            isDownloading={isDownloading}
            hasError={errorInfo !== null}
            onRetry={retryCurrentTrack}
            playMode={playMode}
            onTogglePlay={handleManualTogglePlay}
            onNext={handleManualNext}
            onPrev={handleManualPrev}
            onTogglePlayMode={onTogglePlayMode}
            audio={AudioController.getInstance()}
            isFullscreen={isFullscreen}
            onToggleFullscreen={onToggleFullscreen}
            onOpenMenu={onOpenPlayerMenu}
            active={isOpen}
            chromeVisible={chromeVisible}
          />
        </div>
      ) : (
        <div className="relative z-10 w-full h-full flex flex-col items-center justify-center p-6 md:p-12 animate-in fade-in zoom-in-95 duration-500 overflow-y-auto">
          {/* Content group: centered vertically when room, scrolls when not. */}
          <div
            className={`w-full flex flex-col items-center ${
              isFullscreen
                ? "h-full pt-14 pb-4"
                : "pt-24 md:pt-28 pb-24 md:pb-28"
            }`}
          >
            {/* Player area. An AUDIO track keeps the cover-art square exactly as
              before; video tracks are rendered by the D3 branch above. This
              slot is the FIRST thing in the centered content group and
              everything below it (info, controls, seekbar) stays structurally
              outside any native rect. */}
            <div
              className={`w-full flex items-center justify-center mt-4 md:mt-8 ${
                isFullscreen ? "flex-1 min-h-0" : ""
              }`}
            >
              <div
                className={`w-[min(16rem,60vh)] md:w-[min(20rem,60vh)] lg:w-[min(480px,60vh)] xl:w-[min(560px,60vh)] max-w-full aspect-square h-auto max-h-[min(560px,60vh)] rounded-2xl shadow-[0_12px_30px_rgba(0,0,0,0.15)] dark:shadow-[0_20px_40px_rgba(0,0,0,0.4)] overflow-hidden transition-all duration-700 ${!coverUrl ? "bg-gradient-to-br from-brand-primary/10 to-[#34A853]/10 flex items-center justify-center relative" : "bg-gray-100 dark:bg-[#202124]"}`}
              >
                {coverUrl ? (
                  <img
                    src={coverUrl}
                    alt={t("common.cover_alt")}
                    decoding="async"
                    // Single always-visible image: no lazy loading needed (it is
                    // the LCP candidate). A drplay:// miss (204 NoCover) or a
                    // decode error falls back to the Music icon — no broken img.
                    onError={() => {
                      setCoverUrl(null);
                    }}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <>
                    <Music className="w-20 h-20 text-brand-text/40 drop-shadow-sm" />
                  </>
                )}
              </div>
            </div>

            <div className="w-full max-w-4xl px-4 shrink-0 mt-6 md:mt-8 pb-8">
              {/* Info */}
              <div className="text-center mb-8">
                <h1 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-white mb-2 truncate tracking-tight">
                  {realTitle}
                </h1>
                <p className="text-base md:text-lg font-medium text-gray-500 dark:text-gray-400 truncate">
                  {realArtist || t("unknown_artist")}
                </p>
              </div>

              {/* PlayerBar Clone Controls */}
              <div className="w-full flex flex-col items-center justify-center max-w-[800px] mx-auto">
                <NowPlayingControls
                  isPlaying={isPlaying}
                  isBuffering={isBuffering}
                  isDownloading={isDownloading}
                  hasError={errorInfo !== null}
                  onRetry={retryCurrentTrack}
                  onTogglePlay={handleManualTogglePlay}
                  onNextTrack={handleManualNext}
                  onPrevTrack={handleManualPrev}
                  playMode={playMode}
                  onTogglePlayMode={onTogglePlayMode}
                />

                {/* Shared seekbar: single source of truth with PlayerBar. Seek
                  keys live in the single player command registry (App), which
                  drives this instance's timeupdate subscription; the view
                  gates its 4/s timeupdate subscription on isOpen. */}
                <SeekBar
                  currentTrack={currentTrack}
                  audio={AudioController.getInstance()}
                  active={isOpen}
                />

                {/* Volume (F3): the PlayerBar collapses to h-0 while this
                  overlay is open, so there was NO way to change volume during
                  full-screen playback (its buttons measured at y=1076 in a
                  1057px-tall viewport — off-screen). This is the SAME
                  VolumeSlider the PlayerBar renders, not a second control:
                  same engine facade, same drag/mute/key handling, and
                  `alwaysShowRail` because the PlayerBar hides its rail below
                  `xl`, a breakpoint a 1024x768 window never reaches. */}
                <div className="flex justify-center mt-4">
                  <VolumeSlider
                    audio={AudioController.getInstance()}
                    alwaysShowRail
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
});
