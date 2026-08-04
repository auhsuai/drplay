import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Repeat1,
  Shuffle,
} from "lucide-react";

interface NowPlayingControlsProps {
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  playMode: "normal" | "shuffle" | "repeat-all" | "repeat-one";
  onTogglePlayMode: () => void;
}

export function NowPlayingControls({
  isPlaying,
  onTogglePlay,
  onNextTrack,
  onPrevTrack,
  playMode,
  onTogglePlayMode,
}: NowPlayingControlsProps) {
  return (
    <div className="w-full flex items-center justify-center mb-4">
      {/* Left spacer for perfect centering */}
      <div className="flex-1 flex justify-end"></div>

      <div className="flex items-center gap-6 px-6">
        <button
          onClick={onPrevTrack}
          className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92]"
        >
          <SkipBack className="w-5 h-5" />
        </button>

        <button
          onClick={onTogglePlay}
          className="w-10 h-10 flex items-center justify-center text-white bg-[#4285F4] hover:bg-blue-600 hover:shadow-lg rounded-full transition-all duration-200 shadow-md active:scale-90"
        >
          {isPlaying ? (
            <Pause className="w-5 h-5" />
          ) : (
            <Play className="w-5 h-5 ml-0.5" />
          )}
        </button>

        <button
          onClick={onNextTrack}
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
            className={`p-2 rounded-full transition-all active:scale-[0.92] ${playMode !== "normal" ? "text-[#4285F4] hover:bg-[#4285F4]/10" : "text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f]"}`}
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
