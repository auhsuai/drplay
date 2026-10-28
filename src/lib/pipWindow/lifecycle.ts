import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { armEvent, type EventWaiter } from "./events";
import { releasePipWindow } from "./ownership";
import {
  delay,
  describeError,
  logPipFailure,
  PIP_CLOSE_ATTEMPTS,
  PIP_CLOSE_VERIFY_MS,
  PIP_EVENTS,
  PIP_READY_TIMEOUT_MS,
  PIP_WINDOW_LABEL,
  type PipWindowOptions,
} from "./shared";

export async function openPipWindow(
  opts: PipWindowOptions = {},
): Promise<WebviewWindow> {
  let existing: WebviewWindow | null = null;
  try {
    existing = await WebviewWindow.getByLabel(PIP_WINDOW_LABEL);
  } catch (error) {
    logPipFailure("warn", "lookup-failed", error);
  }

  if (existing !== null) {
    // A reused PiP window may be minimized: restore it before showing, or
    // show()/setFocus() would act on a window that stays collapsed.
    try {
      await existing.unminimize();
    } catch (error) {
      logPipFailure("warn", "reuse-unminimize-failed", error);
    }
    try {
      await existing.show();
    } catch (error) {
      logPipFailure("warn", "reuse-show-failed", error);
    }
    try {
      await existing.setFocus();
    } catch (error) {
      logPipFailure("warn", "reuse-focus-failed", error);
    }
    return existing;
  }

  return new WebviewWindow(PIP_WINDOW_LABEL, {
    url: "/?pip=1",
    title: "DrPlay PiP",
    width: opts.width ?? 480,
    height: opts.height ?? 300,
    minWidth: 320,
    minHeight: 200,
    resizable: true,
    alwaysOnTop: true,
    decorations: false,
    // Must stay false for a borderless window to be resizable on ALL edges.
    // tao defaults this to true; with it, tauri-runtime-wry's
    // `undecorated_resizing` builds a top-edge-only region (`only_top`) and
    // `WM_NCHITTEST` returns HTTOP unconditionally, leaving left/right/bottom
    // with no native resize target. With `false` it installs the full
    // four-sided ring (and its corners), which is what we want here. Visual
    // cost is only the 1px white border / Win11 rounded corners that
    // `shadow:true` would otherwise add - both unwanted on a PIP video window.
    shadow: false,
    transparent: true,
    backgroundColor: [0, 0, 0, 0],
    noRedirectionBitmap: true,
    center: true,
  });
}

export async function openPipWindowAndWaitReady(
  opts: PipWindowOptions = {},
): Promise<WebviewWindow> {
  let waiter: EventWaiter;
  try {
    waiter = await armEvent(PIP_EVENTS.ready, PIP_READY_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`pip readiness listener failed: ${describeError(error)}`);
  }

  let creationUnlisten: UnlistenFn | undefined;
  let disposed = false;
  let rejectCreation: (error: Error) => void = () => {};
  const creationFailed = new Promise<never>((_resolve, reject) => {
    rejectCreation = reject;
  });
  void creationFailed.catch((error: unknown) => {
    logPipFailure("warn", "creation-failed", error);
  });

  try {
    const win = await openPipWindow(opts);
    void win
      .once<unknown>("tauri://error", (event) => {
        rejectCreation(
          new Error(
            `pip window creation failed: ${describeError(event.payload)}`,
          ),
        );
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else creationUnlisten = unlisten;
      })
      .catch((error: unknown) => {
        logPipFailure("warn", "creation-listener-failed", error);
      });

    try {
      await emitTo(PIP_WINDOW_LABEL, PIP_EVENTS.requestReady);
    } catch (error) {
      logPipFailure("warn", "request-ready-failed", error);
    }

    await Promise.race([waiter.promise, creationFailed]);
    return win;
  } finally {
    disposed = true;
    creationUnlisten?.();
    waiter.dispose();
  }
}

export async function closePipWindow(): Promise<void> {
  let win: WebviewWindow | null = null;
  try {
    win = await WebviewWindow.getByLabel(PIP_WINDOW_LABEL);
  } catch (error) {
    logPipFailure("warn", "close-lookup-failed", error);
    return;
  }
  if (win === null) return;

  for (let attempt = 0; attempt < PIP_CLOSE_ATTEMPTS; attempt += 1) {
    await releasePipWindow();
    try {
      await invoke("pip_window_close_cmd");
    } catch (error) {
      logPipFailure("warn", "close-command-failed", error);
      try {
        await win.close();
      } catch (closeError) {
        logPipFailure("warn", "close-fallback-failed", closeError);
      }
    }

    await delay(PIP_CLOSE_VERIFY_MS);
    try {
      win = await WebviewWindow.getByLabel(PIP_WINDOW_LABEL);
    } catch (error) {
      logPipFailure("warn", "close-verify-failed", error);
      return;
    }
    if (win === null) return;
    if (attempt + 1 < PIP_CLOSE_ATTEMPTS) {
      logPipFailure(
        "warn",
        "close-still-open",
        "pip window survived the first close attempt",
      );
    }
  }

  logPipFailure(
    "error",
    "close-failed",
    "pip window is still open after all close attempts",
  );
}

/** True when the PiP webview window still exists. A failed lookup reports
 *  `true` (conservative: a transient IPC failure must not trigger the
 *  external-destroy recovery path). */
export async function isPipWindowOpen(): Promise<boolean> {
  try {
    return (await WebviewWindow.getByLabel(PIP_WINDOW_LABEL)) !== null;
  } catch (error) {
    logPipFailure("warn", "exists-check-failed", error);
    return true;
  }
}

/**
 * F5 reload teardown: the Tauri process (and the native render target) survives
 * a WebView reload, so a live PiP window would otherwise keep the only video
 * surface while the fresh App believes PiP is inactive. Retarget the surface
 * back to main first, then destroy the PiP window. Best-effort by contract:
 * failures are logged and never block the reload flow.
 */
export async function teardownPipForReload(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const existing = await WebviewWindow.getByLabel(PIP_WINDOW_LABEL);
    if (existing === null) return;
  } catch (error) {
    logPipFailure("warn", "reload-lookup-failed", error);
    return;
  }

  try {
    await invoke("video_surface_retarget_to_main_cmd");
  } catch (error) {
    logPipFailure("warn", "reload-retarget-failed", error);
  }

  try {
    await closePipWindow();
  } catch (error) {
    logPipFailure("warn", "reload-close-failed", error);
  }
}

export function notifyPipReady(): void {
  void emit(PIP_EVENTS.ready).catch((error: unknown) => {
    logPipFailure("warn", "ready-emit-failed", error);
  });
}
