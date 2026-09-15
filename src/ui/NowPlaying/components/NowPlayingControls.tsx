import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Repeat1,
  Shuffle,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PlayMode } from "../../../types";

interface NowPlayingControlsProps {
  isPlaying: boolean;
  isBuffering: boolean;
  // Same intent window as TransportControls: true between a track-selection
  // click and the actual loadfile — the button must show the spinner and
  // reject re-clicks instead of flashing ▲/⏸.
  isDownloading: boolean;
  // Same error/retry contract as TransportControls (parity): hasError turns
  // the center button into the RefreshCw retry affordance and gates the
  // buffering spinner off, so the full-screen surface cannot silently drop
  // the error the PlayerBar shows.
  hasError: boolean;
  onRetry: () => void;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  playMode: PlayMode;
  onTogglePlayMode: () => void;
}

export function NowPlayingControls({
  isPlaying,
  isBuffering,
  isDownloading,
  hasError,
  onRetry,
  onTogglePlay,
  onNextTrack,
  onPrevTrack,
  playMode,
  onTogglePlayMode,
}: NowPlayingControlsProps) {
  const { t } = useTranslation();

  return (
    <div className="w-full flex items-center justify-center mb-4">
      {/* Left spacer for perfect centering */}
      <div className="flex-1 flex justify-end"></div>

      <div className="flex items-center gap-6 px-6">
        <button
          onClick={onPrevTrack}
          aria-label={t("player.prev")}
          className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92]"
        >
          <SkipBack className="w-5 h-5" />
        </button>

        <button
          onClick={hasError ? onRetry : onTogglePlay}
          disabled={isDownloading}
          aria-label={isPlaying ? t("player.pause") : t("player.play")}
          className="w-10 h-10 flex items-center justify-center text-white bg-brand-primary hover:bg-blue-600 hover:shadow-lg rounded-full transition-all duration-200 shadow-md active:scale-90"
        >
          {isDownloading || (isBuffering && isPlaying && !hasError) ? (
            <LoaderCircle className="w-5 h-5 animate-spin [transform-box:view-box] origin-center" />
          ) : hasError ? (
            <RefreshCw className="w-5 h-5" />
          ) : isPlaying ? (
            <Pause className="w-5 h-5" />
          ) : (
            <Play className="w-5 h-5 ml-0.5" />
          )}
        </button>

        <button
          onClick={onNextTrack}
          aria-label={t("player.next")}
          className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92]"
        >
          <SkipForward className="w-5 h-5" />
        </button>
      </div>

      {/* Right side controls */}
      <div className="flex-1 flex justify-start">
        <div className="relative group flex items-center">
          <button
            onClick={onTogglePlayMode}
            aria-label={t("player.play_mode")}
            className={`p-2 rounded-full transition-all active:scale-[0.92] ${playMode !== "normal" ? "text-brand-text hover:bg-brand-primary/10" : "text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f]"}`}
          >
            {playMode === "shuffle" && <Shuffle className="w-5 h-5" />}
            {playMode === "repeat-all" && <Repeat className="w-5 h-5" />}
            {playMode === "repeat-one" && <Repeat1 className="w-5 h-5" />}
            {playMode === "normal" && <Repeat className="w-5 h-5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
