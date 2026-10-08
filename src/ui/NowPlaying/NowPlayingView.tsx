import { memo, useCallback, useEffect, useState } from "react";
import type { PlayMode, Track } from "../../types";
import { Music, ChevronDown, Maximize, Minimize } from "lucide-react";
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
import type { MenuSection } from "../../player/menuModel";

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
   * The Media Information dialog is open (owned by App). It is a React surface
   * drawn over the video area, so the native host must hide while it is up —
   * CSS can never cover native child content.
   */
  isMediaInfoOpen: boolean;
  /**
   * Open one native menu section from the video playerbar's buttons (D3).
   * Optional so the view still renders without a menu owner; the bar's menu
   * buttons are a safe no-op then.
   */
  onOpenPlayerMenu?: ((section: MenuSection) => void) | undefined;
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
  isMediaInfoOpen,
  onOpenPlayerMenu,
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
    isMediaInfoOpen,
  });

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
      <main className="flex-1 bg-gray-100 dark:bg-[#121212] overflow-hidden flex flex-col items-center justify-center transition-colors duration-300 relative">
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
  const showFullscreenToggle = isVideoTrack && onToggleFullscreen !== undefined;

  return (
    <main
      className="h-full overflow-hidden flex flex-col relative transition-all duration-1000 ease-in-out"
      style={
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
            }
      }
    >
      {/* Error surface (P2-12-6): the PlayerBar toast is portaled into
          #content-area at z-50, i.e. BEHIND this z-[9999] overlay — the
          full-screen view renders the same banner inline so the error state
          stays visible (and the center button below becomes the retry). */}
      <ErrorToast errorInfo={errorInfo} inline />

      {/* Back Button */}
      <div className="absolute top-6 left-6 z-50">
        <button
          onClick={onBack}
          aria-label={t("common.close")}
          className="p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95"
        >
          <ChevronDown className="w-6 h-6" />
        </button>
      </div>

      {/* Fullscreen toggle (video only). Mirrors the back button's placement,
          styling and icon weight, so the exit affordance reads as part of the
          same surface rather than new chrome. It sits ABOVE the video rect in
          the content flow, so it never overlaps the native host (which cannot
          be covered by CSS). */}
      {showFullscreenToggle && (
        <div className="absolute top-6 right-6 z-50">
          <button
            data-testid="fullscreen-toggle"
            onClick={onToggleFullscreen}
            aria-label={
              isFullscreen
                ? t("player.exit_fullscreen")
                : t("player.fullscreen")
            }
            className="p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95"
          >
            {isFullscreen ? (
              <Minimize className="w-6 h-6" />
            ) : (
              <Maximize className="w-6 h-6" />
            )}
          </button>
        </div>
      )}

      {isVideoTrack ? (
        /* D3 media-player layout (spec §15/§16/§34): the video fills the
           flexible area and ONE horizontal bar with every control sits BELOW
           it. The bar is a sibling AFTER the area in the same column, so the
           native host rect never covers a control — same structural guarantee
           as the old stacked layout. Audio keeps its layout untouched. */
        <div className="relative z-10 flex flex-col h-full w-full pt-14 px-3 pb-2">
          <div className="flex-1 min-h-0 w-full flex items-center justify-center">
            <VideoSurface
              fill
              active={showVideoHost}
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
