import { useEffect, useRef, useState } from "react";
import { formatTime } from "../../utils/formatTime";
import { updateBufferBar, clearBufferBar } from "../../utils/bufferedRange";
import type { AudioController } from "../../lib/AudioController";
import type { Track } from "../../types";
import { SeekClock } from "./SeekClock";
import { SeekRail } from "./SeekRail";
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
}

export function SeekBar({
  currentTrack,
  audio,
  active = true,
  keyboardSeek = true,
}: SeekBarProps) {
  // Refs for high-performance DOM updates (owned locally: seek drag / restore
  // session touch the DOM per event, never through React state).
  const progressFillRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
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

  // Single write-point for the fill width so every path (timeupdate / drag /
  // restore) stays in sync — DOM-direct like playheadRef (no React re-render
  // on the hot path). aria-valuenow is mirrored on the SAME write-point (WAI-
  // ARIA requires it updated with JS; the fill width is the progress value),
  // so the a11y attribute and the visual fill can never drift apart. The
  // fill className carries rounded-full statically: both ends stay round at
  // every width (original look — no small 2px right corner, no rail-end
  // toggle).
  const setFillWidth = (percent: number): void => {
    if (!progressFillRef.current) return;
    progressFillRef.current.style.width = `${String(percent)}%`;
    progressBarRef.current?.setAttribute(
      "aria-valuenow",
      String(Math.round(percent)),
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
    // ``duration`` is intentionally not a dependency: the effect only runs
    // when the TRACK changes, and reads the latest duration closure value
    // for tracks without a restoreDuration. Adding duration would reset the
    // time display back to restoreTime on every timeupdate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack]);

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
    <div className="w-full flex items-center gap-3">
      <SeekClock timeTextRef={currentTimeTextRef} />
      <SeekRail
        progressBarRef={progressBarRef}
        bufferFillRef={bufferFillRef}
        progressFillRef={progressFillRef}
        tooltipRef={tooltipRef}
        bufferPreviewRef={bufferPreviewRef}
        isHovering={isHovering}
        isDragging={isDragging}
        duration={duration}
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      />
      <span className="text-xs text-gray-500 min-w-[52px] tabular-nums">
        {formatTime(duration)}
      </span>
    </div>
  );
}
