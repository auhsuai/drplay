import { useEffect, useRef, useState } from "react";
import { formatTime } from "../../utils/formatTime";
import { updateBufferBar, clearBufferBar } from "../../utils/bufferedRange";
import type { AudioController } from "../../lib/AudioController";
import type { Track } from "../../types";
import { SeekClock } from "./SeekClock";
import { SeekRail } from "./SeekRail";
import { clamp } from "./seekMath";
import { useSeekDrag } from "./useSeekDrag";
import { useSeekHover } from "./useSeekHover";
import { useSeekKeyboard } from "./useSeekKeyboard";

export interface SeekBarProps {
  currentTrack: Track | null;
  audio: AudioController;
  /** Gate the 4/s timeupdate subscription (NowPlaying passes isOpen). The
   *  progress/durationchange subscriptions stay live while inactive so the
   *  buffer bar and duration pre-populate before the view opens. */
  active?: boolean;
  /** Disable the global ArrowLeft/Right seek keys. The PlayerBar instance
   *  keeps them (default true); the NowPlaying instance passes false so two
   *  mounted SeekBars never double the seek step. */
  keyboardSeek?: boolean;
  /** "top" pins the bar to the nearest positioned ancestor's top edge
   *  (PlayerBar root is `relative`) and hides both clocks — the hover
   *  tooltip is the timestamp read-out. Default keeps the in-flow layout
   *  with both clocks visible (NowPlaying). */
  variant?: "default" | "top";
}

