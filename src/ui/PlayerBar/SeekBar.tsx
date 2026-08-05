import { useEffect, useRef, useState } from "react";
import { formatTime } from "../../utils/formatTime";
import { updateBufferBar, clearBufferBar } from "../../utils/bufferedRange";
import { captureError } from "../../utils/errorLog";
import type { AudioController } from "../../lib/AudioController";
import type { Track } from "../../types";

const PLAYER_BAR_MODULE = "PlayerBar";
const SEEK_STEP_SECONDS = 5;
const DRAG_RELEASE_DELAY_MS = 150;

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
  const isDraggingRef = useRef(false);

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
        progressFillRef.current.style.width = `${String((currentTime / duration) * 100)}%`;
      }
      // Buffer bar fallback: the last native `progress` event can fire with
      // buffered still empty before a small/fast file finishes loading (no
      // further progress event ever fires). timeupdate (~4/s) re-reads the
      // real buffered state so the bar cannot stay empty once it's full.
      // DOM-only — no React re-render.
      updateBufferBar(bufferFillRef.current, audio.getBuffered());
    });

    // Buffer bar: the native `progress` event fires whenever audio.buffered
    // grows (paused or playing) — the industry-standard source (MDN).
    const unsubProgress = audio.on("progress", () => {
      updateBufferBar(bufferFillRef.current, audio.getBuffered());
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
        progressFillRef.current.style.width = `${String((time / dur) * 100)}%`;
      } else if (progressFillRef.current) {
        progressFillRef.current.style.width = "0%";
      }
    } else {
      if (currentTimeTextRef.current)
        currentTimeTextRef.current.textContent = "0:00";
      if (progressFillRef.current) progressFillRef.current.style.width = "0%";
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
      const percent = Math.max(
        0,
        Math.min(1, (clientX - bounds.left) / bounds.width),
      );
      if (progressFillRef.current)
        progressFillRef.current.style.width = `${String(percent * 100)}%`;
      if (currentTimeTextRef.current)
        currentTimeTextRef.current.textContent = formatTime(percent * duration);
      return percent * duration;
    };

    isDraggingRef.current = true;
    updateTime(e.clientX);

    const onMove = (moveEvent: PointerEvent) => updateTime(moveEvent.clientX);
    const commit = (upEvent: PointerEvent) => {
      audio.seek(updateTime(upEvent.clientX));
      // Redraw immediately (not clear): updateBufferBar drops stale pre-seek
      // ranges, so an immediate redraw shows the real buffer at the new
      // position without the empty-bar blink a clear would cause.
      updateBufferBar(bufferFillRef.current, audio.getBuffered());
      // Give the audio engine a small window to flush old timeupdate events
      setTimeout(() => {
        isDraggingRef.current = false;
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
          // every seek).
          updateBufferBar(bufferFillRef.current, audio.getBuffered());
          break;
        case "ArrowRight":
          e.preventDefault();
          audio.seek(
            Math.min(
              audio.getDuration(),
              audio.getCurrentTime() + SEEK_STEP_SECONDS,
            ),
          );
          updateBufferBar(bufferFillRef.current, audio.getBuffered());
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
      >
        <div
          ref={bufferFillRef}
          data-testid="buffer-fill"
          className="absolute inset-0 overflow-hidden rounded-full pointer-events-none"
        ></div>
        <div
          ref={progressFillRef}
          className="absolute left-0 h-full bg-[#4285F4] rounded-full flex items-center transform-gpu will-change-[width]"
        >
          <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 bg-white rounded-full shadow shrink-0"></div>
        </div>
      </div>
      <span className="text-xs text-gray-500 min-w-[52px] tabular-nums">
        {formatTime(duration)}
      </span>
    </div>
  );
}
