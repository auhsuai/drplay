import { useTranslation } from "react-i18next";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { IS_MOBILE } from "../../utils/platform";

export interface SeekRailProps {
  progressBarRef: RefObject<HTMLDivElement | null>;
  bufferFillRef: RefObject<HTMLDivElement | null>;
  progressFillRef: RefObject<HTMLDivElement | null>;
  thumbRef: RefObject<HTMLDivElement | null>;
  tooltipRef: RefObject<HTMLDivElement | null>;
  bufferPreviewRef: RefObject<HTMLDivElement | null>;
  isHovering: boolean;
  isDragging: boolean;
  duration: number;
  onPointerDown?: ((e: ReactPointerEvent<HTMLDivElement>) => void) | undefined;
  onPointerEnter: () => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
}

export function SeekRail({
  progressBarRef,
  bufferFillRef,
  progressFillRef,
  thumbRef,
  tooltipRef,
  bufferPreviewRef,
  isHovering,
  isDragging,
  duration,
  onPointerDown,
  onPointerEnter,
  onPointerMove,
  onPointerLeave,
}: SeekRailProps) {
  const { t } = useTranslation();

  return (
    // Task 5 drag fix: `touch-none` (touch-action: none) — the WebView
    // gesture recognizer must NOT hijack the drag for scrolling. With
    // touch-action: auto (the default) a touch move on the rail fires
    // pointercancel the moment the browser claims the gesture, so the drag
    // died at the take-over point — taps (down+up, no move) still worked,
    // which read as "chi an duoc, khong keo duoc". The rail is inside the
    // fixed bottom bar (not the scroll container), so blocking
    // scroll-start-on-rail costs nothing. Harmless on desktop (touch-action
    // only applies to touch/pen input).
    <div
      ref={progressBarRef}
      role="progressbar"
      aria-label={t("now_playing.progress")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      className="flex-1 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer group relative flex items-center touch-none"
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <div
        ref={bufferFillRef}
        data-testid="buffer-fill"
        className="absolute inset-0 overflow-hidden rounded-full pointer-events-none"
      ></div>
      {isHovering && (
        // Clip wrapper for the hover preview — mirrors buffer-fill's
        // `overflow-hidden rounded-full` so the preview's flat head is rounded
        // to the rail when its negative-head pad clamps to 0 (otherwise the
        // head renders as a square corner on the rounded track). The wrapper
        // is a SIBLING of progress-fill on purpose: clipping the track itself
        // would cut the thumb's deliberate translate-x-1/2 overhang.
        <div className="absolute inset-0 overflow-hidden rounded-full pointer-events-none">
          <div
            ref={bufferPreviewRef}
            data-testid="buffer-preview"
            className="absolute top-0 left-0 h-full bg-gray-400 dark:bg-gray-500 rounded-r-sm pointer-events-none"
            style={{ left: "0%", width: "0%" }}
          ></div>
        </div>
      )}
      {/* The fill sits inside an overflow-hidden rounded-full clipper: the
          clipper cuts the fill to the track's rounded contour at ANY width,
          so the fill keeps its true percent width with no min-width clamp
          (the old 6px clamp jumped the fill 0→6px the moment progress > 0,
          reading as a notch while seeking).
          https://iifx.dev/en/articles/460222310 (rounded CSS progress bar —
          track overflow-hidden clips the fill to the rounded contour)
          https://stackoverflow.com/questions/77801099 (rounded corner
          overlap — radius scaling breaks on narrow children, fix via
          clipping the parent). */}
      <div className="absolute inset-0 overflow-hidden rounded-full pointer-events-none">
        <div
          ref={progressFillRef}
          data-testid="progress-fill"
          className="absolute left-0 h-full bg-brand-primary rounded-full transform-gpu will-change-[width]"
        ></div>
      </div>
      {/* Rail-anchored thumb (NOT inside the clipper): positioned from the
          rail's left edge via inline `left` % — at the same percent as the
          fill width this renders at the fill's end edge, identical visual
          position to the old fill-anchored right-0, but it survives 0%/100%
          where the clipper would cut the half-overhang (YT Music half-dot
          convention). IS_MOBILE keeps the handle always visible per the
          Material 3 slider spec (handles stay shown on touch surfaces) and
          YouTube Music's mobile player (the playhead dot never hides):
          https://m3.material.io/components/sliders/overview */}
      <div
        ref={thumbRef}
        data-testid="seek-thumb"
        style={{ left: "0%" }}
        className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 bg-white rounded-full shadow shrink-0 pointer-events-none transition-opacity ${
          IS_MOBILE || isHovering || isDragging ? "opacity-100" : "opacity-0"
        }`}
      ></div>
      {isHovering && duration > 0 && (
        <div
          ref={tooltipRef}
          data-testid="seek-tooltip"
          className="absolute bottom-full mb-2 left-0 -translate-x-1/2 z-10 px-2 py-1 rounded bg-gray-800 text-white text-xs whitespace-nowrap tabular-nums shadow pointer-events-none select-none"
        >
          0:00
        </div>
      )}
    </div>
  );
}
