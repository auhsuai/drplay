import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import {
  LoaderCircle,
  MoveDiagonal,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  VideoSurface,
  VIDEO_HOST_OWNER_CHANGED_EVENT,
} from "./NowPlaying/components/VideoSurface";
import { setVideoHostOwner } from "../lib/videoHost";
import { getVideoAspect } from "../lib/mpvControl/videoControls";
import {
  notifyPipReady,
  PIP_EVENTS,
  type PipActionName,
  type PipOwner,
  type PipStatePayload,
} from "../lib/pipWindow";
import { captureError } from "../utils/errorLog";
import { PipSeekBar } from "./PipSeekBar";
import { PipTimeDisplay } from "./PipTimeDisplay";
import { PipVolumeSlider } from "./PipVolumeSlider";

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
/** Most of the monitor a PiP target may occupy, in LOGICAL px. The remaining
 *  10% is slack for the taskbar and for the window's own translated position,
 *  so a portrait video never ends up taller than the screen. */
const ASPECT_MONITOR_FRACTION = 0.9;
/** The min-size floor is a LENGTH on the long side, not two fixed axes: a floor
 *  that is not the video's ratio is re-clamped by WM_GETMINMAXINFO *after*
 *  WM_SIZING, which is exactly where a 16:9 lock leaks (320x180 -> 320x200). */
const ASPECT_MIN_LONG_SIDE_PX = 320;

interface WindowSize {
  width: number;
  height: number;
}

interface PipOwnerEvent {
  owner?: PipOwner;
}

