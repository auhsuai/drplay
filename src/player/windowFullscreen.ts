import { getCurrentWindow } from "@tauri-apps/api/window";
import { describeError } from "../lib/mpvProtocol";
import { captureError } from "../utils/errorLog";
import { showErrorToast } from "../utils/simpleToast";

const LOGGER_SOURCE = "windowFullscreen";

/**
 * Real (OS/window) fullscreen for the player.
 *
 * Tauri v2's JS `Window` exposes `setFullscreen` / `isFullscreen` but NO
 * fullscreen-changed event (verified against node_modules/@tauri-apps/api
 * 2.11.1: the window events are onCloseRequested, onDragDropEvent,
 * onFocusChanged, onMoved, onResized, onScaleChanged, onThemeChanged only).
 * So the two-way sync is: React -> `setFullscreen`, and window -> React by
 * re-reading `isFullscreen()` on the events an actual fullscreen transition
 * produces (a resize, a focus change, a DPI change).
 *
 * Both directions are IPC into the OS, so both are try/caught, classified and
 * surfaced: a denied permission or a failed call must never take the renderer
 * down. Errors carry module + action only — never a token or any PII.
 */
export async function applyWindowFullscreen(
  fullscreen: boolean,
): Promise<boolean> {
  try {
    await getCurrentWindow().setFullscreen(fullscreen);
    return true;
  } catch (e: unknown) {
    const message = `fullscreen-${fullscreen ? "enter" : "exit"}-failed: ${describeError(e)}`;
    void captureError({
      level: "warn",
      source: LOGGER_SOURCE,
      message,
      kind: "window-fullscreen-failed",
    });
    showErrorToast("Fullscreen unavailable");
    return false;
  }
}

/**
 * Window -> React fullscreen sync. Returns a disposer that unlistens every
 * subscription (the awaits resolve after the call, so a caller that unmounts
 * mid-flight still ends with zero listeners).
 */
export async function syncWindowFullscreenState(
  onChange: (fullscreen: boolean) => void,
): Promise<() => void> {
  let appWindow: ReturnType<typeof getCurrentWindow>;
  try {
    appWindow = getCurrentWindow();
  } catch (e: unknown) {
    // No Tauri context at all (plain browser / unit test / a race before the
    // IPC bridge is injected). Nothing to sync: a no-op disposer, reported, not
    // swallowed.
    void captureError({
      level: "warn",
      source: LOGGER_SOURCE,
      message: `fullscreen-sync-unavailable: ${describeError(e)}`,
      kind: "window-fullscreen-sync-unavailable",
    });
    return () => {};
  }
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  // Last value handed to the owner. The first read always reports (it can
  // catch a session restored into fullscreen); every later read reports only
  // on an actual transition, so a resize storm cannot re-render App.
  let lastFullscreen: boolean | null = null;

  const readState = async (): Promise<void> => {
    try {
      const fullscreen = await appWindow.isFullscreen();
      if (disposed) return;
      if (lastFullscreen === fullscreen) return;
      lastFullscreen = fullscreen;
      onChange(fullscreen);
    } catch (e: unknown) {
      void captureError({
        level: "warn",
        source: LOGGER_SOURCE,
        message: `fullscreen-read-failed: ${describeError(e)}`,
        kind: "window-fullscreen-read-failed",
      });
    }
  };

  const subscribe = async (
    register: () => Promise<() => void>,
    kind: string,
  ): Promise<void> => {
    try {
      const unlisten = await register();
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    } catch (e: unknown) {
      void captureError({
        level: "warn",
        source: LOGGER_SOURCE,
        message: `${kind}-listen-failed: ${describeError(e)}`,
        kind: "window-fullscreen-listen-failed",
      });
    }
  };

  // The initial read catches an already-fullscreen window (restored session).
  await readState();
  // `subscribe` never rejects (it classifies and reports internally), so
  // `allSettled` is only about not caring about individual outcomes.
  await Promise.all([
    subscribe(() => appWindow.onResized(() => void readState()), "resized"),
    subscribe(
      () => appWindow.onFocusChanged(() => void readState()),
      "focus-changed",
    ),
    subscribe(
      () => appWindow.onScaleChanged(() => void readState()),
      "scale-changed",
    ),
  ]);

  return () => {
    disposed = true;
    for (const unlisten of unlisteners) unlisten();
    unlisteners.length = 0;
  };
}
