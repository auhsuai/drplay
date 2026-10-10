// @vitest-environment jsdom
import { useCallback, useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  sameRect,
  setVideoHostRect,
  setVideoHostVisible,
  toPhysicalRect,
  type PhysicalRect,
} from "../../../lib/videoHost";

/** Longest transition in the app is `duration-1000`; the tracker never runs
 *  longer than this even if its end event is lost. */
const TRANSITION_TRACK_CAP_MS = 1400;

/** S4 (libmpv composition plumbing): marker class toggled on <html> exactly
 *  while the native host is visible. The DComp video visual composites BELOW
 *  the webview (VIDEO-RENDER-ARCHITECTURE-ADR), so every full-viewport layer
 *  the page paints above it (html/body, app root, Now Playing overlay) must
 *  drop its background then — the App.css rules key on this class. This
 *  component is the only toggler because it owns host visibility. */
const HOST_VISIBLE_ROOT_CLASS = "drplay-host-visible";

/** S4: custom properties carrying the host rect (CSS px, relative to <main>)
 *  that the player background layer clips its transparent hole with. Left
 *  unset they resolve to the layer's 0/0 corner => zero-size hole => opaque,
 *  which is the safe placeholder state before the first measurement. */
const HOLE_VARS = [
  "--drplay-hole-l",
  "--drplay-hole-t",
  "--drplay-hole-r",
  "--drplay-hole-b",
] as const;

/** S4: publish the host rect for the background layer's clip hole. The
 *  consumer is an absolutely-positioned child of <main>, so the coordinates
 *  are made relative to that box — the overlay slide translates the whole
 *  subtree, and a viewport-relative rect would drift by the slide offset
 *  while a main-relative one stays exact. */
function publishHoleRect(box: HTMLElement, rect: DOMRect): void {
  const main = box.closest("main");
  if (!main) return;
  const origin = main.getBoundingClientRect();
  const left = Math.max(0, rect.left - origin.left);
  const top = Math.max(0, rect.top - origin.top);
  const style = document.documentElement.style;
  style.setProperty(HOLE_VARS[0], `${String(left)}px`);
  style.setProperty(HOLE_VARS[1], `${String(top)}px`);
  style.setProperty(HOLE_VARS[2], `${String(left + rect.width)}px`);
  style.setProperty(HOLE_VARS[3], `${String(top + rect.height)}px`);
}

function clearHoleRect(): void {
  const style = document.documentElement.style;
  for (const name of HOLE_VARS) style.removeProperty(name);
}

interface VideoSurfaceProps {
  /**
   * Whether the native host should be SHOWN over this box. The surface itself
   * stays mounted whenever a track is loaded so the ResizeObserver keeps
   * tracking the box; only the host's visibility follows this flag.
   */
  active: boolean;
  /**
   * Player fullscreen (a refinement of the Now Playing overlay, never a second
   * surface): drop the `min(560px, 60vh)` cap so the video takes the space the
   * window actually has. The box keeps its `aspect-video`, so mpv still
   * letterboxes inside it exactly as before — only the box grew.
   */
  fullscreen?: boolean;
  /**
   * Fill the parent's box instead of the fixed 16:9 ladder (D3 media-player
   * layout): the Now Playing video mode owns a flexible area and puts its bar
   * outside it, so the surface takes exactly that area — no `aspect-video`
   * (spec §16), with square corners (rounded-none) in windowed and fullscreen
   * alike. Default `false` keeps every existing class for other callers.
   */
  fill?: boolean;
  /** Playback is running (paused is NOT loading — see the spinner condition). */
  isPlaying?: boolean;
  /** mpv's `paused-for-cache` is set (the engine buffering event). */
  isBuffering?: boolean;
  /** The pre-load intent window (track selected, stream not started yet). */
  isDownloading?: boolean;
  /** The current track failed; the app renders its error surface instead. */
  hasError?: boolean;
  /** mpv reported end-of-file for this track. */
  isEnded?: boolean;
  /**
   * The render thread has presented at least one frame of THIS media load
   * (`useVideoFirstFrame`). Until then the box paints solid opaque black over
   * the video rect: the DComp visual composites BELOW the webview, so painting
   * there is legal, and it is the only thing that can keep the (deliberately
   * transparent) page behind an empty video rect from showing through.
   */
  hasFirstFrame?: boolean;
}

