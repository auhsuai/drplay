import { memo } from "react";
import type { Track } from "../../App";
import { formatTime } from "../../utils/formatTime";
import { Music, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNowPlayingMetadata } from "./hooks/useNowPlayingMetadata";
import { useNowPlayingProgress } from "./hooks/useNowPlayingProgress";
import { NowPlayingControls } from "./components/NowPlayingControls";

interface NowPlayingViewProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  playMode: "normal" | "shuffle" | "repeat-all" | "repeat-one";
  onTogglePlayMode: () => void;
  onBack: () => void;
  isOpen: boolean;
  token: string | null;
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
}: NowPlayingViewProps) {
  const { t } = useTranslation();

  const { coverUrl, realTitle, realArtist, bgColor, bgPalette } =
    useNowPlayingMetadata(currentTrack, token);
  const {
    duration,
    isDragging,
    progressBarRef,
    progressFillRef,
    bufferFillRef,
    currentTimeTextRef,
    handlePointerDown,
  } = useNowPlayingProgress(currentTrack, isOpen);

  const progressPercent = progressFillRef.current
    ? Math.round(parseFloat(progressFillRef.current.style.width) || 0)
    : 0;

  if (!currentTrack) {
    return (
      <main className="flex-1 bg-gray-100 dark:bg-[#121212] overflow-hidden flex flex-col items-center justify-center transition-colors duration-300 relative">
        <button
          onClick={onBack}
          className="absolute top-8 left-8 p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95 z-50"
        >
          <ChevronDown className="w-6 h-6" />
        </button>
        <div className="w-48 h-48 rounded-2xl bg-gradient-to-br from-[#4285F4]/10 to-[#34A853]/10 flex items-center justify-center mb-6">
          <Music className="w-24 h-24 text-[#4285F4]/40 dark:text-[#34A853]/50 drop-shadow-sm" />
        </div>
        <h2 className="text-xl font-bold text-gray-500 dark:text-gray-400">
          {t("player.no_track", "Chưa có bài hát nào")}
        </h2>
      </main>
    );
  }

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
      {/* Back Button */}
      <div className="absolute top-6 left-6 z-50">
        <button
          onClick={onBack}
          className="p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95"
        >
          <ChevronDown className="w-6 h-6" />
        </button>
      </div>

      <div className="relative z-10 w-full h-full flex flex-col items-center justify-center p-6 md:p-12 animate-in fade-in zoom-in-95 duration-500 overflow-y-auto">
        {/* Content group: centered vertically when room, scrolls when not */}
        <div className="w-full flex flex-col items-center pt-24 md:pt-28 pb-24 md:pb-28">
          {/* Cover Art Container */}
          <div className="w-full flex items-center justify-center mt-4 md:mt-8">
            <div
              className={`w-[min(16rem,60vh)] md:w-[min(20rem,60vh)] lg:w-[min(480px,60vh)] xl:w-[min(560px,60vh)] max-w-full aspect-square h-auto max-h-[min(560px,60vh)] rounded-2xl shadow-[0_12px_30px_rgba(0,0,0,0.15)] dark:shadow-[0_20px_40px_rgba(0,0,0,0.4)] overflow-hidden transition-all duration-700 ${!coverUrl ? "bg-gradient-to-br from-[#4285F4]/10 to-[#34A853]/10 flex items-center justify-center relative" : "bg-gray-100 dark:bg-[#202124]"}`}
            >
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt={t("common.cover_alt", "Cover")}
                  className="w-full h-full object-cover"
                />
              ) : (
                <>
                  <Music className="w-20 h-20 text-[#4285F4]/40 drop-shadow-sm" />
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
                onTogglePlay={onTogglePlay}
                onNextTrack={onNextTrack}
                onPrevTrack={onPrevTrack}
                playMode={playMode}
                onTogglePlayMode={onTogglePlayMode}
              />

              <div className="w-full flex items-center gap-3 mb-2">
                <span
                  ref={currentTimeTextRef}
                  className="text-xs text-gray-500 min-w-[52px] text-right tabular-nums"
                >
                  0:00
                </span>
                <div
                  ref={progressBarRef}
                  role="progressbar"
                  aria-label={t("now_playing.progress", "Playback progress")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressPercent}
                  className="flex-1 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer group relative flex items-center"
                  onPointerDown={handlePointerDown}
                >
                  <div
                    ref={bufferFillRef}
                    data-testid="buffer-fill"
                    className="absolute inset-0 overflow-hidden rounded-full pointer-events-none"
                  ></div>

                  <div
                    ref={progressFillRef}
                    className={`absolute left-0 h-full bg-[#4285F4] rounded-full flex items-center transform-gpu will-change-[width] ${isDragging ? "" : "transition-all duration-150"}`}
                  >
                    <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 bg-white rounded-full shadow shrink-0"></div>
                  </div>
                </div>
                <span className="text-xs text-gray-500 min-w-[52px] tabular-nums">
                  {formatTime(duration)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
});
