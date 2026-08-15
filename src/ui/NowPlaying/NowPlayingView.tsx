import { memo, useCallback } from "react";
import type { Track } from "../../types";
import { Music, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getPlaybackEngine } from "../../lib/nativeAudioBridge";
import { seekRelative, SEEK_STEP_SECONDS } from "../../hooks/player/utils";
import { useNowPlayingMetadata } from "./hooks/useNowPlayingMetadata";
import { NowPlayingControls } from "./components/NowPlayingControls";
import { SeekBar } from "../components/SeekBar";
import { IS_MOBILE } from "../../utils/platform";

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

  const { coverUrl, setCoverUrl, realTitle, realArtist, bgColor, bgPalette } =
    useNowPlayingMetadata(currentTrack, token);

  // Same shared seek engine as the PlayerBar ±5s buttons and the ArrowLeft/
  // Right keyboard seek (clamp 0..duration, no-op while duration is unloaded).
  // The engine instance is the SeekBar's audio too — one source of truth.
  const audio = getPlaybackEngine();
  const handleRewind5 = useCallback(() => {
    seekRelative(audio, -SEEK_STEP_SECONDS);
  }, [audio]);

  const handleForward5 = useCallback(() => {
    seekRelative(audio, SEEK_STEP_SECONDS);
  }, [audio]);

  if (!currentTrack) {
    return (
      <main className="flex-1 bg-gray-100 dark:bg-[#121212] overflow-hidden flex flex-col items-center justify-center transition-colors duration-300 relative">
        <button
          onClick={onBack}
          className={`absolute left-8 p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95 z-50 ${IS_MOBILE ? "top-[calc(env(safe-area-inset-top)+2rem)]" : "top-8"}`}
        >
          <ChevronDown className="w-6 h-6" />
        </button>
        <div className="w-48 h-48 rounded-2xl bg-gradient-to-br from-brand-primary/10 to-[#34A853]/10 flex items-center justify-center mb-6">
          <Music className="w-24 h-24 text-brand-primary/40 dark:text-[#34A853]/50 drop-shadow-sm" />
        </div>
        <h2 className="text-xl font-bold text-gray-500 dark:text-gray-400">
          {t("player.no_track")}
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
      {/* Back Button — Task: mobile offset below the notch/status bar via
          env(safe-area-inset-top); desktop stays at the old top-6. */}
      <div
        className={`absolute left-6 z-50 ${IS_MOBILE ? "top-[calc(env(safe-area-inset-top)+1.5rem)]" : "top-6"}`}
      >
        <button
          onClick={onBack}
          className="p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95"
        >
          <ChevronDown className="w-6 h-6" />
        </button>
      </div>

      <div className="relative z-10 w-full h-full flex flex-col items-center justify-center p-6 md:p-12 animate-in fade-in zoom-in-95 duration-500 overflow-y-auto">
        {/* Content group: centered vertically when room, scrolls when not.
            The mobile top padding carries the same safe-area offset as the
            back button so the title never overlaps it on notch devices. */}
        <div
          className={`w-full flex flex-col items-center ${IS_MOBILE ? "pt-[calc(env(safe-area-inset-top)+6rem)]" : "pt-24"} md:pt-28 pb-24 md:pb-28`}
        >
          {/* Cover Art Container — Task 12: mobile shows title only; the
              metadata hook is gated there so the container could only ever
              render the placeholder glyph. Desktop untouched. */}
          {!IS_MOBILE && (
            <div className="w-full flex items-center justify-center mt-4 md:mt-8">
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
                    <Music className="w-20 h-20 text-brand-primary/40 drop-shadow-sm" />
                  </>
                )}
              </div>
            </div>
          )}

          <div className="w-full max-w-4xl px-4 shrink-0 mt-6 md:mt-8 pb-8">
            {/* Info */}
            <div className="text-center mb-8">
              <h1
                className={`${IS_MOBILE ? "text-xl" : "text-2xl"} md:text-3xl font-bold text-gray-900 dark:text-white mb-2 truncate tracking-tight`}
              >
                {realTitle}
              </h1>
              {!IS_MOBILE && (
                <p className="text-base md:text-lg font-medium text-gray-500 dark:text-gray-400 truncate">
                  {realArtist || t("unknown_artist")}
                </p>
              )}
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
                onRewind5={handleRewind5}
                onForward5={handleForward5}
              />

              {/* Shared seekbar: single source of truth with PlayerBar. The
                  view never seeks with the global arrow keys (PlayerBar owns
                  that) and gates the 4/s timeupdate subscription on isOpen. */}
              <SeekBar
                currentTrack={currentTrack}
                audio={audio}
                active={isOpen}
                keyboardSeek={false}
              />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
});
