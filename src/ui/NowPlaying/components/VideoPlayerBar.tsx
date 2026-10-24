import { Maximize, Minimize, MoreVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AudioController } from "../../../lib/AudioController";
import type { Track } from "../../../types";
import { SeekBar } from "../../components/SeekBar";
import { TransportControls } from "../../PlayerBar/TransportControls";
import { VolumeSlider } from "../../PlayerBar/VolumeSlider";
import type { VideoMenuAnchor } from "../../../player/useVideoMenu";
import { VideoTimeDisplay } from "./VideoTimeDisplay";

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
  onTogglePlay: () => void;
  onNext: () => void;
  onPrev: () => void;
  audio: AudioController;
  isFullscreen: boolean;
  /** Omitted => no fullscreen affordance is offered (same contract as the view). */
  onToggleFullscreen?: (() => void) | undefined;
  /**
   * Opens the DrPlay video menu (Slice 2) for `section`, anchored at the button
   * that asked for it. The bar measures its own trigger so the owner does not
   * have to reach into this component, and the anchor travels with the call —
   * that is the only difference from the right-click path.
   */
  onOpenMenu?:
    | ((section: VideoBarMenuSection, anchor: VideoMenuAnchor) => void)
    | undefined;
  /** Gate for the seekbar's 4/s subscription (the Now Playing overlay passes isOpen). */
  active?: boolean;
  /**
   * Should the controls be painted? Owned by useFullscreenChrome (App) and
   * threaded down; ignored outside fullscreen, where the bar is a layout row
   * that is always visible. Defaults to true so a caller without the hook
   * renders exactly the pre-fullscreen bar.
   */
  chromeVisible?: boolean | undefined;
}

/**
 * D3 media-player bar (spec §15/§34): ONE horizontal row under the video —
 * transport left, title + seekbar center, volume + fullscreen/More right. It
 * reuses the PlayerBar's own components verbatim (TransportControls /
 * SeekBar / VolumeSlider), so every control behaves exactly as its PlayerBar
 * twin.
 *
 * Slice 1 (B/D): in fullscreen the row leaves the layout flow and floats over
 * the bottom of the video (absolute + inset-x-0 + bottom-0), so showing or
 * hiding it can never resize or reposition the surface — the native host's
 * measured rect stays identical across every reveal. Outside fullscreen the
 * class set is byte-identical to the pre-fullscreen bar.
 */
export function VideoPlayerBar({
  currentTrack,
  isPlaying,
  isBuffering,
  isDownloading = false,
  hasError,
  onRetry,
  onTogglePlay,
  onNext,
  onPrev,
  audio,
  isFullscreen,
  onToggleFullscreen,
  onOpenMenu,
  active = true,
  chromeVisible = true,
}: VideoPlayerBarProps) {
  const { t } = useTranslation();

  // Mirrors the back/fullscreen buttons' language in NowPlayingView.
  const iconButtonClass =
    "p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95";

  // Two DISJOINT class sets, chosen — never concatenated. Every mode gets
  // exactly ONE opacity decision and ONE background decision: putting
  // `opacity-100` in a shared base and appending a conditional `opacity-0`
  // (or stacking `bg-white`/`bg-black/60`) leaves the winner to CSS source
  // order in the generated stylesheet, not to the class string, so the fade
  // could never be relied on (measured live: hidden fullscreen still computed
  // opacity: 1).
  //
  // Fullscreen: out of flow (nothing to reserve), painted with the SAME palette
  // as the windowed bar on purpose (one control bar, one colour) — so it stays
  // exactly ONE background and ONE border utility, like every other mode.
  // `pointer-events-none` while hidden means the bar never swallows a click on
  // the picture behind it — and there is no invisible click-blocker, because
  // the element itself stops receiving events. Opacity (not visibility/display)
  // is what allows a smooth fade back with zero geometry change.
  const barClass = isFullscreen
    ? `w-full flex flex-nowrap items-center gap-2 px-3 py-2 absolute inset-x-0 bottom-0 z-30 border-t border-gray-200 dark:border-[#2A2A2A] bg-white dark:bg-[#202124] transition-opacity duration-200 ${
        chromeVisible ? "opacity-100" : "opacity-0 pointer-events-none"
      }`
    : "w-full flex flex-nowrap items-center gap-2 px-3 py-2 shrink-0 z-20 relative bg-white dark:bg-[#202124] border-t border-gray-200 dark:border-[#2A2A2A] opacity-100";

  return (
    <div data-testid="video-player-bar" className={barClass}>
      <TransportControls
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        isBuffering={isBuffering}
        isDownloading={isDownloading}
        hasError={hasError}
        onRetry={onRetry}
        onTogglePlay={onTogglePlay}
        onPrevTrack={onPrev}
        onNextTrack={onNext}
        leading={
          <VideoTimeDisplay
            currentTrack={currentTrack}
            audio={audio}
            active={active}
          />
        }
      />

      <div className="flex-1 min-w-0 flex items-center justify-center">
        <span
          data-testid="video-player-bar-title"
          title={currentTrack.title}
          className="hidden md:block w-full min-w-0 max-w-[45vw] xl:max-w-[560px] truncate text-center text-sm font-medium text-gray-900 dark:text-white"
        >
          {currentTrack.title}
        </span>
      </div>

      {/* The PlayerBar's seekbar, verbatim: `variant="top"` pins the rail to
          this bar's top edge, edge-to-edge and square — the same line the
          collapsed PlayerBar shows — instead of the old in-flow bar between two
          clocks. The bar root is the positioned ancestor it resolves against
          (`relative` windowed, `absolute` fullscreen). A direct child, not a
          wrapper: in this variant the rail is out of flow, so a wrapper div
          would only reserve empty width between the title and the controls. */}
      <SeekBar
        currentTrack={currentTrack}
        audio={audio}
        active={active}
        variant="top"
      />

      <div className="shrink-0 flex items-center gap-1">
        {/* Default form of the shared slider: rail from the xl breakpoint up
            (spec §33 — the mute icon stays clickable everywhere). */}
        <VolumeSlider audio={audio} />
        {/* Slice 1 (D): the standalone Audio/Subtitle buttons are gone. Both
            are reachable from the native menu — More's "full" section and the
            right-click submenus — so they were duplicate entry points, and
            they were the only two controls on this bar that opened a menu
            without carrying a player action of their own. No replacement
            button: More stays the one menu affordance. */}
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
        {/* The ONE menu affordance on this bar. Slice 2 made it open the same
            DrPlay menu the video area's right-click opens; the anchor is the
            measured trigger rect, so the owner needs no knowledge of this
            component's DOM. */}
        <button
          type="button"
          aria-label={t("player.more")}
          onClick={(e) => {
            onOpenMenu?.("full", {
              kind: "button",
              rect: e.currentTarget.getBoundingClientRect(),
              trigger: e.currentTarget,
            });
          }}
          className={iconButtonClass}
        >
          <MoreVertical className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
