import { useEffect, useRef, useState } from 'react';
import {
  PREFETCH_MARGIN_SLOW,
  PREFETCH_MARGIN_MED,
  PREFETCH_MARGIN_FAST,
  VELOCITY_FAST_THRESHOLD,
  VELOCITY_MED_THRESHOLD,
} from './useCoverWindowing';

function marginForVelocity(velocity: number): number {
  if (velocity > VELOCITY_FAST_THRESHOLD) return PREFETCH_MARGIN_FAST;
  if (velocity > VELOCITY_MED_THRESHOLD) return PREFETCH_MARGIN_MED;
  return PREFETCH_MARGIN_SLOW;
}

/**
 * Tracks scroll velocity (px/frame) on the given scroll element and derives an
 * adaptive prefetch margin (3/6/12) for cover windowing.
 *
 * - Uses rAF-throttled scroll handling: scroll events set a pending flag, the
 *   rAF tick measures delta between scrollTop samples and updates velocity.
 * - Listener + rAF are cleaned up on unmount or when the ref target changes.
 */
export function useScrollVelocity(
  scrollElementRef: React.RefObject<HTMLElement | null>,
): { velocity: number; dynamicMargin: number } {
  const [velocity, setVelocity] = useState(0);
  const [dynamicMargin, setDynamicMargin] = useState(PREFETCH_MARGIN_SLOW);

  const lastScrollTopRef = useRef(0);
  const lastTimeRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    const el = scrollElementRef.current;
    if (!el) return;

    lastScrollTopRef.current = el.scrollTop;
    lastTimeRef.current = 0;

    const measure = (now: number) => {
      rafIdRef.current = null;
      pendingRef.current = false;
      const currentTop = el.scrollTop;
      const delta = Math.abs(currentTop - lastScrollTopRef.current);
      lastScrollTopRef.current = currentTop;

      // velocity in px/frame (per rAF ~16ms). Use delta directly.
      const sampled = delta;
      const margin = marginForVelocity(sampled);
      setVelocity(sampled);
      setDynamicMargin(margin);
      void now;
    };

    const onScroll = () => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      rafIdRef.current = requestAnimationFrame(measure);
    };

    el.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      el.removeEventListener('scroll', onScroll);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      pendingRef.current = false;
      setVelocity(0);
      setDynamicMargin(PREFETCH_MARGIN_SLOW);
    };
  }, [scrollElementRef]);

  return { velocity, dynamicMargin };
}
