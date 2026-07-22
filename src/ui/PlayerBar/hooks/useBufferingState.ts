import { useRef, useEffect } from 'react';

// Minimum visible duration for the buffering spinner (hysteresis guard).
// A single `timeupdate`/`playing` tick on a flaky connection must not
// hide the spinner immediately only to show it again a few hundred ms later.
// `handleCanPlay` / pause / track change use `immediate: true` because they
// are definitive signals, not "a little data just arrived".
const MIN_BUFFERING_VISIBLE_MS = 400;

export interface BufferingStateAPI {
  isBufferingRef: React.MutableRefObject<boolean>;
  /** Show/hide the buffering spinner. Pass `{ immediate: true }` to skip the hysteresis guard. */
  applyBuffering: (v: boolean, opts?: { immediate?: boolean }) => void;
  /** Clear all pending buffering timers (delay, hide, stall watchdog). */
  clearBufferingTimers: () => void;
  bufferingDelayRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  stallWatchdogRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}

export function useBufferingState(
  setIsBuffering: React.Dispatch<React.SetStateAction<boolean>>,
): BufferingStateAPI {
  const isBufferingRef = useRef(false);
  const bufferingShownAtRef = useRef<number | null>(null);
  const bufferingDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideBufferingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyBuffering = (v: boolean, opts?: { immediate?: boolean }) => {
    if (hideBufferingTimeoutRef.current) {
      clearTimeout(hideBufferingTimeoutRef.current);
      hideBufferingTimeoutRef.current = null;
    }

    if (v) {
      if (isBufferingRef.current) return;
      isBufferingRef.current = true;
      bufferingShownAtRef.current = Date.now();
      setIsBuffering(true);
      return;
    }

    if (!isBufferingRef.current) return;
    const shownAt = bufferingShownAtRef.current;
    const elapsed = shownAt !== null ? Date.now() - shownAt : MIN_BUFFERING_VISIBLE_MS;

    if (opts?.immediate || elapsed >= MIN_BUFFERING_VISIBLE_MS) {
      isBufferingRef.current = false;
      bufferingShownAtRef.current = null;
      setIsBuffering(false);
    } else {
      const remaining = MIN_BUFFERING_VISIBLE_MS - elapsed;
      hideBufferingTimeoutRef.current = setTimeout(() => {
        hideBufferingTimeoutRef.current = null;
        isBufferingRef.current = false;
        bufferingShownAtRef.current = null;
        setIsBuffering(false);
      }, remaining);
    }
  };

  const clearBufferingTimers = () => {
    if (bufferingDelayRef.current) { clearTimeout(bufferingDelayRef.current); bufferingDelayRef.current = null; }
    if (hideBufferingTimeoutRef.current) { clearTimeout(hideBufferingTimeoutRef.current); hideBufferingTimeoutRef.current = null; }
    if (stallWatchdogRef.current) { clearTimeout(stallWatchdogRef.current); stallWatchdogRef.current = null; }
  };

  // Unmount cleanup
  useEffect(() => clearBufferingTimers, []);

  return { isBufferingRef, applyBuffering, clearBufferingTimers, bufferingDelayRef, stallWatchdogRef };
}
