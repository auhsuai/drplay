import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Repeat1,
  Shuffle,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { IS_MOBILE } from "../../../utils/platform";

interface NowPlayingControlsProps {
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  playMode: "normal" | "shuffle" | "repeat-all" | "repeat-one";
  onTogglePlayMode: () => void;
  /** Mobile-only (Task: ±5s seek): same shared engine path as the PlayerBar
   *  buttons (seekRelative via hooks/player/utils). Desktop ignores them. */
  onRewind5: () => void;
  onForward5: () => void;
}

export function NowPlayingControls({
  isPlaying,
  onTogglePlay,
  onNextTrack,
  onPrevTrack,
  playMode,
  onTogglePlayMode,
  onRewind5,
  onForward5,
}: NowPlayingControlsProps) {
  const { t } = useTranslation();
  return (
    <div className="w-full flex items-center justify-center mb-4">
      {/* Left spacer for perfect centering */}
      <div className="flex-1 flex justify-end"></div>

      {/* Mobile (Task): 5-button transport like PlayerBar — (prev)(-5s)(play)
          (+5s)(next); desktop keeps the 3-button gap-6 px-6 layout untouched. */}
      <div
        className={`flex items-center ${IS_MOBILE ? "gap-2 px-2" : "gap-6 px-6"}`}
      >
        <button
          onClick={onPrevTrack}
          aria-label={t("player.previous_track", "Previous track")}
          className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92]"
        >
          <SkipBack className="w-5 h-5" />
        </button>

        {IS_MOBILE && (
          <button
            onClick={onRewind5}
            aria-label={t("player.rewind_5s", "Rewind 5 seconds")}
            className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92]"
          >
            <RotateCcw className="w-5 h-5" />
          </button>
        )}

        <button
          onClick={onTogglePlay}
          aria-label={t("player.play_pause", "Play/Pause")}
          className="w-10 h-10 flex items-center justify-center text-white bg-brand-primary hover:bg-blue-600 hover:shadow-lg rounded-full transition-all duration-200 shadow-md active:scale-90"
        >
          {isPlaying ? (
            <Pause className="w-5 h-5" />
          ) : (
            <Play className="w-5 h-5 ml-0.5" />
          )}
        </button>

        {IS_MOBILE && (
          <button
            onClick={onForward5}
            aria-label={t("player.forward_5s", "Forward 5 seconds")}
            className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92]"
          >
            <RotateCw className="w-5 h-5" />
          </button>
        )}

        <button
          onClick={onNextTrack}
          aria-label={t("player.next_track", "Next track")}
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
            className={`p-2 rounded-full transition-all active:scale-[0.92] ${playMode !== "normal" ? "text-brand-primary hover:bg-brand-primary/10" : "text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f]"}`}
          >
            {playMode === "shuffle" && <Shuffle className="w-5 h-5" />}
            {playMode === "repeat-all" && <Repeat className="w-5 h-5" />}
            {playMode === "repeat-one" && <Repeat1 className="w-5 h-5" />}
            {playMode === "normal" && <Repeat className="w-5 h-5 opacity-40" />}
          </button>
        </div>
      </div>
    </div>
  );
}