/**
 * The placeholder React measures so the native video host can be positioned
 * over it (Slice 2 of VIDEO-EMBEDDING-ARCHITECTURE.md).
 *
 * It is deliberately NOT a <video> element: the pixels come from a Win32 child
 * HWND that Rust positions underneath. Because a native child always paints
 * ABOVE the WebView2 surface, nothing in React may overlap this box — which
 * the Now Playing layout guarantees structurally (title / controls / seekbar
 * all live BELOW it, as they already sat below the cover-art square).
 *
 * Layout reuses the cover-art container's design language verbatim (same
 * sizing ladder, rounded-2xl, same shadow, overflow-hidden) with ONE change:
 * `aspect-video` instead of `aspect-square`, because a 16:9 box is the natural
 * media-player shape and 16:9 is what mpv renders. A square box would
 * letterbox every video into a small centered strip. Letterboxing *inside* the
 * box stays mpv's job — no CSS crop/zoom here.
 */
export function VideoSurface({
  active,
  fullscreen = false,
  fill = false,
  isPlaying = false,
  isBuffering = false,
  isDownloading = false,
  hasError = false,
  isEnded = false,
  hasFirstFrame = false,
}: VideoSurfaceProps) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement | null>(null);
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
  }, []);

  const scheduleRect = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(sendRect);
  }, [sendRect]);

  // Visibility. Idempotent on the Rust side, and video -> video deliberately
  // sends nothing here at all: `active` does not change, so there is no
  // hide/show flicker and no re-acquire.
  useEffect(() => {
    setVideoHostVisible(active);
  }, [active]);

  // S4: mirror `active` onto <html> for the global transparency rules
  // (App.css). Same single owner as the visibility call above, so the class
  // can never disagree with what Rust has been told.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle(HOST_VISIBLE_ROOT_CLASS, active);
    return () => {
      root.classList.remove(HOST_VISIBLE_ROOT_CLASS);
    };
  }, [active]);

  // Unmount is its OWN transition, not a change of `active`: switching to an
  // audio track (or to no track) unmounts this surface while `active` was true,
  // and a bare unmount would otherwise leave the host painted over the
  // cover-art square. Hide exactly once, on the way out.
  useEffect(() => {
    return () => {
      setVideoHostVisible(false);
    };
  }, []);

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
  }, [scheduleRect, sendRect]);

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

  // The gradient + spinner is what the user sees between "video track
  // selected" and mpv's first present, and it sits behind the HWND the moment
  // that present lands. So the spinner must only be there while something is
  // ACTUALLY loading — otherwise, whenever the host is hidden (overlay closed,
  // error, ended) the user is left watching a spinner that means nothing.
  //
  // Same condition as the play button's spinner (NowPlayingControls): the
  // pre-load intent window, or buffering while playback is running. A paused
  // or failed or finished video is not loading and must not spin.
  const isLoading =
    !hasError && !isEnded && (isDownloading || (isBuffering && isPlaying));

  // Fill mode (D3): the parent already owns the space, so the box follows it
  // (`w-full h-full`) with square corners (rounded-none) — windowed and
  // fullscreen alike. Default mode keeps the cover-art ladder verbatim, with
  // `aspect-video` instead of `aspect-square`.
  const sizeClasses = fill
    ? "w-full h-full rounded-none"
    : `${
        fullscreen
          ? "w-full max-w-full max-h-full"
          : "w-[min(16rem,60vh)] md:w-[min(20rem,60vh)] lg:w-[min(480px,60vh)] xl:w-[min(560px,60vh)] max-w-full"
      } aspect-video h-auto rounded-2xl shadow-[0_12px_30px_rgba(0,0,0,0.15)] dark:shadow-[0_20px_40px_rgba(0,0,0,0.4)]`;

  return (
    // Measuring box. The rect synchroniser above is size-agnostic, so it
    // re-sends the new rect on the same rAF-coalesced path as any other
    // resize — fill mode only changes the class box.
    //
    // S4 + visual polish, three states and no in-between:
    //  * host hidden          -> the old placeholder gradient (unchanged).
    //  * host visible, NO
    //    frame yet           -> solid opaque black. The DComp visual composites
    //                             BELOW the webview, so this paint is legal and
    //                             it is what hides the transparent page (and any
    //                             stale frame of the previous item) behind an
    //                             empty video rect.
    //  * host visible, frame
    //    presented           -> paint NOTHING; the DComp visual shows through.
    <div
      ref={boxRef}
      data-testid="video-surface"
      className={`${sizeClasses} overflow-hidden transition-all duration-700 ${
        !active
          ? "bg-gradient-to-br from-brand-primary/10 to-[#34A853]/10"
          : hasFirstFrame
            ? ""
            : "bg-black"
      } flex items-center justify-center`}
    >
      {isLoading && (
        <>
          <span className="sr-only" role="status">
            {t("loading")}
          </span>
          <LoaderCircle
            aria-hidden="true"
            className="w-10 h-10 animate-spin text-brand-text stroke-[1.5]"
          />
        </>
      )}
    </div>
  );
}
