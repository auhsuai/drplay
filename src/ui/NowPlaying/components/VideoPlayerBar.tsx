import {
  AudioLines,
  Maximize,
  Minimize,
  MoreVertical,
  Subtitles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AudioController } from "../../../lib/AudioController";
import type { PlayMode, Track } from "../../../types";
import { SeekBar } from "../../components/SeekBar";
import { TransportControls } from "../../PlayerBar/TransportControls";
import { VolumeSlider } from "../../PlayerBar/VolumeSlider";

/** The sections the bar's buttons can open (a subset of the right-click menu). */
export type VideoBarMenuSection =
  "full" | "audio" | "subtitle" | "playback" | "playlist";

export interface VideoPlayerBarProps {
  currentTrack: Track;
  isPlaying: boolean;
  /** mpv's `paused-for-cache` — feeds the transport spinner like PlayerBar. */
  isBuffering: boolean;
  /** The pre-load intent window (track selected, stream not started yet). */
  isDownloading?: boolean;
  /** The current track failed; the center button becomes the retry affordance. */
  hasError: boolean;
  onRetry: () => void;
  playMode: PlayMode;
  onTogglePlay: () => void;
  onNext: () => void;
  onPrev: () => void;
  onTogglePlayMode: () => void;
  audio: AudioController;
  isFullscreen: boolean;
  /** Omitted => no fullscreen affordance is offered (same contract as the view). */
  onToggleFullscreen?: (() => void) | undefined;
  /** Opens the matching native menu section anchored at the clicked button. */
  onOpenMenu?: ((section: VideoBarMenuSection) => void) | undefined;
  /** Gate for the seekbar's 4/s subscription (the Now Playing overlay passes isOpen). */
  active?: boolean;
}

/**
 * D3 media-player bar (spec §15/§34): ONE horizontal row under the video —
 * transport left, title + seekbar center, volume + A/V/More right. It reuses
 * the PlayerBar's own components verbatim (TransportControls / SeekBar /
 * VolumeSlider), so every control behaves exactly as its PlayerBar twin.
 */
export function VideoPlayerBar({
  currentTrack,
  isPlaying,
  isBuffering,
  isDownloading = false,
  hasError,
  onRetry,
  playMode,
  onTogglePlay,
  onNext,
  onPrev,
  onTogglePlayMode,
  audio,
  isFullscreen,
  onToggleFullscreen,
  onOpenMenu,
  active = true,
}: VideoPlayerBarProps) {
  const { t } = useTranslation();

  // Mirrors the back/fullscreen buttons' language in NowPlayingView.
  const iconButtonClass =
    "p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95";

  return (
    <div
      data-testid="video-player-bar"
      className="w-full flex flex-nowrap items-center gap-2 px-3 py-2 bg-white dark:bg-[#202124] border-t border-gray-200 dark:border-[#2A2A2A] shrink-0 z-20"
    >
      <TransportControls
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        isBuffering={isBuffering}
        isDownloading={isDownloading}
        hasError={hasError}
        onRetry={onRetry}
        playMode={playMode}
        onTogglePlay={onTogglePlay}
        onPrevTrack={onPrev}
        onNextTrack={onNext}
        onTogglePlayMode={onTogglePlayMode}
      />

      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span
          data-testid="video-player-bar-title"
          title={currentTrack.title}
          className="hidden md:block truncate max-w-[28ch] shrink-0 text-sm font-medium text-gray-900 dark:text-white"
        >
          {currentTrack.title}
        </span>
        <div className="flex-1 min-w-[120px]">
          <SeekBar currentTrack={currentTrack} audio={audio} active={active} />
        </div>
      </div>

      <div className="shrink-0 flex items-center gap-1">
        {/* Default form of the shared slider: rail from the xl breakpoint up
            (spec §33 — the mute icon stays clickable everywhere). */}
        <VolumeSlider audio={audio} />
        {/* Narrow windows fold audio/subtitle into More (always visible). */}
        <button
          type="button"
          aria-label={t("player.menu.audio_track")}
          onClick={() => {
            onOpenMenu?.("audio");
          }}
          className={`hidden lg:inline-flex ${iconButtonClass}`}
        >
          <AudioLines className="w-5 h-5" />
        </button>
        <button
          type="button"
          aria-label={t("player.menu.subtitle_track")}
          onClick={() => {
            onOpenMenu?.("subtitle");
          }}
          className={`hidden lg:inline-flex ${iconButtonClass}`}
        >
          <Subtitles className="w-5 h-5" />
        </button>
        {onToggleFullscreen !== undefined && (
          <button
            type="button"
            aria-label={
              isFullscreen
                ? t("player.exit_fullscreen")
                : t("player.fullscreen")
            }
            onClick={onToggleFullscreen}
            className={iconButtonClass}
          >
            {isFullscreen ? (
              <Minimize className="w-5 h-5" />
            ) : (
              <Maximize className="w-5 h-5" />
            )}
          </button>
        )}
        <button
          type="button"
          aria-label={t("player.more")}
          onClick={() => {
            onOpenMenu?.("full");
          }}
          className={iconButtonClass}
        >
          <MoreVertical className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
