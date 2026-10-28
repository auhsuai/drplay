import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { captureError } from "../../utils/errorLog";
import { clamp01 } from "./seekMath";

const PIP_SEEK_BAR_MODULE = "PipSeekBar";
const DRAG_RELEASE_DELAY_MS = 150;
/** Failsafe: a drag with no move for this long auto-clears the guard. */
const DRAG_HARD_TIMEOUT_MS = 2000;

/**
 * Options for the PiP drag-to-seek session.
 *
 * Deliberately NOT parameterised barrel/buffer element refs or a fill writer:
 * the PiP window has no audio engine, so the drag never reads engine state and
 * never paints the rail itself. `onDraftTime` is the ONE UI write point (the
 * component turns the drafted seconds into fill width + clock text), which
 * keeps a single source of truth instead of two DOM writers racing on every
 * pointermove — the same reason SeekBar funnels its writes through
 * `setFillWidth`, except the callback lives one layer up here.
 */
export interface UsePipSeekDragOptions {
  progressBarRef: RefObject<HTMLDivElement | null>;
  /** UI playhead mirror. Written BEFORE `onDraftTime` so the component's fill
   *  write (which answers aria-valuetext from this ref) matches the width it is
   *  writing — the exact ordering useSeekDrag documents. */
  playheadRef: RefObject<number>;
  /** Latest duration for the drag math: the window listeners created on
   *  pointerdown outlive the render closure, so a mid-drag duration change must
   *  re-scale the drag instead of using the value captured at pointerdown. */
  durationRef: RefObject<number>;
  /** Closure-safe drag guard shared with the component's prop-sync effect. */
  isDraggingRef: RefObject<boolean>;
  duration: number;
  /** ended / errored / unknown duration: the rail must not start a session. */
  disabled: boolean;
  onDraftTime: (time: number) => void;
  onCommit: (time: number) => void;
}

