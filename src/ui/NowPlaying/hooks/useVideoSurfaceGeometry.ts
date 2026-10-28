import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import {
  getVideoHostOwner,
  sameRect,
  setVideoHostRect,
  toPhysicalRect,
  type PhysicalRect,
} from "../../../lib/videoHost";
import { clearHoleRect, publishHoleRect } from "../components/videoHostHole";

/** Longest transition in the app is `duration-1000`; the tracker never runs
 *  longer than this even if its end event is lost. */
export const TRANSITION_TRACK_CAP_MS = 1400;

export interface UseVideoSurfaceGeometryOptions {
  /** Which window owns the native surface; must equal getVideoHostOwner() to act. */
  owner: "main" | "pip";
  /** Native host currently shown; gates the per-frame transition tracker. */
  active: boolean;
}

export interface VideoSurfaceGeometry {
  /** Drop the physical-rect dedupe and measure now (owner changed / retarget). */
  resendRect: () => void;
}

/**
 * Owns the ONE rect measurement pipeline for the native video host: the
 * rAF-coalesced send, the ResizeObserver / window resize / DPI triggers and the
 * per-frame transition tracker. The component only supplies its box ref and may
 * only ask for a re-measure via `resendRect`, so there is never a second
 * scheduler or listener.
 */
export function useVideoSurfaceGeometry(
  boxRef: RefObject<HTMLDivElement | null>,
  { owner, active }: UseVideoSurfaceGeometryOptions,
): VideoSurfaceGeometry {
  const lastSentRef = useRef<PhysicalRect | null>(null);
  // One rAF is in flight at most; every trigger coalesces into it, so a
  // maximize drag or a cascade of resize events can never turn into a stream
  // of IPC calls. rAF (not a debounce) because the value we need is a LAYOUT
  // read: it must happen after style/layout for the frame is settled.
  const frameRef = useRef<number | null>(null);

  const sendRect = useCallback(() => {
    frameRef.current = null;
    const box = boxRef.current;
    if (!box) return;
    if (owner !== getVideoHostOwner()) return;
    const domRect = box.getBoundingClientRect();
    // S4: the CSS hole follows every measured position, even one the physical
    // dedupe below would drop (e.g. a sub-pixel move).
    publishHoleRect(box, domRect);
    const rect = toPhysicalRect(domRect, window.devicePixelRatio);
    // A collapsed rect (minimized window, pre-layout read) is not a window:
    // skip it rather than asking Rust to clamp a zero size.
    if (rect === null) return;
    if (sameRect(lastSentRef.current, rect)) return;
    lastSentRef.current = rect;
    setVideoHostRect(rect);
  }, [boxRef, owner]);

  const scheduleRect = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(sendRect);
  }, [sendRect]);

  /** Owner changed / retargeted: the old rect may be identical in physical
   *  pixels but belong to another window, so drop the dedupe and measure. */
  const resendRect = useCallback(() => {
    lastSentRef.current = null;
    sendRect();
  }, [sendRect]);

  // Rect triggers. Every path a box can move or a scale can change:
  //  1. first mount with a real size (also the react-commit measure)
  //  2. the element resizing  -> ResizeObserver
  //  3. window resize / maximize / restore / minimize -> resize event
  //     (minimize collapses the box, which sendRect drops; restore resizes it)
  //  4. devicePixelRatio changing (DPI / monitor move). A ResizeObserver does
  //     NOT fire on a pure scale change, so it needs its own trigger:
  //     matchMedia on the RESOLVED ratio (`(resolution: 1.5dppx)`) flips
  //     exactly when the DPR changes, and we re-arm it after each change.
  //     Tauri's own `onScaleChanged` event exists but is not reachable from
  //     this component's dependency set, and matchMedia needs no IPC.
  useEffect(() => {
    sendRect();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(scheduleRect);
      if (boxRef.current) observer.observe(boxRef.current);
    }

    const onResize = (): void => {
      scheduleRect();
    };
    window.addEventListener("resize", onResize);

    let mql: MediaQueryList | null = null;
    const onScaleChange = (): void => {
      scheduleRect();
      armScaleQuery();
    };
    const armScaleQuery = (): void => {
      // jsdom does not implement matchMedia (verified on jsdom 29) — the same
      // guard useResponsiveItems.ts uses. Without it the surface still syncs
      // on mount, resize and element-resize.
      if (typeof window.matchMedia !== "function") return;
      mql?.removeEventListener("change", onScaleChange);
      mql = window.matchMedia(
        `(resolution: ${String(window.devicePixelRatio)}dppx)`,
      );
      mql.addEventListener("change", onScaleChange);
    };
    armScaleQuery();

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
      mql?.removeEventListener("change", onScaleChange);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      // S4: no consumer survives this component, so the published hole would
      // only be stale state for a later mount.
      clearHoleRect();
    };
  }, [boxRef, scheduleRect, sendRect]);

  // Transform-based movement — the Now Playing overlay slides with
  // `translate-y` — changes the box's POSITION without changing its size, so
  // none of the triggers above fire: ResizeObserver reports layout size (not
  // transforms), no `resize`, no DPR change. Without this the host would keep
  // the rect from before the slide until some unrelated event.
  //
  // GATED ON `active`: while the host is hidden nothing is presented, the CSS
  // hole is not cut, and every frame of a collapse transition would cost two
  // forced layout reads, four root custom-property writes and an IPC for a
  // rect nobody consumes. Re-arming on `active` sends the current rect once on
  // the way back in, which covers a box that moved while hidden (and is a
  // no-op when it did not, because of the dedupe above).
  useEffect(() => {
    if (!active) return;
    sendRect();

    let rafId: number | null = null;
    let deadline = 0;
    const track = (): void => {
      rafId = null;
      sendRect();
      if (performance.now() >= deadline) {
        rafId = window.requestAnimationFrame(settle);
        return;
      }
      rafId = window.requestAnimationFrame(track);
    };
    // The frame AFTER the loop stopped. Stopping the loop is NOT the same as
    // having SENT the settled rect: the last in-loop frame can read a
    // mid-transition position (an end event cancels the remaining motion, so
    // the box only reaches its resting place on the frames that follow), and
    // the slide changed position without changing size — no ResizeObserver, no
    // resize, no DPI change — so no other trigger would ever correct it. The
    // host would stay parked at the intermediate rect, off-screen, until
    // something unrelated moved the box again (observed live: ~970px below the
    // surface after a fullscreen toggle). Reading one frame later guarantees
    // the browser has applied the final transform first.
    //
    // Exactly one such frame, never a poll: only `track`'s cap branch and the
    // end-event handler arm it, at most one frame is in flight, and it
    // re-enters the loop only when a new transition extended the deadline in
    // the meantime.
    const settle = (): void => {
      rafId = null;
      sendRect();
      if (performance.now() < deadline) {
        rafId = window.requestAnimationFrame(track);
      }
    };
    // Tailwind v4 emits `translate-y-*` as the CSS `translate` property (not
    // `transform`), so the event that matters here is propertyName
    // "translate" — verified against the live app's computed transition
    // property list: "transform, translate, scale, rotate".
    const isMovement = (e: TransitionEvent): boolean =>
      e.propertyName === "translate" ||
      e.propertyName === "transform" ||
      e.propertyName === "all";
    const onTransitionRun = (e: TransitionEvent): void => {
      if (!isMovement(e)) return;
      deadline = performance.now() + TRANSITION_TRACK_CAP_MS;
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(track);
    };
    const onTransitionEnd = (e: TransitionEvent): void => {
      if (!isMovement(e)) return;
      // Read the settled position on the next frame, then stop. The loop may
      // already have spent its cap, leaving NO frame in flight: setting the
      // deadline alone would arm nothing and the settled rect would never be
      // sent, so the settle read is armed here too (it is a no-op frame when a
      // frame is already pending — that one covers it).
      deadline = performance.now();
      if (rafId === null) rafId = window.requestAnimationFrame(settle);
    };
    window.addEventListener("transitionrun", onTransitionRun);
    window.addEventListener("transitionstart", onTransitionRun);
    window.addEventListener("transitionend", onTransitionEnd);
    window.addEventListener("transitioncancel", onTransitionEnd);
    return () => {
      window.removeEventListener("transitionrun", onTransitionRun);
      window.removeEventListener("transitionstart", onTransitionRun);
      window.removeEventListener("transitionend", onTransitionEnd);
      window.removeEventListener("transitioncancel", onTransitionEnd);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
  }, [active, sendRect]);

  return { resendRect };
}
