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
  // Task 9: mobile transport shrinks one notch (30px side targets / 34px play
  // / 18px icons), mirroring the PlayerBar's compact branch; desktop keeps
  // the 36/40px sizes byte-identical.
  const sideBtnClass = IS_MOBILE ? "p-1.5" : "p-2";
  const iconClass = IS_MOBILE ? "w-[18px] h-[18px]" : "w-5 h-5";
  const playBtnClass = IS_MOBILE ? "w-[34px] h-[34px]" : "w-10 h-10";
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
          className={`text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] ${sideBtnClass} rounded-full transition-all active:scale-[0.92]`}
        >
          <SkipBack className={iconClass} />
        </button>

        {IS_MOBILE && (
          <button
            onClick={onRewind5}
            aria-label={t("player.rewind_5s", "Rewind 5 seconds")}
            className={`text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] ${sideBtnClass} rounded-full transition-all active:scale-[0.92]`}
          >
            <RotateCcw className={iconClass} />
          </button>
        )}

        <button
          onClick={onTogglePlay}
          aria-label={t("player.play_pause", "Play/Pause")}
          className={`${playBtnClass} flex items-center justify-center text-white bg-brand-primary hover:bg-blue-600 hover:shadow-lg rounded-full transition-all duration-200 shadow-md active:scale-90`}
        >
          {isPlaying ? (
            <Pause className={iconClass} />
          ) : (
            <Play className={`${iconClass} ml-0.5`} />
          )}
        </button>

        {IS_MOBILE && (
          <button
            onClick={onForward5}
            aria-label={t("player.forward_5s", "Forward 5 seconds")}
            className={`text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] ${sideBtnClass} rounded-full transition-all active:scale-[0.92]`}
          >
            <RotateCw className={iconClass} />
          </button>
        )}

        <button
          onClick={onNextTrack}
          aria-label={t("player.next_track", "Next track")}
          className={`text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] ${sideBtnClass} rounded-full transition-all active:scale-[0.92]`}
        >
          <SkipForward className={iconClass} />
        </button>
      </div>

      {/* Right side controls */}
      <div className="flex-1 flex justify-start">
        <div className="relative group flex items-center">
          <button
            onClick={onTogglePlayMode}
            className={`${sideBtnClass} rounded-full transition-all active:scale-[0.92] ${playMode !== "normal" ? "text-brand-primary hover:bg-brand-primary/10" : "text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f]"}`}
          >
            {playMode === "shuffle" && <Shuffle className={iconClass} />}
            {playMode === "repeat-all" && <Repeat className={iconClass} />}
            {playMode === "repeat-one" && <Repeat1 className={iconClass} />}
            {playMode === "normal" && (
              <Repeat className={`${iconClass} opacity-40`} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
