import { useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { formatTime } from "../../utils/formatTime";
import { IS_MOBILE } from "../../utils/platform";
import { BUFFER_HEAD_PAD_PCT } from "../../utils/bufferedRange";
import { clamp, clamp01 } from "./seekMath";

// jsdom reports offsetWidth 0 (no layout); this fallback approximates the
// rendered tooltip width so the edge clamp behaves identically in tests and
// browsers.
const SEEK_TOOLTIP_FALLBACK_WIDTH_PX = 44;

export interface UseSeekHoverOptions {
  progressBarRef: RefObject<HTMLDivElement | null>;
  tooltipRef: RefObject<HTMLDivElement | null>;
  bufferPreviewRef: RefObject<HTMLDivElement | null>;
  playheadRef: RefObject<number>;
  duration: number;
}

export function useSeekHover({
  progressBarRef,
  tooltipRef,
  bufferPreviewRef,
  playheadRef,
  duration,
}: UseSeekHoverOptions): {
  isHovering: boolean;
  handlePointerEnter: () => void;
  handlePointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  handlePointerLeave: () => void;
} {
  // Hover visibility is low-frequency (enter/leave) so React state is fine;
  // per-pixel tooltip/preview updates go straight to the DOM via refs (same
  // hot-path pattern as the timeupdate handler).
  const [isHovering, setIsHovering] = useState(false);

  // Hover preview: tooltip + buffer highlight + thumb visibility. Position and
  // text are written DOM-direct on every pointermove (hot path, no re-render);
  // only the visibility toggle (enter/leave) goes through React state.
  // Pointer events fire for touch on mobile (a tap fires pointerenter and
  // pointermove on the rail — MDN "Pointer events": pointer events unify
  // mouse, pen and touch input), so without a gate every touch would flip
  // isHovering and flash the desktop hover affordances — the tooltip with its
  // hard-coded "0:00" text plus the buffer preview — at the rail edge before
  // the first move. Hover affordances are desktop-only; mobile feedback is
  // the drag itself (clock + thumb via isDragging in useSeekDrag).
  const handlePointerEnter = () => {
    if (IS_MOBILE) return;
    setIsHovering(true);
  };
  const handlePointerLeave = () => {
    if (IS_MOBILE) return;
    setIsHovering(false);
  };
  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (IS_MOBILE) return;
    if (duration === 0 || !progressBarRef.current) return;
    const bounds = progressBarRef.current.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const percent = clamp01((e.clientX - bounds.left) / bounds.width);

    if (tooltipRef.current) {
      tooltipRef.current.textContent = formatTime(percent * duration);
      // Center the tooltip on the pointer but keep its edges inside the bar:
      // the anchor is clamped to [halfWidth, width - halfWidth] of the
      // tooltip's own measured width (-translate-x-1/2 centers it on it).
      const halfWidth =
        (tooltipRef.current.offsetWidth || SEEK_TOOLTIP_FALLBACK_WIDTH_PX) / 2;
      tooltipRef.current.style.left = `${String(
        clamp(
          percent * bounds.width,
          halfWidth,
          Math.max(halfWidth, bounds.width - halfWidth),
        ),
      )}px`;
    }

    if (bufferPreviewRef.current) {
      // The highlight only makes sense ahead of the playhead ("would buffer to
      // here"); hovering behind the playhead shows nothing.
      // Playhead source: the mirrored UI playhead (throttled timeupdate / drag /
      // restore) — the SAME value the blue fill is showing. Reading the raw
      // media clock instead would start the preview ~200ms ahead of the fill
      // while playing (timeupdate is throttled), splitting the bar into a gap
      // or an overlap at the preview head.
      const playheadPercent = clamp01(playheadRef.current / duration);
      if (percent > playheadPercent) {
        // Negative head, same seam geometry as the buffered segments
        // (bufferedRange BUFFER_HEAD_PAD_PCT): the flat left edge is pulled
        // back 2% (clamped to the rail start) so it tucks UNDER the fill's
        // round cap — the fill drawn on top covers the padded strip, so the
        // seam shows only the fill's convex cap instead of a square corner.
        const headPercent = Math.max(
          0,
          playheadPercent * 100 - BUFFER_HEAD_PAD_PCT,
        );
        bufferPreviewRef.current.style.left = `${String(headPercent)}%`;
        bufferPreviewRef.current.style.width = `${String(
          percent * 100 - headPercent,
        )}%`;
      } else {
        bufferPreviewRef.current.style.width = "0%";
      }
    }
  };

  return {
    isHovering,
    handlePointerEnter,
    handlePointerMove,
    handlePointerLeave,
  };
}
