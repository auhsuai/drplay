import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { describeError } from "../lib/mpvProtocol";
import { captureError } from "../utils/errorLog";

export const CURSOR_IDLE_HIDE_MS = 2000;

export interface UseAutoHideCursorParams {
  /** Cursor auto-hide is active only while the NowPlaying video overlay is open. */
  enabled: boolean;
  /** Suspends hiding while a menu/dialog is open. */
  suspended: boolean;
}

export interface UseAutoHideCursorResult {
  /** Reveal the cursor and restart the idle countdown (stable identity). */
  revealCursor: () => void;
}

const CURSOR_HIDDEN_CLASS = "drplay-cursor-hidden";

export function useAutoHideCursor({
  enabled,
  suspended,
}: UseAutoHideCursorParams): UseAutoHideCursorResult {
  const enabledRef = useRef(enabled);
  const suspendedRef = useRef(suspended);
  const desiredVisibleRef = useRef(true);
  const visibilityRequestRef = useRef(0);
  const hideTimerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    suspendedRef.current = suspended;
  }, [suspended]);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const applyVisibility = useCallback((visible: boolean) => {
    // Keep the CSS state in sync even for no-op native calls.
    document.documentElement.classList.toggle(CURSOR_HIDDEN_CLASS, !visible);

    if (desiredVisibleRef.current === visible) return;

    const previousVisible = desiredVisibleRef.current;
    desiredVisibleRef.current = visible;
    const requestId = ++visibilityRequestRef.current;

    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch (e: unknown) {
      if (requestId !== visibilityRequestRef.current) return;
      void captureError({
        level: "warn",
        source: "useAutoHideCursor",
        message: `set-cursor-visible-failed: ${describeError(e)}`,
        kind: "set-cursor-visible-failed",
      });
      desiredVisibleRef.current = previousVisible;
      document.documentElement.classList.toggle(
        CURSOR_HIDDEN_CLASS,
        !previousVisible,
      );
      return;
    }

    void win.setCursorVisible(visible).then(
      () => {
        // Success: a newer request supersedes this one; do nothing stale.
      },
      (e: unknown) => {
        if (requestId !== visibilityRequestRef.current) return;
        void captureError({
          level: "warn",
          source: "useAutoHideCursor",
          message: `set-cursor-visible-failed: ${describeError(e)}`,
          kind: "set-cursor-visible-failed",
        });
        desiredVisibleRef.current = previousVisible;
        document.documentElement.classList.toggle(
          CURSOR_HIDDEN_CLASS,
          !previousVisible,
        );
      },
    );
  }, []);

  const armTimer = useCallback(() => {
    clearHideTimer();
    if (!enabledRef.current || suspendedRef.current) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      applyVisibility(false);
    }, CURSOR_IDLE_HIDE_MS);
  }, [clearHideTimer, applyVisibility]);

  const revealCursor = useCallback(() => {
    applyVisibility(true);
    if (enabledRef.current) armTimer();
  }, [applyVisibility, armTimer]);

  // enabled transitions
  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      clearHideTimer();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      applyVisibility(true);
      return;
    }
    applyVisibility(true);
    if (!suspendedRef.current) armTimer();
    return () => {
      clearHideTimer();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      applyVisibility(true);
    };
  }, [enabled, clearHideTimer, applyVisibility, armTimer]);

  // suspended transitions
  useEffect(() => {
    suspendedRef.current = suspended;
    if (!enabled) return;
    if (suspended) {
      clearHideTimer();
      applyVisibility(true);
    } else {
      applyVisibility(true);
      armTimer();
    }
  }, [suspended, enabled, clearHideTimer, applyVisibility, armTimer]);

  // pointer activity (attached only while enabled)
  useEffect(() => {
    if (!enabled) return;

    const onActivity = (): void => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        revealCursor();
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
  }, [enabled, revealCursor, clearHideTimer]);

  // window blur/focus
  useEffect(() => {
    if (!enabled) return;

    const onBlur = (): void => {
      clearHideTimer();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      applyVisibility(true);
    };
    const onFocus = (): void => {
      if (!enabledRef.current) return;
      applyVisibility(true);
      if (!suspendedRef.current) armTimer();
    };

    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, clearHideTimer, applyVisibility, armTimer]);

  return { revealCursor };
}
