import { useEffect, useRef, useState } from "react";
import { formatTime } from "../../utils/formatTime";
import { updateBufferBar, clearBufferBar } from "../../utils/bufferedRange";
import { IS_MOBILE } from "../../utils/platform";
import type { PlaybackEngine } from "../../lib/nativeAudioBridge";
import type { Track } from "../../types";
import { SeekClock } from "./SeekClock";
import { SeekRail } from "./SeekRail";
import { useSeekDrag } from "./useSeekDrag";
import { useSeekHover } from "./useSeekHover";

export interface SeekBarProps {
  currentTrack: Track | null;
  audio: PlaybackEngine;
  /** Gate the 4/s timeupdate subscription (NowPlaying passes isOpen). The
   *  progress/durationchange subscriptions stay live while inactive so the
   *  buffer bar and duration pre-populate before the view opens. */
  active?: boolean;
}

export function SeekBar({ currentTrack, audio, active = true }: SeekBarProps) {
  // Refs for high-performance DOM updates (owned locally: seek drag / restore
  // session touch the DOM per event, never through React state).
  const progressFillRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  // Task 5 mobile full-width seek: on mobile the WHOLE row (clocks + rail +
  // duration) is the drag surface so the seek gesture spans the entire
  // PlayerBar width — the rail alone sits between two 52px clocks inside the
  // 30%-wide TrackInfo column (~1/3 of a phone screen). Desktop keeps the
  // rail-only surface (pointer events unchanged).
  const seekRowRef = useRef<HTMLDivElement>(null);
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
    progressFillRef.current.style.width = `${String(percent)}%`;
    if (thumbRef.current) thumbRef.current.style.left = `${String(percent)}%`;
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
      // Mirror of the fill's duration>0 guard below: a zero-duration payload
      // is an idle/load-window state, not real playback state (AudioController
      // never emits one) — applying it would clobber the session-restored
      // seed; bonus: no more 0:00 flicker while a track's metadata is loading.
      if (duration <= 0) return;
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
    // Mobile: the row is the drag surface (full PlayerBar width). Desktop
    // omits it — the rail stays the only surface, behavior byte-identical.
    surfaceRef: IS_MOBILE ? seekRowRef : undefined,
  });

  return (
    <div
      ref={seekRowRef}
      // Task 5 drag fix (2/2): `touch-none` lives on the ROW too — on mobile
      // the whole row is the drag surface (surfaceRef = seekRowRef), so a
      // drag that starts over the flanking clocks would still be hijacked by
      // the WebView without it (the rail-only touch-action dies at the row
      // edge). Harmless on desktop / outside the fixed bottom bar, same as
      // the rail.
      className="w-full flex items-center gap-3 touch-none"
      onPointerDown={IS_MOBILE ? handlePointerDown : undefined}
    >
      <SeekClock timeTextRef={currentTimeTextRef} />
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
        // Mobile: the row owns pointerdown (bubbling would otherwise run
        // handlePointerDown twice for a rail tap — the row's handler would
        // double-wire window listeners and double-seek on release).
        onPointerDown={IS_MOBILE ? undefined : handlePointerDown}
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
