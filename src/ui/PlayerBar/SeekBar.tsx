import { useEffect, useRef, useState } from "react";
import { formatTime } from "../../utils/formatTime";
import { updateBufferBar, clearBufferBar } from "../../utils/bufferedRange";
import { captureError } from "../../utils/errorLog";
import type { AudioController } from "../../lib/AudioController";
import type { Track } from "../../types";

const PLAYER_BAR_MODULE = "PlayerBar";
const SEEK_STEP_SECONDS = 5;
const DRAG_RELEASE_DELAY_MS = 150;
// jsdom reports offsetWidth 0 (no layout); this fallback approximates the
// rendered tooltip width so the edge clamp behaves identically in tests and
// browsers.
const SEEK_TOOLTIP_FALLBACK_WIDTH_PX = 44;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);
const clamp01 = (value: number): number => clamp(value, 0, 1);

export interface SeekBarProps {
  currentTrack: Track | null;
  audio: AudioController;
}

export function SeekBar({ currentTrack, audio }: SeekBarProps) {
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
  const isDraggingRef = useRef(false);

  // Single write-point for the fill width so every path (timeupdate / drag /
  // restore) stays in sync — DOM-direct like playheadRef (no React re-render
  // on the hot path). The fill className carries rounded-full statically:
  // both ends stay round at every width (original look — no small 2px right
  // corner, no rail-end toggle).
  const setFillWidth = (percent: number): void => {
    if (!progressFillRef.current) return;
    progressFillRef.current.style.width = `${String(percent)}%`;
  };

  // Duration is owned here: it feeds the right-side clock AND the drag math,
  // and is written ~4/s by timeupdate — keeping it local stops those updates
  // from re-rendering the whole PlayerBar tree (render-critical isolation).
  const [duration, setDuration] = useState(0);

  // Hover visibility is low-frequency (enter/leave) so React state is fine;
  // per-pixel tooltip/preview updates go straight to the DOM via refs (same
  // hot-path pattern as the timeupdate handler below).
  const [isHovering, setIsHovering] = useState(false);
  // Render mirror of isDraggingRef: the ref stays the closure-safe source of
  // truth for the timeupdate guard; this state exists only to re-render the
  // thumb on pointerdown/commit (refs never trigger renders).
  const [isDragging, setIsDragging] = useState(false);

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

  // Subscribe to AudioController time events. The hot path (timeupdate ~4/s)
  // writes the DOM directly and only bumps the duration state — no React
  // re-render of the tree on every tick.
  useEffect(() => {
    const unsubTime = audio.on("timeupdate", ({ currentTime, duration }) => {
      setDuration(duration);
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

    // Buffer bar: the native `progress` event fires whenever audio.buffered
    // grows (paused or playing) — the industry-standard source (MDN).
    const unsubProgress = audio.on("progress", () => {
      updateBufferBar(
        bufferFillRef.current,
        audio.getBuffered(),
        playheadRef.current,
      );
    });

    return () => {
      unsubTime();
      unsubProgress();
    };
  }, [audio]);

  // Sync initial UI state from restored session data
  useEffect(() => {
    if (bufferFillRef.current) clearBufferBar(bufferFillRef.current);
    if (currentTrack) {
      const time = currentTrack.restoreTime || 0;
      const dur = currentTrack.restoreDuration || duration || 0;

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

  // Drag-to-seek: pointer capture on the bar, clamped percent -> time math,
  // commit on pointerup/cancel (seek + immediate buffer redraw), and a small
  // release delay so stale in-flight timeupdate events cannot jump the thumb.
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!progressBarRef.current || duration === 0) return;
    try {
      progressBarRef.current.setPointerCapture(e.pointerId);
    } catch (err) {
      void captureError({
        level: "warn",
        source: PLAYER_BAR_MODULE,
        message: `set-pointer-capture-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const bounds = progressBarRef.current.getBoundingClientRect();
    const updateTime = (clientX: number) => {
      const percent = clamp01((clientX - bounds.left) / bounds.width);
      if (progressFillRef.current) setFillWidth(percent * 100);
      if (currentTimeTextRef.current)
        currentTimeTextRef.current.textContent = formatTime(percent * duration);
      playheadRef.current = percent * duration;
      return percent * duration;
    };

    isDraggingRef.current = true;
    setIsDragging(true);
    updateTime(e.clientX);

    const onMove = (moveEvent: PointerEvent) => updateTime(moveEvent.clientX);
    const commit = (upEvent: PointerEvent) => {
      audio.seek(updateTime(upEvent.clientX));
      // Redraw immediately (not clear): updateBufferBar drops stale pre-seek
      // ranges, so an immediate redraw shows the real buffer at the new
      // position without the empty-bar blink a clear would cause. The UI
      // playhead (just written by updateTime) drives the stale-range drop
      // filters, so the raw clock cannot drop a range the fill is still
      // covering or leave the bar looking wrong in the interim frame.
      updateBufferBar(
        bufferFillRef.current,
        audio.getBuffered(),
        playheadRef.current,
      );
      // Give the audio engine a small window to flush old timeupdate events
      setTimeout(() => {
        isDraggingRef.current = false;
        setIsDragging(false);
      }, DRAG_RELEASE_DELAY_MS);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const onUp = (upEvent: PointerEvent) => {
      commit(upEvent);
    };
    const onCancel = (cancelEvent: PointerEvent) => {
      commit(cancelEvent);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  // Hover preview: tooltip + buffer highlight + thumb visibility. Position and
  // text are written DOM-direct on every pointermove (hot path, no re-render);
  // only the visibility toggle (enter/leave) goes through React state.
  const handlePointerEnter = () => {
    setIsHovering(true);
  };
  const handlePointerLeave = () => {
    setIsHovering(false);
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
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
        bufferPreviewRef.current.style.left = `${String(
          playheadPercent * 100,
        )}%`;
        bufferPreviewRef.current.style.width = `${String(
          (percent - playheadPercent) * 100,
        )}%`;
      } else {
        bufferPreviewRef.current.style.width = "0%";
      }
    }
  };

  // ArrowLeft/Right seek the track and redraw the buffer bar synchronously.
  // Lives here (not the global shortcuts hook) because it needs the local
  // bufferFillRef; global transport keys stay in useKeyboardShortcuts.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl?.tagName === "INPUT" ||
        activeEl?.tagName === "TEXTAREA" ||
        activeEl?.isContentEditable
      )
        return;

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          audio.seek(Math.max(0, audio.getCurrentTime() - SEEK_STEP_SECONDS));
          // Redraw immediately instead of clearing: updateBufferBar already
          // drops stale pre-seek ranges, and clearing first would flash an
          // empty bar for a frame before the next progress event (blink on
          // every seek). The UI playhead (the position the fill still shows —
          // the fill moves on the next timeupdate) drives the stale-range
          // drop filters in the interim frame.
          updateBufferBar(
            bufferFillRef.current,
            audio.getBuffered(),
            playheadRef.current,
          );
          break;
        case "ArrowRight":
          e.preventDefault();
          audio.seek(
            Math.min(
              audio.getDuration(),
              audio.getCurrentTime() + SEEK_STEP_SECONDS,
            ),
          );
          updateBufferBar(
            bufferFillRef.current,
            audio.getBuffered(),
            playheadRef.current,
          );
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [audio]);

  return (
    <div className="w-full flex items-center gap-3">
      <span
        ref={currentTimeTextRef}
        className="text-xs text-gray-500 min-w-[52px] text-right tabular-nums"
      >
        0:00
      </span>
      <div
        ref={progressBarRef}
        className="flex-1 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer group relative flex items-center"
        onPointerDown={handlePointerDown}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        <div
          ref={bufferFillRef}
          data-testid="buffer-fill"
          className="absolute inset-0 overflow-hidden rounded-full pointer-events-none"
        ></div>
        {isHovering && (
          <div
            ref={bufferPreviewRef}
            data-testid="buffer-preview"
            className="absolute top-0 left-0 h-full bg-gray-400 dark:bg-gray-500 rounded-r-sm pointer-events-none"
            style={{ left: "0%", width: "0%" }}
          ></div>
        )}
        <div
          ref={progressFillRef}
          data-testid="progress-fill"
          className="absolute left-0 h-full bg-brand-primary rounded-full flex items-center transform-gpu will-change-[width]"
        >
          <div
            data-testid="seek-thumb"
            className={`absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 bg-white rounded-full shadow shrink-0 pointer-events-none transition-opacity ${
              isHovering || isDragging ? "opacity-100" : "opacity-0"
            }`}
          ></div>
        </div>
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
      <span className="text-xs text-gray-500 min-w-[52px] tabular-nums">
        {formatTime(duration)}
      </span>
    </div>
  );
}
