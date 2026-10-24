import {
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Track } from "../../types";

export interface TransportControlsProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  isBuffering: boolean;
  isDownloading: boolean;
  hasError: boolean;
  onRetry: () => void;
  onTogglePlay: () => void;
  onPrevTrack: () => void;
  onNextTrack: (isAutoSkip?: boolean) => void;
  /** Rendered in the left cell before Prev (the video bar's time display). */
  leading?: React.ReactNode;
  /** Rendered in the right cell after Next (the PlayerBar's play-mode button). */
  trailing?: React.ReactNode;
}

export function TransportControls({
  currentTrack,
  isPlaying,
  isBuffering,
  isDownloading,
  hasError,
  onRetry,
  onTogglePlay,
  onPrevTrack,
  onNextTrack,
  leading,
  trailing,
}: TransportControlsProps) {
  const { t } = useTranslation();

  return (
    // 3-cell grid. The optional `trailing` slot (regular PlayerBar) turns the
    // side cells into EQUAL 1fr tracks: Play is the middle (auto) cell, so it
    // sits at the exact center of this box — which itself is the centered auto
    // column of PlayerBar's own 1fr/auto/1fr grid. Without `trailing` (video
    // bar) the tracks are `auto`, keeping its left-anchored transport tight.
    <div
      className={`grid ${
        trailing ? "grid-cols-[1fr_auto_1fr]" : "grid-cols-[auto_auto_auto]"
      } items-center mb-1 gap-x-3 sm:gap-x-6`}
    >
      <div className="flex items-center justify-end gap-3 sm:gap-6">
        {leading}
        {/* A right-side trailing control would widen the right 1fr cell and
            shift Play off the bar's centre. This invisible spacer mirrors the
            mode button's box (p-2 + w-6 icon = 40px = w-10) so both 1fr cells
            measure the same and Play stays dead centre. Non-interactive, not
            in the a11y tree. */}
        {trailing && !leading ? (
          <div aria-hidden="true" className="w-10 h-10 shrink-0" />
        ) : null}

        <button
          onClick={() => {
            onPrevTrack();
          }}
          aria-label={t("player.prev")}
          className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0"
          disabled={!currentTrack}
        >
          <SkipBack className="w-6 h-6" />
        </button>
      </div>

      <button
        onClick={hasError ? onRetry : onTogglePlay}
        aria-label={isPlaying ? t("player.pause") : t("player.play")}
        className={`w-11 h-11 shrink-0 flex items-center justify-center text-white rounded-full transition-all duration-200 shadow-md active:scale-90 ${currentTrack ? "bg-brand-primary hover:bg-blue-600 hover:shadow-lg" : "bg-gray-400 cursor-not-allowed"}`}
        disabled={!currentTrack || isDownloading}
      >
        {/* Same expression as the full-screen transport (NowPlayingControls):
            the spinner follows the ENGINE's signal — the single source of
            truth for "the engine is waiting" (its startup loader is up for
            the whole load window, until the playback chain is confirmed). The
            engine never raises it while the user paused, so a paused track
            shows the Pause icon, never a spinner. */}
        {isDownloading || (isBuffering && !hasError) ? (
          <LoaderCircle className="w-6 h-6 animate-spin [transform-box:view-box] origin-center" />
        ) : hasError ? (
          <RefreshCw className="w-6 h-6" />
        ) : isPlaying ? (
          <Pause className="w-6 h-6" />
        ) : (
          <Play className="w-6 h-6 ml-0.5" />
        )}
      </button>

      <div className="flex items-center justify-start gap-3 sm:gap-6">
        <button
          onClick={() => {
            onNextTrack(false);
          }}
          aria-label={t("player.next")}
          className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0"
          disabled={!currentTrack}
        >
          <SkipForward className="w-6 h-6" />
        </button>
        {trailing}
      </div>
    </div>
  );
}
