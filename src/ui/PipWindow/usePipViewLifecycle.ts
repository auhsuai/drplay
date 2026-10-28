import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setVideoHostOwner } from "../../lib/videoHost";
import {
  notifyPipReady,
  PIP_EVENTS,
  type PipActionName,
  type PipOwner,
  type PipStatePayload,
} from "../../lib/pipWindow";
import { VIDEO_HOST_OWNER_CHANGED_EVENT } from "../NowPlaying/components/VideoSurface";
import { logPipViewFailure } from "./pipWindowLog";
import { applyPipAspect } from "./pipWindowSizing";

/** Matches FULLSCREEN_CHROME_HIDE_MS (player/useFullscreenChrome):
 *  the two chrome surfaces are the same affordance on two windows, so they
 *  must disappear after the same idle window. A 2.5s hold here read as "PiP
 *  keeps its controls up" while fullscreen had already cleared. */
const CONTROLS_HIDE_MS = 1_000;
/** Below this viewport height the fixed-px overlays would cover most of the
 *  picture, so the PiP chrome switches to a single compact row. */
const COMPACT_HEIGHT_PX = 340;
const MAIN_WINDOW_LABEL = "main";
/** If main never answers a close request (crashed/hung/reloaded), the PiP
 *  window must still be able to close itself after this bounded wait. */
const CLOSE_FALLBACK_MS = 4_000;

interface PipOwnerEvent {
  owner?: PipOwner;
}

export interface PipChromeAutoHide {
  /** Attach to the view's root element: the idle countdown refuses to hide the
   *  chrome while keyboard focus is inside it. Owned here so the callbacks
   *  below can stay dependency-free. */
  rootRef: RefObject<HTMLDivElement | null>;
  controlsVisible: boolean;
  compact: boolean;
  revealControls: () => void;
  scheduleHide: () => void;
  cancelHide: () => void;
}

/**
 * Owns everything about the PiP chrome's visibility: the idle countdown, the
 * reveal triggers, the compact-layout flag, and the two document-level blocks
 * that must live as long as the window does.
 *
 * Callback identities are deliberately stable (empty deps): the keydown
 * listeners below are re-registered whenever `revealControls` changes, and
 * `pip-state` arrives several times a second while playing — a dependency on
 * state here would churn listeners at that rate. `rootRef` is a stable ref
 * object owned by this hook, so reading it never needs a dependency.
 */
