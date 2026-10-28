import { useEffect, useRef } from "react";
import type { BufferedRangePayload } from "../lib/pipWindow";
import { formatTime } from "../utils/formatTime";
import { updateBufferBar } from "../utils/bufferedRange";
import { SeekClock } from "./components/SeekClock";
import { SeekRail } from "./components/SeekRail";
import { clamp } from "./components/seekMath";
import { usePipSeekDrag } from "./components/usePipSeekDrag";
import { useSeekHover } from "./components/useSeekHover";

/** Half the seek thumb's width. Mirrored from SeekBar (the shared rail's
 *  w-3 thumb is centered on its `left`), so the PiP thumb clamps identically
 *  and the two bars stay visually indistinguishable. Duplicating the constant
 *  is intentional: SeekBar does not export it, and the value belongs to the
 *  rail design, not to either bar's state machine. */
const THUMB_HALF_PX = 6;

/**
 * Adapt the IPC-friendly `{start,end}[]` payload to the structural
 * `TimeRanges` shape `updateBufferBar` consumes.
 *
 * The PiP window never has a media element, so there is no real `TimeRanges`
 * to pass: this thin view is the ONLY adapter, keeping `bufferedRange.ts` (the
 * single source of segment geometry) engine-agnostic. Out-of-range indexes
 * return 0 — same defensive shape as the engine's own wrapper — so a stale
 * index can never paint a NaN segment.
 */
export function toTimeRanges(
  ranges: readonly BufferedRangePayload[],
): TimeRanges {
  return {
    length: ranges.length,
    start: (index: number): number => ranges[index]?.start ?? 0,
    end: (index: number): number => ranges[index]?.end ?? 0,
  };
}

export interface PipSeekBarProps {
  currentTime: number;
  duration: number;
  buffered: BufferedRangePayload[];
  /** ended / errored / unknown duration: the rail reads as non-seekable. */
  disabled: boolean;
  onSeek: (time: number) => void;
  /** Compact rows hide the clocks: the hover tooltip is the timestamp
   *  read-out, exactly like the PlayerBar's "top" rail. */
  showClocks?: boolean;
  className?: string;
}

/**
 * Seek bar for the PiP window.
 *
 * Presentational by contract: it owns no playback state and imports no engine.
 * Everything it draws comes from the `pip-state` payload, and the only way out
 * is `onSeek` — the window's `sendAction("seek", …)`. The rail, hover
 * behaviour and buffer geometry are the SHARED components
 * (`SeekRail` / `useSeekHover` / `bufferedRange`), not a copy: the full-screen,
 * PlayerBar and PiP bars must remain one design with one source of truth.
 */
