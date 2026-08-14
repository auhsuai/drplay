import {
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
} from "lucide-react";
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
}: TransportControlsProps) {
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
