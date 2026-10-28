import {
  LoaderCircle,
  MoveDiagonal,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BufferedRangePayload, PipActionName } from "../../lib/pipWindow";
import { PipSeekBar } from "../PipSeekBar";
import { PipTimeDisplay } from "../PipTimeDisplay";
import { PipVolumeSlider } from "../PipVolumeSlider";

/** Data that mirrors the published `pip-state` payload. Grouped so the chrome
 *  does not take a dozen flat booleans that all come from one object. */
export interface PipControlsMedia {
  /** Already trimmed and defaulted by the view (`displayTitle`). */
  title: string;
  hasTrack: boolean;
  hasError: boolean;
  hasEnded: boolean;
  isPlaying: boolean;
  isBuffering: boolean;
  isDownloading: boolean;
}

/** Position plumbing: seek bar + the single merged time read-out. */
export interface PipControlsTimeline {
  currentTime: number;
  duration: number;
  buffered: BufferedRangePayload[];
}

export interface PipControlsVolume {
  value: number;
  isMuted: boolean;
}

export interface PipControlsProps {
  compact: boolean;
  controlsVisible: boolean;
  media: PipControlsMedia;
  timeline: PipControlsTimeline;
  volume: PipControlsVolume;
  /** Emits a `pip-action` to main; kept as one callback so the payload contract
   *  (always `{ action, payload }`, even when undefined) lives in one place. */
  onAction: (action: PipActionName, payload?: unknown) => void;
  onSeek: (time: number) => void;
  onVolumeChange: (value: number) => void;
  onToggleMute: () => void;
  /** Pointer enters the top/bottom bar: the auto-hide timer is cancelled. */
  onChromeEnter: () => void;
  /** Pointer leaves the bar: the auto-hide countdown restarts. */
  onChromeLeave: () => void;
}

/**
 * The PiP chrome: transport trio, top bar (title + return/close) and bottom bar
 * (seek/time/volume).
 *
 * Returns the `pip-controls` node ITSELF, with the four children in their
 * original order and no wrapper in between: the scrim, the trio and both bars
 * must stay direct siblings (the transport trio's position is asserted against
 * the bottom bar's parent), and `aria-hidden`/`inert`/the fade live on this one
 * node so the whole overlay hides as a unit.
 */