export function usePipChromeAutoHide(): PipChromeAutoHide {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [compact, setCompact] = useState(
    () => window.innerHeight <= COMPACT_HEIGHT_PX,
  );
  const hideTimerRef = useRef<number | null>(null);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
    }
    const run = (): void => {
      hideTimerRef.current = null;
      const active = document.activeElement;
      const focusInside =
        active instanceof HTMLElement &&
        active !== rootRef.current &&
        rootRef.current?.contains(active) === true &&
        active.matches(":focus-visible");
      if (focusInside) {
        hideTimerRef.current = window.setTimeout(run, CONTROLS_HIDE_MS);
        return;
      }
      setControlsVisible(false);
    };
    hideTimerRef.current = window.setTimeout(run, CONTROLS_HIDE_MS);
  }, []);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    scheduleHide();
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [scheduleHide]);

  useEffect(() => {
    const handleKeyDown = (): void => {
      revealControls();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [revealControls]);

  // The PiP document is a bare video surface: NO shortcut may reach the app
  // from here, not even the app's own transport keys (Space, arrows, M/P/N/F,
  // ...), which are bound on `window` in the main document. A capture-phase
  // listener on `window` is the earliest stop on the propagation path, so
  // every bubble-phase handler — this view's reveal listener above and any
  // future shortcut handler — receives the event already default-prevented and
  // stops acting on it.
  //
  // Ctrl+P is the ONE exception: the toggle listener in the window bridge turns
  // it into the "return" action, so it is deliberately left untouched here.
  // Every other chord, including modifier variants of Ctrl+P, is swallowed and
  // no action is emitted.
  useEffect(() => {
    const blockPipShortcuts = (event: KeyboardEvent): void => {
      // Reveal first: blocking a key must not also cost the user the chrome.
      revealControls();
      const isReturnToggle =
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "p";
      if (isReturnToggle) return;
      // Composing events are blocked too: this document has no text input, so
      // cancelling them cannot break a composition, and letting them through
      // would leave one path by which a shortcut could reach the app.
      event.preventDefault();
    };
    window.addEventListener("keydown", blockPipShortcuts, { capture: true });
    return () => {
      // The options object must match the one above, otherwise the removal
      // silently misses and the block outlives the view.
      window.removeEventListener("keydown", blockPipShortcuts, {
        capture: true,
      });
    };
  }, [revealControls]);

  useEffect(() => {
    const onResize = (): void => {
      setCompact(window.innerHeight <= COMPACT_HEIGHT_PX);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // The main window blocks the context menu in `useAppGlobalEvents`, but that
  // hook only mounts inside `App` — this document renders `PipWindowView`
  // instead, so WebView2 would otherwise offer reload / save as / inspect /
  // print inside the floating player. Install the same blanket block here,
  // scoped to this document and removed with the view.
  useEffect(() => {
    const blockContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };
    document.addEventListener("contextmenu", blockContextMenu);
    return () => {
      document.removeEventListener("contextmenu", blockContextMenu);
    };
  }, []);

  return {
    rootRef,
    controlsVisible,
    compact,
    revealControls,
    scheduleHide,
    cancelHide,
  };
}

export interface PipWindowBridge {
  state: Partial<PipStatePayload>;
  /** True while THIS window owns the native video surface. */
  ownerActive: boolean;
  /** Bumped by `refreshSurface`: used as the `VideoSurface` key so a rebuild
   *  gets a fresh element instead of mutating the existing one. */
  surfaceGeneration: number;
  /** Emits a `pip-action` to main. The payload key is ALWAYS present (even
   *  `undefined`): the receiving contract destructures it. */
  sendAction: (action: PipActionName, payload?: unknown) => void;
  /** Optimistic local echo for a seek, so the bar does not freeze while the
   *  round-trip is in flight. */
  patchCurrentTime: (time: number) => void;
  /** Optimistic local echo for a volume drag; clearing mute at any level > 0
   *  matches what the engine does on its side. */
  patchVolume: (volume: number) => void;
  toggleMute: () => void;
}

/**
 * Owns the IPC bridge with the main window: the published `pip-state`, the
 * surface-owner handshake, the ready/refresh signals and the close protocol.
 *
 * Self-contained on purpose — it owns its own state instead of taking setters,
 * so the effect below depends only on stable callbacks. That matters: every
 * `pip-state` publish re-renders the view several times a second, and a
 * dependency on that state would tear down and re-register all five listeners
 * (and the close handler) at that rate, which is both a leak and a correctness
 * hazard for the owner handshake.
 */
export function usePipWindowBridge(): PipWindowBridge {
  const [state, setState] = useState<Partial<PipStatePayload>>({});
  const [ownerActive, setOwnerActive] = useState(false);
  const [surfaceGeneration, setSurfaceGeneration] = useState(0);
  const allowCloseRef = useRef(false);
  const pipActiveRef = useRef(false);
  const closeFallbackTimerRef = useRef<number | null>(null);

  const clearCloseFallback = useCallback(() => {
    if (closeFallbackTimerRef.current !== null) {
      window.clearTimeout(closeFallbackTimerRef.current);
      closeFallbackTimerRef.current = null;
    }
  }, []);

  // Layer one of the PiP keyboard policy: install the native WebView2
  // browser-accelerator switch on THIS window. The main window gets it in
  // Rust `setup`, but the PiP window is created from JS afterwards, so it has
  // to ask for the policy itself — otherwise WebView2 owns Ctrl+P here and
  // opens its print dialog before the keydown listener below can run.
  //
  // Idempotent in Rust (per-label registration) and re-armed after every
  // close/reopen, so a stale slot can never leave a new window unprotected.
  // A failure costs only the accelerator policy (the JS listener still runs),
  // so it is logged and never blocks the view.
  useEffect(() => {
    void invoke("pip_install_keys_cmd").catch((error: unknown) => {
      logPipViewFailure("install-keys-failed", error);
    });
  }, []);

  const sendAction = useCallback((action: PipActionName, payload?: unknown) => {
    void getCurrentWindow()
      .emitTo(MAIN_WINDOW_LABEL, PIP_EVENTS.action, { action, payload })
      .catch((error: unknown) => {
        logPipViewFailure(`action-${action}-failed`, error);
      });
  }, []);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlisteners: UnlistenFn[] = [];
    const lifecycle = { disposed: false };

    // Layer two of the PiP keyboard policy. Layer one is the native WebView2
    // accelerator switch (src-tauri/src/webview_keys.rs): without it Ctrl+P is
    // consumed by the browser as PRINT before the page ever sees it. This
    // listener then finishes the TOGGLE: the same chord pressed in the main
    // window opens PiP (PLAYER_PIP_TOGGLE -> togglePip -> enterPip), so here it
    // must be the symmetric reverse — bring the app forward and reopen Now
    // Playing (the `return` action, which is exactly what `returnFromPip` does).
    // The X button stays the separate "close to background" affordance; keeping
    // them distinct is what makes Ctrl+P a toggle instead of a second close.
    const handlePipToggleKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "p") return;
      event.preventDefault();
      sendAction("return");
    };
    window.addEventListener("keydown", handlePipToggleKey);

    const track = async (promise: Promise<UnlistenFn>): Promise<boolean> => {
      const unlisten = await promise;
      if (lifecycle.disposed) {
        unlisten();
        return false;
      }
      unlisteners.push(unlisten);
      return true;
    };

    void (async () => {
      try {
        if (
          !(await track(
            listen<Partial<PipStatePayload>>(PIP_EVENTS.state, (event) => {
              setState((previous) => ({ ...previous, ...event.payload }));
            }),
          ))
        ) {
          return;
        }

        if (
          !(await track(
            listen<PipOwnerEvent>(PIP_EVENTS.owner, (event) => {
              const owner = event.payload.owner === "pip" ? "pip" : "main";
              allowCloseRef.current = owner === "main";
              pipActiveRef.current = owner === "pip";
              setVideoHostOwner(owner);
              // The surface dedupes the physical rect, so a retarget back to
              // an unchanged CSS box would otherwise never re-send it. This
              // event resets that dedupe AND re-sends rect + visibility.
              window.dispatchEvent(new Event(VIDEO_HOST_OWNER_CHANGED_EVENT));
              setOwnerActive(owner === "pip");
              if (owner === "main") clearCloseFallback();
              void appWindow
                .emitTo(MAIN_WINDOW_LABEL, PIP_EVENTS.ownerAck, { owner })
                .catch((error: unknown) => {
                  logPipViewFailure("owner-ack-failed", error);
                });
            }),
          ))
        ) {
          return;
        }

        if (
          !(await track(
            listen(PIP_EVENTS.release, () => {
              clearCloseFallback();
              allowCloseRef.current = true;
              pipActiveRef.current = false;
              setVideoHostOwner("main");
              setOwnerActive(false);
              void appWindow
                .emitTo(MAIN_WINDOW_LABEL, PIP_EVENTS.releaseAck)
                .catch((error: unknown) => {
                  logPipViewFailure("release-ack-failed", error);
                });
            }),
          ))
        ) {
          return;
        }

        if (
          !(await track(
            listen(PIP_EVENTS.requestReady, () => {
              notifyPipReady();
            }),
          ))
        ) {
          return;
        }

        if (
          !(await track(
            listen(PIP_EVENTS.refreshSurface, () => {
              setSurfaceGeneration((previous) => previous + 1);
            }),
          ))
        ) {
          return;
        }

        const unlistenClose = await appWindow.onCloseRequested((event) => {
          if (allowCloseRef.current || !pipActiveRef.current) return;
          event.preventDefault();
          void appWindow
            .emitTo(MAIN_WINDOW_LABEL, PIP_EVENTS.closeRequested)
            .catch((error: unknown) => {
              logPipViewFailure("close-request-emit-failed", error);
            });
          if (closeFallbackTimerRef.current !== null) return;
          // Main is the only component that can release the native surface.
          // If it is gone, waiting forever would make this window unclosable;
          // after the bound, force-destroy it (allow-destroy capability).
          closeFallbackTimerRef.current = window.setTimeout(() => {
            closeFallbackTimerRef.current = null;
            allowCloseRef.current = true;
            pipActiveRef.current = false;
            void appWindow.destroy().catch((error: unknown) => {
              logPipViewFailure("close-fallback-destroy-failed", error);
            });
          }, CLOSE_FALLBACK_MS);
        });
        if (lifecycle.disposed) {
          unlistenClose();
          return;
        }
        unlisteners.push(unlistenClose);

        notifyPipReady();
      } catch (error) {
        logPipViewFailure("listeners-failed", error);
      }
    })();

    return () => {
      lifecycle.disposed = true;
      window.removeEventListener("keydown", handlePipToggleKey);
      clearCloseFallback();
      unlisteners.forEach((unlisten) => {
        unlisten();
      });
    };
  }, [clearCloseFallback, sendAction]);

  const patchCurrentTime = useCallback((time: number) => {
    setState((previous) => ({ ...previous, currentTime: time }));
  }, []);

  const patchVolume = useCallback((volume: number) => {
    setState((previous) => ({
      ...previous,
      volume,
      isMuted: volume > 0 ? false : previous.isMuted === true,
    }));
  }, []);

  const toggleMute = useCallback(() => {
    setState((previous) => ({
      ...previous,
      isMuted: previous.isMuted !== true,
    }));
  }, []);

  return {
    state,
    ownerActive,
    surfaceGeneration,
    sendAction,
    patchCurrentTime,
    patchVolume,
    toggleMute,
  };
}

