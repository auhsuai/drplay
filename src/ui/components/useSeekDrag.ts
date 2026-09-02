import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { AudioController } from "../../lib/AudioController";
import { updateBufferBar } from "../../utils/bufferedRange";
import { captureError } from "../../utils/errorLog";
import { formatTime } from "../../utils/formatTime";
import { clamp01 } from "./seekMath";

const SEEK_BAR_MODULE = "SeekBar";
const DRAG_RELEASE_DELAY_MS = 150;

export interface UseSeekDragOptions {
  audio: AudioController;
  progressBarRef: RefObject<HTMLDivElement | null>;
  progressFillRef: RefObject<HTMLDivElement | null>;
  currentTimeTextRef: RefObject<HTMLSpanElement | null>;
  bufferFillRef: RefObject<HTMLDivElement | null>;
  playheadRef: RefObject<number>;
  durationRef: RefObject<number>;
  isDraggingRef: RefObject<boolean>;
  duration: number;
  setFillWidth: (percent: number) => void;
}

export function useSeekDrag({
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
}: UseSeekDragOptions): {
  isDragging: boolean;
  handlePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
} {
  // Render mirror of isDraggingRef: the ref stays the closure-safe source of
  // truth for the timeupdate guard; this state exists only to re-render the
  // thumb on pointerdown/commit (refs never trigger renders).
  const [isDragging, setIsDragging] = useState(false);

  // Handlers registered on `window` by handlePointerDown are mirrored into
  // refs so the unmount cleanup below can remove them even when the component
  // unmounts mid-drag — otherwise the listeners would leak and keep firing
  // setState on the unmounted component. No-op initials make removal of a
  // never-registered handler safe (removeEventListener is a no-op then).
  const pointerMoveRef = useRef<(e: PointerEvent) => void>(() => {});
  const pointerUpRef = useRef<(e: PointerEvent) => void>(() => {});
  const pointerCancelRef = useRef<(e: PointerEvent) => void>(() => {});

  // Unmount safety net: if the component unmounts mid-drag (view closed /
  // track switched while dragging), the window listeners added by
  // handlePointerDown would otherwise never be removed.
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", pointerMoveRef.current);
      window.removeEventListener("pointerup", pointerUpRef.current);
      window.removeEventListener("pointercancel", pointerCancelRef.current);
    },
    [],
  );

  // Drag-to-seek: pointer capture on the bar, clamped percent -> time math,
  // commit on pointerup/cancel (seek + immediate buffer redraw), and a small
  // release delay so stale in-flight timeupdate events cannot jump the thumb.
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Single-owner drag: the window listeners below receive events from EVERY
    // pointer, so an additional finger landing mid-drag must not register a
    // second parallel listener set (it would overwrite the unmount-cleanup
    // refs and let either lift commit the other finger's seek). While a drag
    // is live every new pointerdown is ignored wholesale; move/up/cancel act
    // only on the owning pointerId captured here. (MDN PointerEvent.isPrimary:
    // there is one primary pointer per pointerType — touch + mouse can both
    // be primary at once — so an active-drag guard, not isPrimary alone, is
    // what serializes drags.)
    if (isDraggingRef.current) return;
    const ownerPointerId = e.pointerId;
    if (!progressBarRef.current || duration === 0) return;
    try {
      progressBarRef.current.setPointerCapture(e.pointerId);
    } catch (err) {
      void captureError({
        level: "warn",
        source: SEEK_BAR_MODULE,
        message: `set-pointer-capture-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const bounds = progressBarRef.current.getBoundingClientRect();
    const updateTime = (clientX: number) => {
      const percent = clamp01((clientX - bounds.left) / bounds.width);
      const newTime = percent * (durationRef.current || duration);
      if (progressFillRef.current) setFillWidth(percent * 100);
      if (currentTimeTextRef.current)
        currentTimeTextRef.current.textContent = formatTime(newTime);
      playheadRef.current = newTime;
      return newTime;
    };

    // Recovery for a rejected native seek: put the fill, clock and UI
    // playhead back on the engine's real position so the bar never keeps
    // lying about where playback is.
    const restoreToEngineTime = () => {
      const realTime = audio.getCurrentTime();
      playheadRef.current = realTime;
      if (progressFillRef.current) {
        const dur = durationRef.current || duration;
        setFillWidth(clamp01(dur > 0 ? realTime / dur : 0) * 100);
      }
      if (currentTimeTextRef.current)
        currentTimeTextRef.current.textContent = formatTime(realTime);
      updateBufferBar(
        bufferFillRef.current,
        audio.getBuffered(),
        playheadRef.current,
      );
    };

    isDraggingRef.current = true;
    setIsDragging(true);
    updateTime(e.clientX);

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== ownerPointerId) return;
      updateTime(moveEvent.clientX);
    };
    const commit = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== ownerPointerId) return;
      // Desktop AudioController.seek is sync void, but the engine contract
      // allows promise-returning implementations (android native bridge) —
      // widen the engine type so TS cannot narrow the union to never.
      const promiseSeekAudio = audio as unknown as {
        seek: (time: number) => Promise<void> | undefined;
      };
      const seekResult = promiseSeekAudio.seek(updateTime(upEvent.clientX));
      // A promise-returning engine (e.g. native audio bridges) rethrows after
      // reporting, so a bare fire-and-forget surfaces as an unhandled
      // rejection and strands fill/thumb/text at the failed target. Desktop
      // AudioController.seek is sync void — only promise engines get the
      // recovery path: snap the UI back to the engine's real position right
      // away (a paused engine may never emit another timeupdate), then log
      // warn-level context. Error detail is plugin text, sanitized downstream.
      if (seekResult && typeof seekResult.catch === "function") {
        seekResult.catch((err: unknown) => {
          restoreToEngineTime();
          void captureError({
            level: "warn",
            source: SEEK_BAR_MODULE,
            message: `seek-failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
      }
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

    pointerMoveRef.current = onMove;
    pointerUpRef.current = onUp;
    pointerCancelRef.current = onCancel;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  return { isDragging, handlePointerDown };
}