export function PipSeekBar({
  currentTime,
  duration,
  buffered,
  disabled,
  onSeek,
  showClocks = true,
  className = "",
}: PipSeekBarProps) {
  // High-frequency DOM handles: every sync/drag tick writes through these
  // instead of React state, so the 4/s publisher never re-renders the view.
  const progressBarRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const bufferPreviewRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  // The playhead the blue fill is CURRENTLY showing (not the raw payload
  // value). Written at the same single point as the fill width so the hover
  // preview always starts exactly where the fill ends.
  const playheadRef = useRef(0);
  // Shared with usePipSeekDrag (closure-safe guard) and this file's prop-sync
  // effect: while a drag is live, incoming pip-state must not move the fill —
  // the seek round-trip means the payload can still carry the OLD position.
  const isDraggingRef = useRef(false);
  // Latest duration for the drag math: the window listeners outlive the render
  // closure, so a mid-drag duration change must re-scale the drag.
  const durationRef = useRef(0);

  const setFillWidth = (percent: number): void => {
    if (!progressFillRef.current) return;
    // Clamp at the single write-point: the payload can overshoot the duration
    // (a VBR durationchange shrinks under a running clock), so
    // width/thumb/aria-valuenow must never leave 0..100.
    const p = clamp(percent, 0, 100);
    // Read the rail width BEFORE any style write: write-then-read would force
    // a synchronous reflow. One read per call.
    const railWidth = progressBarRef.current?.clientWidth ?? 0;
    progressFillRef.current.style.width = `${String(p)}%`;
    if (thumbRef.current) {
      if (railWidth > 0) {
        // Rail is edge-to-edge: clamp the centered thumb inside the track
        // (same half-thumb padding as SeekBar) so it is never cut at 0%/100%.
        const center = clamp(
          (p / 100) * railWidth,
          THUMB_HALF_PX,
          railWidth - THUMB_HALF_PX,
        );
        thumbRef.current.style.left = `${String(center)}px`;
      } else {
        // No layout yet (jsdom): keep the plain % so the thumb still tracks.
        thumbRef.current.style.left = `${String(p)}%`;
      }
    }
    progressBarRef.current?.setAttribute(
      "aria-valuenow",
      String(Math.round(p)),
    );
    progressBarRef.current?.setAttribute(
      "aria-valuetext",
      formatTime(playheadRef.current),
    );
  };

  // Single write-point for the drag draft: playhead → fill → clock, the same
  // order SeekBar documents, so aria-valuetext (read from playheadRef inside
  // setFillWidth) always matches the width being written.
  const applyDraftTime = (time: number): void => {
    playheadRef.current = time;
    setFillWidth(
      clamp(
        durationRef.current > 0 ? (time / durationRef.current) * 100 : 0,
        0,
        100,
      ),
    );
    if (currentTimeTextRef.current) {
      currentTimeTextRef.current.textContent = formatTime(time);
    }
  };

  const {
    isHovering,
    handlePointerEnter,
    handlePointerMove,
    handlePointerLeave,
  } = useSeekHover({
    progressBarRef,
    tooltipRef,
    bufferPreviewRef,
    playheadRef,
    duration,
  });

  const { isDragging, handlePointerDown } = usePipSeekDrag({
    progressBarRef,
    playheadRef,
    durationRef,
    isDraggingRef,
    duration,
    disabled,
    onDraftTime: applyDraftTime,
    onCommit: onSeek,
  });

  // Sync the whole bar from the published payload. Skipped while a drag is
  // live: the seek has not round-tripped yet, so the payload still describes
  // the pre-drag position and would fight the user's finger.
  //
  // `buffered` is a fresh array per publish (the main window flattens TimeRanges
  // every tick), so this effect runs on every state patch — which is exactly
  // the cadence the buffer segments need. Writing through refs keeps it off the
  // React render path.
  useEffect(() => {
    durationRef.current = duration;
    if (isDraggingRef.current) return;

    const time = Number.isFinite(currentTime) ? currentTime : 0;
    if (currentTimeTextRef.current) {
      currentTimeTextRef.current.textContent = formatTime(time);
    }
    playheadRef.current = time;
    // The fill/aria write goes through the shared writer so the thumb clamp
    // and the a11y attributes can never drift from the visual bar.
    setFillWidth(clamp(duration > 0 ? (time / duration) * 100 : 0, 0, 100));
    updateBufferBar(
      bufferFillRef.current,
      {
        duration,
        currentTime: time,
        buffered: toTimeRanges(buffered),
      },
      playheadRef.current,
    );
    // setFillWidth is a stable-per-render closure over refs only, so it is
    // deliberately not a dependency (it would re-run this effect on every
    // render for no behavioural gain).
  }, [currentTime, duration, buffered]);

  // SeekRail gates every interactive affordance on `duration > 0` (cursor,
  // hover grow, thumb, tooltip). A finished/failed track still HAS a duration,
  // so the rail must be told "not seekable" — 0 — while the duration CLOCK and
  // the fill keep using the real value. This is why the rail gets a separate
  // prop instead of the component lying to itself everywhere.
  const railDuration = disabled ? 0 : duration;

  return (
    <div className={`w-full flex items-center gap-2 ${className}`.trim()}>
      {showClocks && <SeekClock timeTextRef={currentTimeTextRef} />}
      <SeekRail
        progressBarRef={progressBarRef}
        bufferFillRef={bufferFillRef}
        progressFillRef={progressFillRef}
        thumbRef={thumbRef}
        tooltipRef={tooltipRef}
        bufferPreviewRef={bufferPreviewRef}
        isHovering={isHovering}
        isDragging={isDragging}
        duration={railDuration}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        variant="default"
      />
      {showClocks && (
        <span className="text-xs text-gray-500 min-w-[52px] tabular-nums">
          {duration > 0 ? formatTime(duration) : "--:--"}
        </span>
      )}
    </div>
  );
}
