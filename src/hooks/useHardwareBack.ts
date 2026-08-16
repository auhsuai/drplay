import { useEffect } from "react";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { captureError } from "../utils/errorLog";
import { IS_MOBILE } from "../utils/platform";

type BackHandler = () => boolean;
const handlers: BackHandler[] = [];

// Task 9 mobile-polish: Android "Press back again to exit" convention — 2000ms
// is the standard double-back window (geeksforgeeks/Android convention).
export const DOUBLE_BACK_EXIT_MS = 2000;

export interface DoubleBackExitOptions {
  windowMs: number;
  onArm: () => void;
  onExit: () => void;
}

export interface DoubleBackExitController {
  /** Returns true when the press armed the window (caller re-arms the history
   *  intercept); false when the exit path was taken (nothing to re-arm). */
  handleBack: () => boolean;
  /** Clears the pending window (unmount/cleanup — prevents timer leaks). */
  disarm: () => void;
}

export function createDoubleBackExit({
  windowMs,
  onArm,
  onExit,
}: DoubleBackExitOptions): DoubleBackExitController {
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    if (armTimer !== undefined) {
      clearTimeout(armTimer);
      armTimer = undefined;
    }
  };

  const handleBack = (): boolean => {
    if (armTimer !== undefined) {
      disarm();
      onExit();
      return false;
    }
    onArm();
    armTimer = setTimeout(disarm, windowMs);
    return true;
  };

  return { handleBack, disarm };
}

export function useHardwareBack(handler: BackHandler, isActive: boolean) {
  useEffect(() => {
    if (isActive) {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx > -1) handlers.splice(idx, 1);
      };
    }
  }, [handler, isActive]);
}

export function handleGlobalBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) {
    const handler = handlers[i];
    if (handler && handler()) {
      return true;
    }
  }
  return false;
}

// Task 9 mobile-polish upgrade: Android hardware back now flows through the
// official Tauri onBackButtonPress event (2.9+) instead of the History-API
// popstate hack. The handler runs the whole mobile back chain (registered
// overlay stack → NowPlaying → tab → Home → double-back-to-exit) and the
// returned unregister tears the native listener down on cleanup. Desktop
// (IS_MOBILE=false) must NEVER touch the Tauri API — it is a no-op there.
export function registerNativeBackHandler(handler: () => void): () => void {
  if (!IS_MOBILE) {
    return () => {};
  }

  let disposed = false;
  let unregister: (() => void) | undefined;

  void onBackButtonPress(() => {
    handler();
  })
    .then((listener) => {
      if (disposed) {
        // Cleanup won the race against the async registration: unregister the
        // native listener immediately so no leak survives an unmount.
        void listener.unregister();
      } else {
        unregister = () => void listener.unregister();
      }
    })
    .catch((err: unknown) => {
      void captureError({
        level: "warn",
        source: "registerNativeBackHandler",
        message: `onBackButtonPress-registration-failed:${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });

  return () => {
    disposed = true;
    unregister?.();
  };
}