export function PipControls({
  compact,
  controlsVisible,
  media,
  timeline,
  volume,
  onAction,
  onSeek,
  onVolumeChange,
  onToggleMute,
  onChromeEnter,
  onChromeLeave,
}: PipControlsProps) {
  const { t } = useTranslation();
  const { title, hasTrack, hasError, hasEnded, isPlaying, isBuffering } = media;
  const { isDownloading } = media;
  const { currentTime, duration, buffered } = timeline;
  const { value: volumeLevel, isMuted } = volume;

  // Ported from TransportControls (the fullscreen/PlayerBar icon button): the
  // PiP top bar is the same dark chrome, so its icons use the same idle colour,
  // hover wash, hit box (p-2) and press scale. The old PiP copy used a white
  // 85% icon with a white wash and a h-8 w-8 box, which is why the two windows
  // never looked like one player.
  const iconButtonClass =
    "text-gray-500 hover:text-white hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0";

  // The centre button mirrors TransportControls': the download/buffering
  // window shows a spinner (the engine is waiting), an error turns it into the
  // retry affordance, and a download in flight disables it — exactly the gates
  // the fullscreen transport applies.
  const transportDisabled = !hasTrack || isDownloading;
  const transportClass = `w-11 h-11 shrink-0 flex items-center justify-center text-white rounded-full transition-all duration-200 shadow-md active:scale-90 ${
    hasTrack
      ? "bg-brand-primary hover:bg-blue-600 hover:shadow-lg"
      : "bg-gray-400 cursor-not-allowed"
  }`;
  const transportLabel = hasError
    ? t("player.pip.retry")
    : isPlaying
      ? t("player.pause")
      : t("player.play");

  // The rail is non-seekable when there is no position to seek to or the media
  // can no longer accept a seek — the previous native <input> used exactly this
  // gate, and PipSeekBar feeds it straight into SeekRail's `duration > 0` gate.
  const seekDisabled = duration <= 0 || hasEnded || hasError;

  return (
    <div
      data-testid="pip-controls"
      className={`pointer-events-none absolute inset-0 z-20 ${
        compact ? "transition-none" : "transition-opacity duration-200"
      } ${controlsVisible ? "opacity-100" : "opacity-0"}`}
      aria-hidden={!controlsVisible}
      inert={!controlsVisible}
    >
      {/* Scrim under the chrome. Without it the icons sit directly on the
          picture: white glyphs over a bright frame (a snow scene, a white
          UI, subtitles) lose their contrast and the controls become hard to
          find. It fades with `pip-controls` on the same timer, so a clean
          picture is never dimmed while the user is just watching. */}
      <div
        className="pointer-events-none absolute inset-0 bg-black/45"
        aria-hidden="true"
      />

      {/* The transport trio, centred on the picture. Play/pause is the one
          control a viewer reaches for, and a corner of a video window is the
          least likely place to look for it. Deliberately ABOVE the scrim and
          BELOW the bars: the top and bottom bars come later in DOM order, so they keep
          painting — and receiving clicks — above this overlay. The wrapper
          is pointer-events-none so the empty area around the buttons still
          passes drags through; only the group itself takes input. Living
          inside `pip-controls` is what makes it auto-hide with the chrome. */}
      <div
        data-testid="pip-transport-center"
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <div
          className={`pointer-events-auto flex items-center ${
            // A 44px trio plus 2x32px gaps is comfortable at full size, but
            // the PiP window can be as short as 180px; the narrower gap keeps
            // the group off both bars there without shrinking the hit boxes.
            compact ? "gap-3" : "gap-8"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              onAction("prev");
            }}
            disabled={!hasTrack}
            aria-label={t("player.prev")}
            title={t("player.prev")}
            className={iconButtonClass}
          >
            <SkipBack className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => {
              onAction(hasError ? "retry" : "togglePlay");
            }}
            disabled={transportDisabled}
            aria-label={transportLabel}
            title={transportLabel}
            className={`${transportClass} ${
              // Same 44px box (the test helper and the compact layout both
              // rely on `w-11`), but a scaled-up face so the primary action
              // still reads as the biggest thing on screen.
              compact ? "" : "scale-110"
            }`}
          >
            {/* Same expression as TransportControls: the spinner follows the
                download/buffering signal, an error wins over it, and Pause
                only means "playing" (never "loading"). */}
            {isDownloading || (isBuffering && !hasError) ? (
              <LoaderCircle className="h-6 w-6 animate-spin [transform-box:view-box] origin-center" />
            ) : hasError ? (
              <RefreshCw className="h-6 w-6" />
            ) : isPlaying ? (
              <Pause className="h-6 w-6" />
            ) : (
              <Play className="ml-0.5 h-6 w-6" />
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              onAction("next");
            }}
            disabled={!hasTrack}
            aria-label={t("player.next")}
            title={t("player.next")}
            className={iconButtonClass}
          >
            <SkipForward className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div
        className={`pointer-events-auto absolute inset-x-0 top-0 flex items-center gap-1.5 bg-gradient-to-b px-2 ${
          compact
            ? "from-black/70 via-black/30 to-transparent pb-2 pt-1"
            : "from-black/85 via-black/55 to-transparent pb-4 pt-2"
        } sm:gap-2 sm:px-3`}
        data-tauri-drag-region
        onPointerEnter={onChromeEnter}
        onPointerLeave={onChromeLeave}
      >
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium text-white/90 sm:text-sm"
          data-tauri-drag-region
          title={title}
        >
          {title}
        </span>
        <button
          type="button"
          onClick={() => {
            onAction("return");
          }}
          aria-label={t("player.pip.return_to_player")}
          title={t("player.pip.return_to_player")}
          className={iconButtonClass}
        >
          <MoveDiagonal className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => {
            onAction("closePip");
          }}
          aria-label={t("player.pip.close")}
          title={t("player.pip.close")}
          className={iconButtonClass}
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div
        data-testid="pip-bottom-bar"
        className={`pointer-events-auto absolute inset-x-0 bottom-0 bg-gradient-to-t px-2 ${
          compact
            ? "from-black/70 via-black/35 to-transparent pb-1 pt-1"
            : "from-black/95 via-black/75 to-transparent pb-2 pt-8 sm:pb-3"
        } sm:px-3`}
        onPointerEnter={onChromeEnter}
        onPointerLeave={onChromeLeave}
      >
        {!compact && (
          /* The full-screen seek bar, verbatim: same rail, same hover
             tooltip, same buffer segments. Its clocks are OFF because the
             row below owns the single `current / total` read-out — the
             fullscreen bar splits the same job between VideoTimeDisplay and
             the (hidden) clock spans, so two read-outs here would be one
             too many. */
          <PipSeekBar
            currentTime={currentTime}
            duration={duration}
            buffered={buffered}
            disabled={seekDisabled}
            onSeek={onSeek}
            showClocks={false}
          />
        )}

        <div
          className={`flex flex-nowrap items-center gap-1.5 ${
            compact ? "" : "mt-2 sm:gap-2"
          }`}
        >
          {/* Leading cell, where the fullscreen bar puts its time display:
              the merged read-out stays visible in BOTH layouts, so the
              compact row does not lose the clock along with the seek bar. */}
          <PipTimeDisplay currentTime={currentTime} duration={duration} />

          {compact && (
            <PipSeekBar
              currentTime={currentTime}
              duration={duration}
              buffered={buffered}
              disabled={seekDisabled}
              onSeek={onSeek}
              showClocks={false}
              className="flex-1 min-w-0"
            />
          )}

          <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
            {/* The PlayerBar slider's rail, ported: same track, fill, thumb
                and icon ladder. `hideRail` in compact keeps the mute button
                (the only volume affordance left at that width). */}
            <PipVolumeSlider
              volume={volumeLevel}
              isMuted={isMuted}
              onVolumeChange={onVolumeChange}
              onToggleMute={onToggleMute}
              hideRail={compact}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
