import type { CSSProperties } from "react";
import type { PlayMode, Track } from "../../types";
import { ChevronDown, Music } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AudioController } from "../../lib/AudioController";
import { retryCurrentTrack } from "../../utils/playerError";
import { NowPlayingControls } from "./components/NowPlayingControls";
import { VideoSurface } from "./components/VideoSurface";
import { VideoPlayerBar } from "./components/VideoPlayerBar";
import { SeekBar } from "../components/SeekBar";
import { VolumeSlider } from "../PlayerBar/VolumeSlider";
import { ErrorToast } from "../PlayerBar/ErrorToast";
import type { MenuSection } from "../../player/menuModel";
import type { VideoMenuAnchor } from "../../player/useVideoMenu";
import type { NowPlayingViewModel } from "./useNowPlayingViewModel";

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

/** Playback data the stage paints but does not own. */
export interface NowPlayingStagePlayback {
  isPlaying: boolean;
  playMode: PlayMode;
  onTogglePlayMode: () => void;
  isOpen: boolean;
}

/** Chrome/fullscreen state owned by App. */
export interface NowPlayingStageChrome {
  isFullscreen: boolean;
  chromeVisible: boolean;
  onToggleFullscreen?: (() => void) | undefined;
  onRevealChrome?: (() => void) | undefined;
  onBack: () => void;
}

/** Video menu entry points (Slice 2). */
export interface NowPlayingStageMenu {
  onOpenPlayerMenu?:
    ((section: MenuSection, anchor: VideoMenuAnchor) => void) | undefined;
  onOpenVideoMenuAt?: ((x: number, y: number) => void) | undefined;
}

interface NowPlayingStageProps {
  vm: NowPlayingViewModel;
  currentTrack: Track;
  playback: NowPlayingStagePlayback;
  chrome: NowPlayingStageChrome;
  menu: NowPlayingStageMenu;
  /** Audio mode keeps the palette paint inline on <main>; video mode moves it
   *  onto the clipped layer, so <main> gets no style then. */
  backgroundStyle: CSSProperties;
  isPipActive: boolean;
}

export function NowPlayingStage({
  vm,
  currentTrack,
  playback,
  chrome,
  menu,
  backgroundStyle,
  isPipActive,
}: NowPlayingStageProps) {
  const { t } = useTranslation();
  const { isPlaying, playMode, onTogglePlayMode, isOpen } = playback;
  const {
    isFullscreen,
    chromeVisible,
    onToggleFullscreen,
    onRevealChrome,
    onBack,
  } = chrome;
  const { onOpenPlayerMenu, onOpenVideoMenuAt } = menu;
  const {
    isVideoTrack,
    showVideoHost,
    hasVideoFrame,
    videoReady,
    isBuffering,
    isEnded,
    isDownloading,
    errorInfo,
    coverUrl,
    setCoverUrl,
    realTitle,
    realArtist,
    handleManualTogglePlay,
    handleManualNext,
    handleManualPrev,
  } = vm;

  return (
    <main
      className="h-full overflow-hidden flex flex-col relative transition-all duration-1000 ease-in-out"
      style={isVideoTrack ? undefined : backgroundStyle}
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
              ? { ...backgroundStyle, clipPath: HOST_HOLE_CLIP_PATH }
              : backgroundStyle
          }
        />
      )}

      {/* Error surface (P2-12-6): the PlayerBar toast is portaled into
          #content-area at z-50, i.e. BEHIND this z-[9999] overlay — the
          full-screen view renders the same banner inline so the error state
          stays visible (and the center button below becomes the retry). */}
      <ErrorToast errorInfo={errorInfo} inline />

      {/* Collapse chevron — BOTH surfaces. In fullscreen it follows
          useFullscreenChrome exactly like the floating bar (opacity +
          pointer-events, never display:none); windowed it is always painted
          and `chromeVisible` is ignored. z-50 keeps it above the z-10 video
          column, and the webview composites ABOVE the mpv visual (the DComp
          video visual composites below the webview), so the native host
          cannot swallow it. */}
      <div
        className={`absolute top-6 left-6 z-50 transition-opacity duration-200 ${
          isFullscreen && !chromeVisible
            ? "opacity-0 pointer-events-none"
            : "opacity-100"
        }`}
      >
        <button
          onClick={onBack}
          aria-label={t("common.close")}
          className="p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95"
        >
          <ChevronDown className="w-6 h-6" />
        </button>
      </div>

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
            className={`flex-1 min-h-0 w-full flex items-center justify-center${
              isPipActive ? " bg-black" : ""
            }`}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // While PiP owns the surface there is no picture in this window,
              // so a video menu anchored here would act on nothing.
              if (isPipActive) return;
              onOpenVideoMenuAt?.(e.clientX, e.clientY);
            }}
          >
            {isPipActive ? (
              /* The picture is in the PiP window; this window only gets a
                 neutral placeholder. No VideoSurface: a second instance would
                 flip the global host-visible class and blank the shell. */
              <p className="max-w-xs px-4 text-center text-[22px] text-white/80">
                {t("player.pip.playing_in_pip")}
              </p>
            ) : (
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
            )}
          </div>
          <VideoPlayerBar
            currentTrack={currentTrack}
            isPlaying={isPlaying}
            isBuffering={isBuffering}
            isDownloading={isDownloading}
            hasError={errorInfo !== null}
            onRetry={retryCurrentTrack}
            onTogglePlay={handleManualTogglePlay}
            onNext={handleManualNext}
            onPrev={handleManualPrev}
            audio={AudioController.getInstance()}
            isFullscreen={isFullscreen}
            onToggleFullscreen={onToggleFullscreen}
            onOpenMenu={onOpenPlayerMenu}
            active={isOpen}
            chromeVisible={chromeVisible}
          />
        </div>
      ) : (
        // No entrance fade/zoom here: the overlay's own slide is the ONLY
        // motion of opening/closing. A content fade on top of it reads as
        // "the panel faded in", hiding the slide (and a scale on a
        // full-height container looks like the whole surface resizing).
        <div className="relative z-10 w-full h-full flex flex-col items-center justify-center p-6 md:p-12 overflow-y-auto">
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
}