function safeTime(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function safeVolume(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function logPipViewFailure(kind: string, error: unknown): void {
  void captureError({
    level: "warn",
    source: "PipWindowView",
    message: `${kind}: ${error instanceof Error ? error.message : String(error)}`,
    kind,
  });
}

/** The min-size floor that AGREES with `aspect`, so WM_GETMINMAXINFO cannot
 *  re-clamp a corner off the ratio. A 320px floor is applied to the LONG side
 *  and the short side is derived. */
function minSizeForAspect(aspect: number): WindowSize {
  if (aspect >= 1) {
    return {
      width: ASPECT_MIN_LONG_SIDE_PX,
      height: Math.max(1, Math.round(ASPECT_MIN_LONG_SIDE_PX / aspect)),
    };
  }
  return {
    width: Math.max(1, Math.round(ASPECT_MIN_LONG_SIDE_PX * aspect)),
    height: ASPECT_MIN_LONG_SIDE_PX,
  };
}

/**
 * Shrink a target so it fits the monitor while KEEPING the ratio — a portrait
 * video at its natural size is taller than the screen. The other dimension is
 * recomputed from `aspect` after every cap, never scaled independently.
 */
function clampToMonitor(
  target: WindowSize,
  aspect: number,
  monitor: WindowSize | null,
): WindowSize {
  if (monitor === null) return target;
  const maxWidth = Math.max(
    1,
    Math.floor(monitor.width * ASPECT_MONITOR_FRACTION),
  );
  const maxHeight = Math.max(
    1,
    Math.floor(monitor.height * ASPECT_MONITOR_FRACTION),
  );
  let width = target.width;
  let height = target.height;
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.max(1, Math.round(height * aspect));
  }
  if (width > maxWidth) {
    width = maxWidth;
    height = Math.max(1, Math.round(width / aspect));
  }
  return { width, height };
}

/**
 * Resize the PiP window to the loaded video's aspect ratio, then hand the same
 * ratio to the native WM_SIZING lock.
 *
 * WHY the window must be resized at all: the Rust lock only constrains what a
 * DRAG is allowed to produce. mpv's `keepaspect` letterboxes inside whatever
 * client area it gets, so a 16:9 video in a 480x300 window still shows black
 * bars and the lock looks broken. Shape the window first, lock second.
 *
 * Every step is independent and best-effort: a failure is logged with its own
 * kind and never stops the remaining steps or escapes as a rejection. This runs
 * on a window-resize path inside a video player — it must never break playback.
 */
async function applyPipAspect(): Promise<void> {
  let aspect: number;
  try {
    aspect = await getVideoAspect();
  } catch (error) {
    logPipViewFailure("aspect-query-failed", error);
    return;
  }
  if (!Number.isFinite(aspect) || aspect <= 0) {
    logPipViewFailure(
      "aspect-unknown",
      `getVideoAspect returned ${String(aspect)}`,
    );
    return;
  }

  const appWindow = getCurrentWindow();

  // setSize/setMinSize take LOGICAL px while innerSize() reports PHYSICAL px,
  // so a HiDPI window (scaleFactor 2) must be halved before reuse — using the
  // physical number directly would double the window on every apply.
  let scaleFactor = 1;
  try {
    scaleFactor = await appWindow.scaleFactor();
  } catch (error) {
    logPipViewFailure("aspect-scale-factor-failed", error);
  }

  let physicalSize: WindowSize | null = null;
  try {
    physicalSize = await appWindow.innerSize();
  } catch (error) {
    logPipViewFailure("aspect-inner-size-failed", error);
  }

  let monitorSize: WindowSize | null = null;
  try {
    const monitor = await currentMonitor();
    if (monitor !== null) {
      monitorSize = {
        width: monitor.size.width / monitor.scaleFactor,
        height: monitor.size.height / monitor.scaleFactor,
      };
    }
  } catch (error) {
    logPipViewFailure("aspect-monitor-failed", error);
  }

  if (physicalSize !== null) {
    const width = Math.max(1, Math.round(physicalSize.width / scaleFactor));
    const target = clampToMonitor(
      { width, height: Math.max(1, Math.round(width / aspect)) },
      aspect,
      monitorSize,
    );
    try {
      await appWindow.setSize(new LogicalSize(target.width, target.height));
    } catch (error) {
      logPipViewFailure("aspect-set-size-failed", error);
    }
  }

  const minSize = minSizeForAspect(aspect);
  try {
    await appWindow.setMinSize(new LogicalSize(minSize.width, minSize.height));
  } catch (error) {
    logPipViewFailure("aspect-set-min-size-failed", error);
  }

  // Last: the native lock must agree with the rect that is already on screen.
  try {
    await invoke("pip_set_aspect_cmd", { aspect });
  } catch (error) {
    logPipViewFailure("aspect-lock-command-failed", error);
  }
}

export function PipWindowView() {
  const { t } = useTranslation();
  const [state, setState] = useState<Partial<PipStatePayload>>({});
  const [ownerActive, setOwnerActive] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [compact, setCompact] = useState(
    () => window.innerHeight <= COMPACT_HEIGHT_PX,
  );
  const [surfaceGeneration, setSurfaceGeneration] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const allowCloseRef = useRef(false);
  const pipActiveRef = useRef(false);
  const closeFallbackTimerRef = useRef<number | null>(null);
  // Guards the aspect apply sequence against overlapping runs. A burst of
  // `pip-state` events (or StrictMode mounting the effect twice) would
  // otherwise interleave two setSize/setMinSize pairs and let the loser win.
  // `pendingRef` is a queue of ONE: a media change that arrives mid-run is
  // replayed once afterwards instead of being dropped.
  const aspectRunningRef = useRef(false);
  const aspectPendingRef = useRef(false);

  const clearCloseFallback = useCallback(() => {
    if (closeFallbackTimerRef.current !== null) {
      window.clearTimeout(closeFallbackTimerRef.current);
      closeFallbackTimerRef.current = null;
    }
  }, []);

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
  // Ctrl+P is the ONE exception: the toggle listener below turns it into the
  // "return" action, so it is deliberately left untouched here. Every other
  // chord, including modifier variants of Ctrl+P, is swallowed and no action
  // is emitted.
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

  const hasTrack = state.hasTrack === true;
  const isVideo = state.isVideo === true;
  const hasError = state.hasError === true;
  const hasEnded = state.hasEnded === true;
  const isPlaying = state.isPlaying === true;
  const isBuffering = state.isBuffering === true;
  const isMuted = state.isMuted === true;
  const isDownloading = state.isDownloading === true;
  const volume = safeVolume(state.volume);
  const currentTime = safeTime(state.currentTime);
  const duration = safeTime(state.duration);

  // Trigger key for the aspect apply. `PipStatePayload` has no track id, so the
  // media identity has to be approximated from the fields that DO move on a
  // track switch. KNOWN LIMITATION: two different videos with the same title
  // AND the same duration would not re-trigger. That is acceptable because the
  // apply is also idempotent and cheap, and because the failure mode is only a
  // stale ratio on a same-title same-length switch — the next media change
  // fixes it. The proper fix is a trackId/mediaKey field on the payload.
  const aspectKey = [
    String(hasTrack),
    String(isVideo),
    (state.title ?? "").trim(),
    String(duration),
  ].join("|");

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
  // Buffered segments travel as plain data (see BufferedRangePayload); a
  // missing field on an older publish degrades to "no buffer drawn" instead of
  // crashing the render.
  const buffered = state.buffered ?? [];
  const videoActive = hasTrack && isVideo && !hasError && !hasEnded;
  const hostActive = ownerActive && videoActive;
  const displayTitle =
    (state.title ?? "").trim() || t("player.picture_in_picture");
  // The rail is non-seekable when there is no position to seek to or the media
  // can no longer accept a seek — the previous native <input> used exactly this
  // gate, and PipSeekBar feeds it straight into SeekRail's `duration > 0` gate.
  const seekDisabled = duration <= 0 || hasEnded || hasError;

  // Optimistic local echo: the main window answers a seek with a fresh
  // pip-state, but that round-trip (and the engine's own timeupdate) can land
  // 250ms+ later, so waiting for it would leave the bar frozen where the user
  // released. Patch the local copy so the next render already shows the target
  // and the real payload only has to confirm it.
  const handleSeek = (time: number): void => {
    if (!Number.isFinite(time) || hasEnded || hasError) return;
    setState((previous) => ({ ...previous, currentTime: time }));
    sendAction("seek", time);
  };

  const handleVolumeChange = (value: number): void => {
    if (!Number.isFinite(value)) return;
    const nextVolume = Math.min(1, Math.max(0, value));
    setState((previous) => ({
      ...previous,
      volume: nextVolume,
      isMuted: nextVolume > 0 ? false : previous.isMuted === true,
    }));
    sendAction("setVolume", nextVolume);
  };

  const handleToggleMute = (): void => {
    setState((previous) => ({
      ...previous,
      isMuted: previous.isMuted !== true,
    }));
    sendAction("toggleMute");
  };

  // Ported from TransportControls (the fullscreen/PlayerBar icon button): the
  // PiP top bar is the same dark chrome, so its icons use the same idle colour,
  // hover wash, hit box (p-2) and press scale. The old PiP copy used a white
  // 85% icon with a white wash and a h-8 w-8 box, which is why the two windows
  // never looked like one player.
  const iconButtonClass =
    "text-gray-500 hover:text-white hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0";

  // The centre button mirrors TransportControls': the download/buffering
  // window shows a spinner (the engine is waiting), an error turns it into the
  // retry affordance, and a download in flight disables it — exactly the gates
  // the fullscreen transport applies.
  const transportDisabled = !hasTrack || isDownloading;
  const transportClass = `w-11 h-11 shrink-0 flex items-center justify-center text-white rounded-full transition-all duration-200 shadow-md active:scale-90 ${
    hasTrack
      ? "bg-brand-primary hover:bg-blue-600 hover:shadow-lg"
      : "bg-gray-400 cursor-not-allowed"
  }`;
  const transportLabel = hasError
    ? t("player.pip.retry")
    : isPlaying
      ? t("player.pause")
      : t("player.play");

  return (
    <div
      ref={rootRef}
      role="presentation"
      onPointerMove={revealControls}
      onPointerDown={revealControls}
      onPointerEnter={revealControls}
      onFocusCapture={revealControls}
      onKeyDown={revealControls}
      className={`drplay-host-clear relative h-screen w-screen select-none overflow-hidden bg-black text-white ${
        controlsVisible ? "" : "cursor-none"
      }`}
    >
      <div className="absolute inset-0">
        <VideoSurface
          key={surfaceGeneration}
          owner="pip"
          active={hostActive}
          fill
          hasFirstFrame
          isPlaying={isPlaying}
          isBuffering={isBuffering}
          hasError={hasError}
          isEnded={hasEnded}
        />
      </div>

      {/* Opaque black cover for the (deliberately transparent) PiP page. The
          DComp video composites BELOW the webview, and the owner/first-frame
          state for THIS media load only reaches the main window — there is no
          PiP-side signal without a new event protocol, so `hasFirstFrame` stays
          true. This layer is therefore removed exactly when the host is really
          ours and playing (`hostActive`); it must never stay over a live video.
          A surface rebuild keeps `hostActive` true, so it cannot cover that
          gap; the cheaper protection there is that the render side keeps the
          previous surface bound until the replacement has a frame. */}
      {!hostActive && (
        <div className="absolute inset-0 z-[1] bg-black" aria-hidden="true" />
      )}

      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 text-center">
        {hasError && (
          <p className="max-w-xs rounded-lg bg-black/70 px-3 py-2 text-sm text-white/90">
            {t("player.pip.playback_error")}
          </p>
        )}
        {!hasError && hasEnded && (
          <p className="max-w-xs rounded-lg bg-black/70 px-3 py-2 text-sm text-white/90">
            {t("player.pip.video_ended")}
          </p>
        )}
        {!hasError && !hasEnded && !hasTrack && (
          <p className="max-w-xs rounded-lg bg-black/70 px-3 py-2 text-sm text-white/90">
            {t("player.no_track")}
          </p>
        )}
        {!hasError && !hasEnded && hasTrack && !isVideo && (
          <p className="max-w-xs rounded-lg bg-black/70 px-3 py-2 text-sm text-white/90">
            {t("player.pip.no_video")}
          </p>
        )}
      </div>

      {/* Always-present drag strip: the top bar below hides with the
          controls, so without this the window could not be moved once the
          auto-hide timer fires. It is 12px tall, transparent, and sits under
          the controls overlay (z-10 < z-20) so it never covers the bar or its
          buttons. Resizing is fully native (shadow:false in pipWindow.ts), so
          no JS resize zones are needed here. */}
      <div
        className="absolute inset-x-0 top-0 z-10 h-3"
        data-tauri-drag-region
        aria-hidden="true"
      />

      <div
        data-testid="pip-controls"
        className={`pointer-events-none absolute inset-0 z-20 ${
          compact ? "transition-none" : "transition-opacity duration-200"
        } ${controlsVisible ? "opacity-100" : "opacity-0"}`}
        aria-hidden={!controlsVisible}
        inert={!controlsVisible}
      >
        {/* Scrim under the chrome. Without it the icons sit directly on the
            picture: white glyphs over a bright frame (a snow scene, a white
            UI, subtitles) lose their contrast and the controls become hard to
            find. It fades with `pip-controls` on the same timer, so a clean
            picture is never dimmed while the user is just watching. */}
        <div
          className="pointer-events-none absolute inset-0 bg-black/45"
          aria-hidden="true"
        />

        {/* The transport trio, centred on the picture. Play/pause is the one
            control a viewer reaches for, and a corner of a video window is the
            least likely place to look for it. Deliberately ABOVE the scrim and
            BELOW the bars: the top and bottom bars come later in DOM order, so they keep
            painting — and receiving clicks — above this overlay. The wrapper
            is pointer-events-none so the empty area around the buttons still
            passes drags through; only the group itself takes input. Living
            inside `pip-controls` is what makes it auto-hide with the chrome. */}
        <div
          data-testid="pip-transport-center"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <div
            className={`pointer-events-auto flex items-center ${
              // A 44px trio plus 2x32px gaps is comfortable at full size, but
              // the PiP window can be as short as 180px; the narrower gap keeps
              // the group off both bars there without shrinking the hit boxes.
              compact ? "gap-3" : "gap-8"
            }`}
          >
            <button
              type="button"
              onClick={() => {
                sendAction("prev");
              }}
              disabled={!hasTrack}
              aria-label={t("player.prev")}
              title={t("player.prev")}
              className={iconButtonClass}
            >
              <SkipBack className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => {
                sendAction(hasError ? "retry" : "togglePlay");
              }}
              disabled={transportDisabled}
              aria-label={transportLabel}
              title={transportLabel}
              className={`${transportClass} ${
                // Same 44px box (the test helper and the compact layout both
                // rely on `w-11`), but a scaled-up face so the primary action
                // still reads as the biggest thing on screen.
                compact ? "" : "scale-110"
              }`}
            >
              {/* Same expression as TransportControls: the spinner follows the
                  download/buffering signal, an error wins over it, and Pause
                  only means "playing" (never "loading"). */}
              {isDownloading || (isBuffering && !hasError) ? (
                <LoaderCircle className="h-6 w-6 animate-spin [transform-box:view-box] origin-center" />
              ) : hasError ? (
                <RefreshCw className="h-6 w-6" />
              ) : isPlaying ? (
                <Pause className="h-6 w-6" />
              ) : (
                <Play className="ml-0.5 h-6 w-6" />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                sendAction("next");
              }}
              disabled={!hasTrack}
              aria-label={t("player.next")}
              title={t("player.next")}
              className={iconButtonClass}
            >
              <SkipForward className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div
          className={`pointer-events-auto absolute inset-x-0 top-0 flex items-center gap-1.5 bg-gradient-to-b px-2 ${
            compact
              ? "from-black/70 via-black/30 to-transparent pb-2 pt-1"
              : "from-black/85 via-black/55 to-transparent pb-4 pt-2"
          } sm:gap-2 sm:px-3`}
          data-tauri-drag-region
          onPointerEnter={cancelHide}
          onPointerLeave={scheduleHide}
        >
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-white/90 sm:text-sm"
            data-tauri-drag-region
            title={displayTitle}
          >
            {displayTitle}
          </span>
          <button
            type="button"
            onClick={() => {
              sendAction("return");
            }}
            aria-label={t("player.pip.return_to_player")}
            title={t("player.pip.return_to_player")}
            className={iconButtonClass}
          >
            <MoveDiagonal className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => {
              sendAction("closePip");
            }}
            aria-label={t("player.pip.close")}
            title={t("player.pip.close")}
            className={iconButtonClass}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div
          data-testid="pip-bottom-bar"
          className={`pointer-events-auto absolute inset-x-0 bottom-0 bg-gradient-to-t px-2 ${
            compact
              ? "from-black/70 via-black/35 to-transparent pb-1 pt-1"
              : "from-black/95 via-black/75 to-transparent pb-2 pt-8 sm:pb-3"
          } sm:px-3`}
          onPointerEnter={cancelHide}
          onPointerLeave={scheduleHide}
        >
          {!compact && (
            /* The full-screen seek bar, verbatim: same rail, same hover
               tooltip, same buffer segments. Its clocks are OFF because the
               row below owns the single `current / total` read-out — the
               fullscreen bar splits the same job between VideoTimeDisplay and
               the (hidden) clock spans, so two read-outs here would be one
               too many. */
            <PipSeekBar
              currentTime={currentTime}
              duration={duration}
              buffered={buffered}
              disabled={seekDisabled}
              onSeek={handleSeek}
              showClocks={false}
            />
          )}

          <div
            className={`flex flex-nowrap items-center gap-1.5 ${
              compact ? "" : "mt-2 sm:gap-2"
            }`}
          >
            {/* Leading cell, where the fullscreen bar puts its time display:
                the merged read-out stays visible in BOTH layouts, so the
                compact row does not lose the clock along with the seek bar. */}
            <PipTimeDisplay currentTime={currentTime} duration={duration} />

            {compact && (
              <PipSeekBar
                currentTime={currentTime}
                duration={duration}
                buffered={buffered}
                disabled={seekDisabled}
                onSeek={handleSeek}
                showClocks={false}
                className="flex-1 min-w-0"
              />
            )}

            <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
              {/* The PlayerBar slider's rail, ported: same track, fill, thumb
                  and icon ladder. `hideRail` in compact keeps the mute button
                  (the only volume affordance left at that width). */}
              <PipVolumeSlider
                volume={volume}
                isMuted={isMuted}
                onVolumeChange={handleVolumeChange}
                onToggleMute={handleToggleMute}
                hideRail={compact}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
