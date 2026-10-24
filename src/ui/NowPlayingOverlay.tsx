import { useLayoutEffect, useRef } from "react";
import { NowPlayingView } from "./NowPlaying/NowPlayingView";
import type { PlayMode, Track } from "../types";
import type { MenuSection } from "../player/menuModel";
import type { VideoMenuAnchor } from "../player/useVideoMenu";

interface NowPlayingOverlayProps {
  isOpen: boolean;
  currentTrack: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  playMode: PlayMode;
  onTogglePlayMode: () => void;
  onBack: () => void;
  token: string | null;
  isShellLocked: boolean;
  /** Player fullscreen — a refinement of this overlay, never a second surface. */
  isFullscreen?: boolean;
  onToggleFullscreen?: (() => void) | undefined;
  /** Video playerbar More button: open the DrPlay video menu (Slice 2). */
  onOpenPlayerMenu?:
    ((section: MenuSection, anchor: VideoMenuAnchor) => void) | undefined;
  /** Right-click on the video area opens the same menu at the pointer. */
  onOpenVideoMenuAt?: ((x: number, y: number) => void) | undefined;
  /** Fullscreen chrome visibility, owned by App's useFullscreenChrome. */
  chromeVisible?: boolean | undefined;
  /** Player activity inside the video area reveals the chrome. */
  onRevealChrome?: (() => void) | undefined;
}

export function NowPlayingOverlay({
  isOpen,
  currentTrack,
  isPlaying,
  onTogglePlay,
  onNextTrack,
  onPrevTrack,
  playMode,
  onTogglePlayMode,
  onBack,
  token,
  isShellLocked,
  isFullscreen = false,
  onToggleFullscreen,
  onOpenPlayerMenu,
  onOpenVideoMenuAt,
  chromeVisible,
  onRevealChrome,
}: NowPlayingOverlayProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const animRef = useRef<Animation | null>(null);
  const didMountRef = useRef(false);

  // WAAPI on purpose: the CSS `transition-[translate]` entering transition
  // proved unreliable in WebView2 — the class flip and the first paint could
  // coalesce, so opening appeared instantly while closing animated. An
  // explicit animation always runs, whatever the paint timing.
  //
  // ONE property: `translate` (Tailwind v4's `transition-transform` expands to
  // transform/translate/scale/rotate and `transition-all` takes geometry too;
  // animating anything else makes the video look resized under the page).
  // 280ms, open ease-in-out (settles softly) / close ease-in (leaves
  // accelerating — the panel is already off-screen when it lands).
  // Reduced motion: no animation at all, the resting classes own both states.
  //
  // `useLayoutEffect` (not `useEffect`) so the animation is installed BEFORE
  // the browser paints the class flip; otherwise the open frame would flash at
  // its final position for one frame before the slide starts.
  useLayoutEffect(() => {
    // The initial state is already correct in the resting className — do not
    // animate mounting (the ref is written here, in the effect, never during
    // render: `react-hooks/refs`).
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }

    const el = shellRef.current;
    if (!el) return;
    if (typeof el.animate !== "function") return;
    // jsdom does not implement matchMedia (same `typeof` guard as
    // useResponsiveItems), so tests can stub it and the app never crashes.
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    // Continue from wherever the panel actually is mid-flight (rapid toggle);
    // after the class flip the computed value is already the DESTINATION, so
    // only a live animation is a trustworthy source. Otherwise the resting
    // class of the OPPOSITE state is the start.
    const inFlight = animRef.current;
    const computedTranslate = inFlight ? getComputedStyle(el).translate : "";
    const from =
      inFlight && computedTranslate && computedTranslate !== "none"
        ? computedTranslate
        : isOpen
          ? "0 100%"
          : "0 0";
    const to = isOpen ? "0 0" : "0 100%";

    inFlight?.cancel();

    const anim = el.animate([{ translate: from }, { translate: to }], {
      duration: 280,
      easing: isOpen
        ? "cubic-bezier(0.4, 0, 0.2, 1)"
        : "cubic-bezier(0.4, 0, 1, 1)",
      fill: "both",
    });
    const release = () => {
      anim.cancel();
      if (animRef.current === anim) animRef.current = null;
    };
    anim.onfinish = release;
    anim.oncancel = release;
    animRef.current = anim;
  }, [isOpen]);

  useLayoutEffect(
    () => () => {
      animRef.current?.cancel();
      animRef.current = null;
    },
    [],
  );

  return (
    // drplay-host-clear (S4): redundant while NowPlayingView paints (it
    // always covers this shell), but must not paint over the host rect —
    // App.css drops it while the video host is visible.
    //
    // The resting classes are the end states (and the only fallback when the
    // Web Animations API is unavailable or reduced motion is requested). No
    // CSS transition classes: the slide is driven by the WAAPI effect above.
    <div
      ref={shellRef}
      aria-hidden={!isOpen}
      inert={!isOpen}
      className={`drplay-host-clear fixed inset-0 z-[9999] bg-white dark:bg-[#121212] flex flex-col ${
        isOpen ? "translate-y-0" : "translate-y-full pointer-events-none"
      }`}
    >
      <NowPlayingView
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        onTogglePlay={onTogglePlay}
        onNextTrack={onNextTrack}
        onPrevTrack={onPrevTrack}
        playMode={playMode}
        onTogglePlayMode={onTogglePlayMode}
        onBack={onBack}
        isOpen={isOpen}
        token={token}
        isShellLocked={isShellLocked}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
        onOpenPlayerMenu={onOpenPlayerMenu}
        onOpenVideoMenuAt={onOpenVideoMenuAt}
        chromeVisible={chromeVisible}
        onRevealChrome={onRevealChrome}
      />
    </div>
  );
}
