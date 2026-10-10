import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Inactivity window before the fullscreen player bar hides itself. Named
 * constant (Luật 4): the ONLY place a fullscreen-chrome delay is written down.
 */
export const FULLSCREEN_CHROME_HIDE_MS = 3000;

export interface FullscreenChrome {
  /** Whether the controls should be painted. */
  chromeVisible: boolean;
  /** User activity: show + restart the countdown. */
  revealChrome: () => void;
  /** Suspends the auto-hide while a menu is open; closing resumes a fresh count. */
  setMenuOpen: (open: boolean) => void;
}

export interface UseFullscreenChromeParams {
  /**
   * Auto-hide applies ONLY here. Outside fullscreen the windowed layout is
   * unchanged (the bar is a layout row and always painted), so this hook is
   * inert and attaches no listeners at all.
   */
  isFullscreen: boolean;
}

/**
 * The SINGLE owner of the fullscreen player-bar visibility policy: one state,
 * one timer. App owns it because App owns `isPlayerFullscreen` and the player
 * command context, so the keyboard path and the window-fullscreen path reach
 * the same instance.
 *
 * Why it exists at all: in fullscreen the bar floats OVER the video, so it has
 * to get out of the way or the picture is permanently covered.
 *
 * Invariants this enforces:
 *  - ONE timer, always cleared before a new one is armed (no racing timers
 *    across fullscreen transitions).
 *  - The hide runs only in fullscreen, so the windowed layout is untouched.
 *  - A menu suspends it; closing the menu restarts a fresh full countdown
 *    (never resumes the remainder of a stale one).
 *  - Playback state is deliberately NOT a term: a paused video must not pin
 *    the controls open — the inactivity policy is the same for both.
 *  - Pointer activity is coalesced through ONE rAF, so a 50-event mouse sweep
 *    produces at most one state update, and the listener exists only while
 *    fullscreen (enter/exit/unmount all leave zero listeners and zero timers).
 */
export function useFullscreenChrome({
  isFullscreen,
}: UseFullscreenChromeParams): FullscreenChrome {
  // The state is the NEGATIVE ("hidden") on purpose. The windowed layout must
  // show the bar unconditionally, so `chromeVisible` is DERIVED:
  // not fullscreen -> always visible, no state write needed on exit. That
  // keeps the exit path free of a cascading setState and makes the invariant
  // impossible to violate.
  const [hidden, setHidden] = useState(false);
  const chromeVisible = !isFullscreen || !hidden;

  // Refs, not state, for everything a stable callback must read: `revealChrome`
  // and `setMenuOpen` are handed to React event props and to the command
  // context, so their identity must never change.
  const hideTimerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const menuOpenRef = useRef(false);
  const isFullscreenRef = useRef(isFullscreen);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const startHideTimer = useCallback(() => {
    clearHideTimer();
    // Suspended outside fullscreen (nothing to hide in the windowed layout)
    // and while a menu is up (hiding under an open menu strands the user).
    if (!isFullscreenRef.current || menuOpenRef.current) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setHidden(true);
    }, FULLSCREEN_CHROME_HIDE_MS);
  }, [clearHideTimer]);

  const revealChrome = useCallback(() => {
    setHidden(false);
    startHideTimer();
  }, [startHideTimer]);

  const setMenuOpen = useCallback(
    (open: boolean) => {
      menuOpenRef.current = open;
      if (open) {
        clearHideTimer();
        setHidden(false);
        return;
      }
      // Fresh full countdown after the menu closes, never the remainder.
      startHideTimer();
    },
    [clearHideTimer, startHideTimer],
  );

  // Mirror the props the stable callbacks read into refs, in an effect (a ref
  // write during render is not allowed by the compiler lint rules). Both
  // callbacks only ever run from an event handler or a timer — i.e. after
  // commit — so the mirror is never stale when they read it.
  useEffect(() => {
    isFullscreenRef.current = isFullscreen;
  }, [isFullscreen]);

  // Reset the hidden flag on the fullscreen ENTRY, using React's documented
  // "adjust state while rendering" pattern (state, not refs, so the compiler
  // lint rules accept it): entering fullscreen must always start from a visible
  // bar. Doing it in an effect would instead cascade an extra render and would
  // show one frame of a stale hidden bar.
  const [prevIsFullscreen, setPrevIsFullscreen] = useState(isFullscreen);
  if (prevIsFullscreen !== isFullscreen) {
    setPrevIsFullscreen(isFullscreen);
    if (isFullscreen) setHidden(false);
  }

  // Fullscreen transitions. Entering arms the countdown; leaving cancels it
  // (and `chromeVisible` is already derived back to true). Idempotent: the
  // cleanup runs on every change AND on unmount, so repeated toggles cannot
  // accumulate timers.
  useEffect(() => {
    if (!isFullscreen) {
      clearHideTimer();
      return;
    }
    startHideTimer();
    return clearHideTimer;
  }, [isFullscreen, clearHideTimer, startHideTimer]);

  // Pointer activity. Attached ONLY while fullscreen — outside it the hook has
  // no listeners at all, and the rAF guard means a full-window sweep costs one
  // state update per frame instead of one per event.
  useEffect(() => {
    if (!isFullscreen) return;

    const onActivity = (): void => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        revealChrome();
      });
    };

    window.addEventListener("pointermove", onActivity);
    window.addEventListener("pointerdown", onActivity);
    return () => {
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      clearHideTimer();
    };
  }, [isFullscreen, revealChrome, clearHideTimer]);

  return { chromeVisible, revealChrome, setMenuOpen };
}
