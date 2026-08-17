import {
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Repeat1,
  RotateCcw,
  RotateCw,
  Shuffle,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { IS_MOBILE } from "../../utils/platform";
import type { Track } from "../../types";

export interface TransportControlsProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  isBuffering: boolean;
  isDownloading: boolean;
  hasError: boolean;
  onRetry: () => void;
  playMode: "normal" | "shuffle" | "repeat-all" | "repeat-one";
  onTogglePlay: () => void;
  onPrevTrack: () => void;
  onNextTrack: (isAutoSkip?: boolean) => void;
  onTogglePlayMode: () => void;
  /** Task 5 mobile: ±5s seek buttons (desktop has none — keyboard ArrowLeft/
   *  Right does this there). */
  onRewind5: () => void;
  onForward5: () => void;
}

export function TransportControls({
  currentTrack,
  isPlaying,
  isBuffering,
  isDownloading,
  hasError,
  onRetry,
  playMode,
  onTogglePlay,
  onPrevTrack,
  onNextTrack,
  onTogglePlayMode,
  onRewind5,
  onForward5,
}: TransportControlsProps) {
  const { t } = useTranslation();

  // Task 9: mobile transport shrinks one notch — 30px side targets (18px
  // icons in p-1.5) and a 34px play button; desktop keeps the 36/40px sizes
  // byte-identical. Material's 48px guideline is for one-handed primary
  // actions; in-bar mini-player transports at ~30-34px are the app norm
  // (Spotify ≈32px, YouTube Music ≈36px) and the user wants smaller.
  const iconClass = IS_MOBILE ? "w-[18px] h-[18px]" : "w-5 h-5";

  const playIcon = () =>
    isDownloading || (isBuffering && isPlaying && !hasError) ? (
      <LoaderCircle
        className={`${iconClass} animate-spin [transform-box:view-box] origin-center`}
      />
    ) : hasError ? (
      <RefreshCw className={iconClass} />
    ) : isPlaying ? (
      <Pause className={iconClass} />
    ) : (
      <Play className={`${iconClass} ml-0.5`} />
    );

  // Task 5 + redesign 2026-08-17: mobile transport = 3 buttons in the exact
  // user-chosen order — (-5s)(play/pause)(+5s). prev/next were removed from
  // the bar (heart also moved into MoreMenu) so the row no longer overflows
  // a 360px phone. The play-mode toggle is intentionally not part of the 3
  // (mobile only; desktop keeps the 4-button layout + playMode byte-identical).
  if (IS_MOBILE) {
    return (
      <div className="flex items-center justify-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onRewind5}
          aria-label={t("player.rewind_5s", "Rewind 5 seconds")}
          className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-1.5 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0"
          disabled={!currentTrack}
        >
          <RotateCcw className="w-[18px] h-[18px]" />
        </button>

        <button
          type="button"
          onClick={hasError ? onRetry : onTogglePlay}
          aria-label={t("player.play_pause", "Play/Pause")}
          className={`w-[34px] h-[34px] shrink-0 flex items-center justify-center text-white rounded-full transition-all duration-200 shadow-md active:scale-90 ${currentTrack ? "bg-brand-primary hover:bg-blue-600 hover:shadow-lg" : "bg-gray-400 cursor-not-allowed"}`}
          disabled={!currentTrack || isDownloading}
        >
          {playIcon()}
        </button>

        <button
          type="button"
          onClick={onForward5}
          aria-label={t("player.forward_5s", "Forward 5 seconds")}
          className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-1.5 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0"
          disabled={!currentTrack}
        >
          <RotateCw className="w-[18px] h-[18px]" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-full mb-1 items-center justify-center gap-3 sm:gap-6">
      <button
        onClick={() => {
          onPrevTrack();
        }}
        className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0"
        disabled={!currentTrack}
      >
        <SkipBack className="w-5 h-5" />
      </button>

      <button
        onClick={hasError ? onRetry : onTogglePlay}
        className={`w-10 h-10 shrink-0 flex items-center justify-center text-white rounded-full transition-all duration-200 shadow-md active:scale-90 ${currentTrack ? "bg-brand-primary hover:bg-blue-600 hover:shadow-lg" : "bg-gray-400 cursor-not-allowed"}`}
        disabled={!currentTrack || isDownloading}
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
        onClick={() => {
          onNextTrack(false);
        }}
        className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0"
        disabled={!currentTrack}
      >
        <SkipForward className="w-5 h-5" />
      </button>

      <div className="relative group flex items-center shrink-0">
        <button
          onClick={onTogglePlayMode}
          className={`p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0 ${playMode !== "normal" ? "text-brand-primary hover:bg-brand-primary/10" : "text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f]"}`}
          disabled={!currentTrack}
        >
          {playMode === "shuffle" && <Shuffle className="w-5 h-5" />}
          {playMode === "repeat-all" && <Repeat className="w-5 h-5" />}
          {playMode === "repeat-one" && <Repeat1 className="w-5 h-5" />}
          {playMode === "normal" && <Repeat className="w-5 h-5 opacity-40" />}
        </button>
      </div>
    </div>
  );
}