export function usePipSeekDrag({
  progressBarRef,
  playheadRef,
  durationRef,
  isDraggingRef,
  duration,
  disabled,
  onDraftTime,
  onCommit,
}: UsePipSeekDragOptions): {
  isDragging: boolean;
  handlePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
} {
  // Render mirror of isDraggingRef: the ref stays the closure-safe source of
  // truth for the prop-sync guard; this state exists only to re-render the
  // thumb and re-sync after the release window (refs never trigger renders).
  const [isDragging, setIsDragging] = useState(false);

  // Window handlers registered by handlePointerDown are mirrored into refs so
  // the unmount cleanup can remove them even when the component unmounts
  // mid-drag — otherwise the listeners leak and keep firing setState on the
  // unmounted component. No-op initials make removal of a never-registered
  // handler safe.
  const pointerMoveRef = useRef<(e: PointerEvent) => void>(() => {});
  const pointerUpRef = useRef<(e: PointerEvent) => void>(() => {});
  const pointerCancelRef = useRef<(e: PointerEvent) => void>(() => {});
  const blurRef = useRef<() => void>(() => {});
  const lostCaptureRef = useRef<() => void>(() => {});
  const hardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unmount safety net: closing the PiP window mid-drag would otherwise leave
  // window listeners and timers live after the component is gone.
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", pointerMoveRef.current);
      window.removeEventListener("pointerup", pointerUpRef.current);
      window.removeEventListener("pointercancel", pointerCancelRef.current);
      window.removeEventListener("blur", blurRef.current);
      progressBarRef.current?.removeEventListener(
        "lostpointercapture",
        lostCaptureRef.current,
      );
      if (hardTimerRef.current !== null) {
        clearTimeout(hardTimerRef.current);
        hardTimerRef.current = null;
      }
      if (releaseTimerRef.current !== null) {
        clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
    },
    [progressBarRef],
  );

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Single-owner drag: the window listeners below receive events from EVERY
    // pointer, so an additional finger landing mid-drag must not register a
    // second parallel listener set (it would overwrite the cleanup refs and let
    // either lift commit the other finger's seek). While a drag is live every
    // new pointerdown is ignored wholesale; move/up/cancel act only on the
    // owning pointerId captured here. `isPrimary` alone is not enough: touch
    // and mouse can both be primary at once, so the active-drag guard is what
    // serializes them.
    if (disabled || isDraggingRef.current) return;
    const ownerPointerId = e.pointerId;
    if (!progressBarRef.current || !(duration > 0)) return;
    try {
      progressBarRef.current.setPointerCapture(e.pointerId);
    } catch (err) {
      // Capture is an optimization (keeps events flowing over the video
      // surface), not a gate: report it and keep dragging.
      void captureError({
        level: "warn",
        source: PIP_SEEK_BAR_MODULE,
        message: `set-pointer-capture-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const bounds = progressBarRef.current.getBoundingClientRect();
    const updateTime = (clientX: number): number => {
      // Degenerate geometry (window not laid out / zero-width rail): dividing by
      // bounds.width would yield Infinity or NaN, i.e. a garbage seek. Same
      // guard useSeekHover.ts applies on hover.
      if (bounds.width <= 0) return playheadRef.current;
      const percent = clamp01((clientX - bounds.left) / bounds.width);
      const newTime = percent * (durationRef.current || duration);
      // Playhead first: the fill write reads it for aria-valuetext.
      playheadRef.current = newTime;
      onDraftTime(newTime);
      return newTime;
    };

    isDraggingRef.current = true;
    setIsDragging(true);
    updateTime(e.clientX);

    // Session teardown contract: commit() is the happy path (seek + 150ms
    // stale-flush window). Everything else — lostpointercapture, window blur,
    // or DRAG_HARD_TIMEOUT_MS of silence after the last move — funnels through
    // failsafeClear(), which drops the guard IMMEDIATELY so the bar unfreezes
    // and never sends a seek the user did not finish. `sessionDone` makes every
    // clear path idempotent and keeps the trailing lostpointercapture (fired by
    // the browser after a normal pointerup) from disturbing the delayed clear.
    let sessionDone = false;

    const armHardTimeout = () => {
      if (hardTimerRef.current !== null) clearTimeout(hardTimerRef.current);
      hardTimerRef.current = setTimeout(() => {
        hardTimerRef.current = null;
        failsafeClear();
      }, DRAG_HARD_TIMEOUT_MS);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== ownerPointerId) return;
      armHardTimeout();
      updateTime(moveEvent.clientX);
    };
    const onUp = (upEvent: PointerEvent) => {
      commit(upEvent);
    };
    const onCancel = (cancelEvent: PointerEvent) => {
      commit(cancelEvent);
    };
    const onBlur = () => {
      failsafeClear();
    };
    const onLostCapture = () => {
      failsafeClear();
    };
    const detachSessionListeners = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      progressBarRef.current?.removeEventListener(
        "lostpointercapture",
        onLostCapture,
      );
    };
    const failsafeClear = () => {
      if (sessionDone) return;
      sessionDone = true;
      if (hardTimerRef.current !== null) {
        clearTimeout(hardTimerRef.current);
        hardTimerRef.current = null;
      }
      detachSessionListeners();
      isDraggingRef.current = false;
      setIsDragging(false);
    };
    const commit = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== ownerPointerId) return;
      sessionDone = true;
      if (hardTimerRef.current !== null) {
        clearTimeout(hardTimerRef.current);
        hardTimerRef.current = null;
      }
      detachSessionListeners();
      // A degenerate-width session (see updateTime guard) must not send a
      // no-op-but-real seek over IPC either.
      if (bounds.width > 0) onCommit(updateTime(upEvent.clientX));
      // Keep the guard up briefly: the main window answers the seek with a new
      // pip-state payload that still carries the pre-seek currentTime (the
      // 250ms publisher can beat the engine's timeupdate), and letting that
      // land on the fill would snap the thumb back under the user's finger.
      releaseTimerRef.current = setTimeout(() => {
        releaseTimerRef.current = null;
        isDraggingRef.current = false;
        setIsDragging(false);
      }, DRAG_RELEASE_DELAY_MS);
    };

    pointerMoveRef.current = onMove;
    pointerUpRef.current = onUp;
    pointerCancelRef.current = onCancel;
    blurRef.current = onBlur;
    lostCaptureRef.current = onLostCapture;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);
    progressBarRef.current.addEventListener(
      "lostpointercapture",
      onLostCapture,
    );
    armHardTimeout();
  };

  return { isDragging, handlePointerDown };
}