export interface PipAspectLockInput {
  hasTrack: boolean;
  isVideo: boolean;
  /** Media identity: stable track id + title + duration + the two gates. */
  aspectKey: string;
}

/**
 * Applies the video's aspect ratio to the window whenever the loaded media
 * changes.
 *
 * The deps are exactly the caller's three derived values (`aspectKey` already
 * folds in the title and duration), and the guard is a hook-local ref pair:
 * a burst of `pip-state` publishes must not interleave two setSize/setMinSize
 * pairs, and a change that lands mid-run is replayed ONCE afterwards instead of
 * being dropped. A failed apply must not leave the guard stuck on, hence the
 * `finally`.
 */
export function usePipAspectLock({
  hasTrack,
  isVideo,
  aspectKey,
}: PipAspectLockInput): void {
  // Guards the aspect apply sequence against overlapping runs. A burst of
  // `pip-state` events (or StrictMode mounting the effect twice) would
  // otherwise interleave two setSize/setMinSize pairs and let the loser win.
  // `pendingRef` is a queue of ONE: a media change that arrives mid-run is
  // replayed once afterwards instead of being dropped.
  const aspectRunningRef = useRef(false);
  const aspectPendingRef = useRef(false);

  useEffect(() => {
    if (!hasTrack || !isVideo) return;
    if (aspectRunningRef.current) {
      // A media switch arrived while a resize sequence was still in flight.
      // Replay it once after the current one settles instead of interleaving
      // two setSize/setMinSize pairs, where the slower write would win.
      aspectPendingRef.current = true;
      return;
    }
    aspectRunningRef.current = true;
    void (async () => {
      try {
        let replay = true;
        while (replay) {
          aspectPendingRef.current = false;
          await applyPipAspect();
          replay = aspectPendingRef.current;
        }
      } finally {
        aspectRunningRef.current = false;
      }
    })();
  }, [aspectKey, hasTrack, isVideo]);
}