export function SeekBar({
  currentTrack,
  audio,
  active = true,
  keyboardSeek = true,
  variant = "default",
}: SeekBarProps) {
  // Refs for high-performance DOM updates (owned locally: seek drag / restore
  // session touch the DOM per event, never through React state).
  const progressFillRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const bufferPreviewRef = useRef<HTMLDivElement>(null);
  // Mirror of the playhead the blue fill is CURRENTLY showing. It is written
  // wherever the fill width is written (throttled timeupdate, drag, restore),
  // so the hover preview always starts exactly where the fill ends — the raw
  // media clock (audio.getCurrentTime()) can be ~200ms ahead of the throttled
  // timeupdate while playing, which would open a gap/overlap at the preview head.
  const playheadRef = useRef(0);
  // Shared with useSeekDrag: the timeupdate effect below reads it as the
  // closure-safe drag guard; the hook writes it on pointerdown/commit.
  const isDraggingRef = useRef(false);
  // Mirror of `duration` for the drag math: the window pointer listeners
  // created on pointerdown outlive the render closure, so they must read the
  // LATEST duration (a mid-drag durationchange must re-scale the drag) — never
  // the value captured at pointerdown.
  const durationRef = useRef(0);

  // Single write-point for the fill width and the thumb position so every
  // path (timeupdate / drag / restore) stays in sync — DOM-direct like
  // playheadRef (no React re-render on the hot path). aria-valuenow is
  // mirrored on the SAME write-point (WAI-ARIA requires it updated with JS;
  // the fill width is the progress value), so the a11y attribute and the
  // visual fill can never drift apart. The width is ALWAYS the true percent:
  // the rail's overflow-hidden rounded-full clipper (SeekRail) rounds the
  // fill to the track contour at any width, so a hair-thin fill renders as
  // a rounded sliver instead of a needle and there is no 0→6px min-width
  // notch (https://iifx.dev/en/articles/460222310,
  // https://stackoverflow.com/questions/77801099). The thumb is positioned
  // by `left` on the rail (same write-point) so it stays outside the
  // clipper — never cut at 0%/100%.
  const setFillWidth = (percent: number): void => {
    if (!progressFillRef.current) return;
    // Clamp at the single write-point: the throttled timeupdate can carry a
    // currentTime past the duration (TimeInterpolator keeps counting through
    // the bridge push-gap; a VBR durationchange can also shrink under it), so
    // width/thumb/aria-valuenow must never leave the 0..100 range.
    const p = clamp(percent, 0, 100);
    progressFillRef.current.style.width = `${String(p)}%`;
    if (thumbRef.current) thumbRef.current.style.left = `${String(p)}%`;
    progressBarRef.current?.setAttribute(
      "aria-valuenow",
      String(Math.round(p)),
    );
    progressBarRef.current?.setAttribute(
      "aria-valuetext",
      formatTime(playheadRef.current),
    );
  };

  // Duration is owned here: it feeds the right-side clock AND the drag math,
  // and is written ~4/s by timeupdate — keeping it local stops those updates
  // from re-rendering the whole PlayerBar tree (render-critical isolation).
  const [duration, setDuration] = useState(0);

  // Reset transient track state when the track changes. Done during render
  // (React "adjusting state during render" pattern) so no setState happens
  // synchronously inside an effect (react-hooks/set-state-in-effect).
  const prevTrackIdRef = useRef<string | undefined>(undefined);
  if (currentTrack?.id !== prevTrackIdRef.current) {
    prevTrackIdRef.current = currentTrack?.id;
    if (currentTrack?.restoreDuration)
      setDuration(currentTrack.restoreDuration);
    else if (!currentTrack) setDuration(0);
  }

  // Subscribe to the realtime progress event. The hot path (timeupdate ~4/s)
  // writes the DOM directly and only bumps the duration state — no React
  // re-render of the tree on every tick. Gated on `active`: a closed
  // NowPlaying view must not pay for the 4/s handler, but the buffer
  // fallback below lives in this handler, so the `progress` subscription
  // below stays live to keep the buffer bar populated while inactive.
  useEffect(() => {
    if (!active) return;

    // One-shot resync when this effect (re)subscribes: on mount and when the
    // NowPlaying view opens (active false->true). The inactive instance
    // ignores every timeupdate by design, so opening the view while PAUSED
    // would show 0:00 / 0% forever — no further event arrives to repaint.
    // Read the engine truth once; duration 0 means no track/metadata yet, so
    // leave the restore path (below) untouched.
    const engineDuration = audio.getDuration();
    if (engineDuration > 0 && engineDuration !== durationRef.current) {
      durationRef.current = engineDuration;
      setDuration(engineDuration);
    }
    if (engineDuration > 0 && !isDraggingRef.current) {
      const engineTime = audio.getCurrentTime();
      if (currentTimeTextRef.current)
        currentTimeTextRef.current.textContent = formatTime(engineTime);
      playheadRef.current = engineTime;
      setFillWidth(clamp((engineTime / engineDuration) * 100, 0, 100));
    }

    const unsubTime = audio.on("timeupdate", ({ currentTime, duration }) => {
      setDuration(duration);
      durationRef.current = duration;
      if (isDraggingRef.current) return;
      if (currentTimeTextRef.current)
        currentTimeTextRef.current.textContent = formatTime(currentTime);
      if (progressFillRef.current && duration > 0) {
        playheadRef.current = currentTime;
        setFillWidth((currentTime / duration) * 100);
      }
      // Buffer bar fallback: the last native `progress` event can fire with
      // buffered still empty before a small/fast file finishes loading (no
      // further progress event ever fires). timeupdate (~4/s) re-reads the
      // real buffered state so the bar cannot stay empty once it's full.
      // DOM-only — no React re-render. Segments span their full ranges; the
      // fill (drawn above the buffer layer) covers the pre-playhead part, so
      // the raw media clock (~200ms ahead while playing) cannot open a gap
      // between fill end and segment head. The UI playhead is passed for the
      // stale-range drop filters — the raw clock could judge a range just
      // ahead of the fill as "stale cache" and drop it.
      updateBufferBar(
        bufferFillRef.current,
        audio.getBuffered(),
        playheadRef.current,
      );
    });

    return () => {
      unsubTime();
    };
  }, [audio, active]);

  // Buffer bar: the native `progress` event fires whenever audio.buffered
  // grows (paused or playing) — the industry-standard source (MDN). NOT
  // gated on `active`: the buffer must pre-populate while the NowPlaying view
  // is still closed.
  useEffect(() => {
    const unsubProgress = audio.on("progress", () => {
      updateBufferBar(
        bufferFillRef.current,
        audio.getBuffered(),
        playheadRef.current,
      );
    });

    return () => {
      unsubProgress();
    };
  }, [audio]);

  // Duration sync from the audio element: `durationchange` fires when
  // metadata loads (paused or playing) and AudioController re-emits it on
  // every element swap. The getDuration() seed covers the mount case where
  // the active element already has metadata (no event will ever fire). Both
  // stay live while inactive — the duration clock must be right when the
  // NowPlaying view opens.
  useEffect(() => {
    const unsubDuration = audio.on("durationchange", ({ duration }) => {
      const d = duration || 0;
      durationRef.current = d;
      setDuration(d);
    });

    // Seed with whatever metadata the active element already has.
    const initialDuration = audio.getDuration();
    if (initialDuration > 0 && initialDuration !== durationRef.current) {
      durationRef.current = initialDuration;
      setDuration(initialDuration);
    }

    return () => {
      unsubDuration();
    };
  }, [audio]);

  // Sync initial UI state from restored session data
  useEffect(() => {
    if (bufferFillRef.current) clearBufferBar(bufferFillRef.current);
    if (currentTrack) {
      const time = currentTrack.restoreTime || 0;
      const dur = currentTrack.restoreDuration || duration || 0;
      durationRef.current = dur;

      if (currentTimeTextRef.current)
        currentTimeTextRef.current.textContent = formatTime(time);
      if (progressFillRef.current && dur > 0) {
        playheadRef.current = time;
        setFillWidth((time / dur) * 100);
      } else if (progressFillRef.current) {
        playheadRef.current = 0;
        setFillWidth(0);
      }
    } else {
      durationRef.current = 0;
      if (currentTimeTextRef.current)
        currentTimeTextRef.current.textContent = "0:00";
      if (progressFillRef.current) {
        playheadRef.current = 0;
        setFillWidth(0);
      }
    }
    // The effect depends on the TRACK ID, not the track object reference:
    // usePlayer.ts defers metadata (e.g. restoreDuration) via setCurrentTrack,
    // producing a new object with the SAME id. Depending on the raw reference
    // re-ran this effect on every such update, resetting the fill to 0% while
    // playing/paused (no timeupdate arrives to repaint it). ``duration`` is
    // also intentionally not a dependency — the effect reads the latest
    // duration closure value for tracks without a restoreDuration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id]);

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
  const { isDragging, handlePointerDown } = useSeekDrag({
    audio,
    progressBarRef,
    progressFillRef,
    currentTimeTextRef,
    bufferFillRef,
    playheadRef,
    durationRef,
    isDraggingRef,
    duration,
    setFillWidth,
  });
  useSeekKeyboard({
    audio,
    bufferFillRef,
    playheadRef,
    enabled: keyboardSeek,
  });

  return (
    <div
      className={`w-full flex items-center gap-3${
        variant === "top" ? " absolute inset-x-0 top-0" : ""
      }`}
    >
      <SeekClock timeTextRef={currentTimeTextRef} variant={variant} />
      <SeekRail
        progressBarRef={progressBarRef}
        bufferFillRef={bufferFillRef}
        progressFillRef={progressFillRef}
        thumbRef={thumbRef}
        tooltipRef={tooltipRef}
        bufferPreviewRef={bufferPreviewRef}
        isHovering={isHovering}
        isDragging={isDragging}
        duration={duration}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        variant={variant}
      />
      <span
        className={`text-xs text-gray-500 min-w-[52px] tabular-nums${
          variant === "top" ? " hidden" : ""
        }`}
      >
        {formatTime(duration)}
      </span>
    </div>
  );
}
