import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import i18next from "i18next";

import {
  setVideoHostOwner,
  setVideoPresentationStatus,
  type VideoHostOwner,
  type VideoPresentationStatus,
} from "../lib/videoHost";
import {
  closePipWindow,
  handoffSurfaceToMain,
  handoffSurfaceToPip,
  isPipWindowOpen,
  openPipWindowAndWaitReady,
  requestPipOwner,
  PIP_EVENTS,
  PIP_WINDOW_LABEL,
  type BufferedRangePayload,
  type PipActionEvent,
  type PipHandoffResult,
  type PipStatePayload,
} from "../lib/pipWindow";
import { AudioController } from "../lib/AudioController";
import { isForeignTrackEvent } from "../lib/audioNativeEvents";
import { emitPlayerUi } from "../player/playerUiBus";
import { usePlayerStore } from "../store/playerStore";
import { commitIsPlaying } from "../store/playbackCommit";
import { retryCurrentTrack } from "../utils/playerError";
import { captureError } from "../utils/errorLog";
import { showErrorToast } from "../utils/simpleToast";
import { VIDEO_HOST_OWNER_CHANGED_EVENT } from "../ui/NowPlaying/components/VideoSurface";

import type { Track } from "../types";

/** Engine timeupdate throttle is ~200-250ms; publishing any slower than that
 *  leaves the PiP buffer fill lagging visibly behind the playhead. */
const PIP_STATE_POLL_MS = 250;
/** Liveness check for the PiP window while it is supposed to be active. */
const PIP_WINDOW_POLL_MS = 1_000;

function safePlaybackTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safePlaybackVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function logPipError(
  kind: string,
  error: unknown,
  level: "warn" | "error" = "error",
): void {
  void captureError({
    level,
    source: "App",
    message: `${kind}: ${error instanceof Error ? error.message : String(error)}`,
    kind,
  });
}

function setPipHostOwner(owner: VideoHostOwner): void {
  setVideoHostOwner(owner);
  window.dispatchEvent(new Event(VIDEO_HOST_OWNER_CHANGED_EVENT));
}

/**
 * Presentation status implied by one hand-off, from the only question that
 * matters: is there a pipeline that currently presents?
 *
 * - `retargeted` → healthy (the requested window presents);
 * - `rolled_back` → healthy as well: the PREVIOUS target was recreated, so the
 *   pipeline the user was already watching still works. That is precisely why
 *   a failed Close/Return is not a picture-loss event;
 * - `detached` → detached, `unresolved` → unresolved.
 *
 * The ONE caller that must NOT use this is the external-close recovery
 * (`recoverFromExternalPipClose`): the window those outcomes refer to is the
 * one that just disappeared, so it maps explicitly and degrades `rolled_back`
 * to `unresolved` instead of `healthy`. Do not "simplify" that call site back
 * to this helper.
 */
function statusForHandoff(result: PipHandoffResult): VideoPresentationStatus {
  if (result.kind === "detached") return "detached";
  if (result.kind === "unresolved") return "unresolved";
  return "healthy";
}

/**
 * Flatten the engine's buffered ranges into plain `{start,end}` numbers.
 *
 * The engine hand-off (`mpvAudio.getBuffered` -> `toTimeRanges`) is a closure
 * object satisfying `TimeRanges`, which is NOT structured-cloneable: sending it
 * over Tauri IPC yields a useless payload. Copying it here is the only way the
 * PiP window can draw a buffer fill.
 *
 * Degrades to `[]` — never throws — because a bad buffer reading must not take
 * the WHOLE state publish down (title/time/volume would go stale too). Ranges
 * that cannot be drawn (`NaN`, `end <= start`) are dropped for the same reason
 * the main-window buffer bar ignores them.
 */
function readPipBuffered(audio: AudioController): BufferedRangePayload[] {
  try {
    // `getBuffered()` is typed, but the engine can be mid-release and hand
    // back something unexpected; treat it as unknown and validate before use.
    const source: unknown = audio.getBuffered();
    if (typeof source !== "object" || source === null) {
      logPipError("pip-state-buffered-failed", "no buffered source", "warn");
      return [];
    }
    const ranges: unknown = (source as { buffered?: unknown }).buffered;
    if (
      typeof ranges !== "object" ||
      ranges === null ||
      typeof (ranges as TimeRanges).length !== "number" ||
      typeof (ranges as TimeRanges).start !== "function" ||
      typeof (ranges as TimeRanges).end !== "function"
    ) {
      logPipError(
        "pip-state-buffered-failed",
        "unexpected TimeRanges shape",
        "warn",
      );
      return [];
    }
    const buffered = ranges as TimeRanges;
    const count = buffered.length;
    const flattened: BufferedRangePayload[] = [];
    for (let i = 0; i < count; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (end <= start) continue;
      flattened.push({ start, end });
    }
    return flattened;
  } catch (error) {
    logPipError("pip-state-buffered-failed", error, "warn");
    return [];
  }
}

export interface PipControllerDeps {
  /** `usePlayer().currentTrack` — payload `title`/`hasTrack`, khoá reset `pipStateTrackId`. */
  currentTrack: Track | null;
  /** `usePlayer().isPlaying` — payload + quyết định resume lúc enter. */
  isPlaying: boolean;
  /** `usePlayer().isDownloading` — payload. */
  isDownloading: boolean;
  /** App tính bằng `classifyMediaKind`; hook không tính lại. */
  isVideoActive: boolean;
  /** `usePlayerStore(s => s.errorInfo) !== null` — payload `hasError`. */
  hasError: boolean;
  /** `usePlayer().loadNonce` — khoá reset thứ hai. */
  loadNonce: number;
  /** App truyền `stableHandleTogglePlay` (identity ổn định, đọc handler mới nhất qua ref). */
  onTogglePlay: () => void;
  /** App truyền `stableHandleNextTrack`. */
  onNextTrack: () => void;
  /** App truyền `stableHandlePrevTrack`. */
  onPrevTrack: () => void;
  /** App truyền `setIsNowPlayingOpen`. */
  setIsNowPlayingOpen: (open: boolean) => void;
  /** App truyền `setIsPlayerFullscreen`. */
  setIsPlayerFullscreen: (fullscreen: boolean) => void;
}

export interface PipController {
  /** Mirror state — App truyền cho `NowPlayingOverlay isPipActive`. */
  isPipActive: boolean;
  /** Whether a native presentation pipeline is known to exist (see
   *  `VideoPresentationStatus`). Independent of the owner on purpose. */
  presentationStatus: VideoPresentationStatus;
  /** Enter only, fire-and-forget (guard nội bộ). */
  enterPip: () => void;
  /** Trả về app: restore + focus + mở Now Playing. */
  returnFromPip: () => void;
  /** Hand back + pause, KHÔNG restore cửa sổ chính. */
  closePipToBackground: () => void;
  /** Ctrl+P: một chord hai chiều, quyết định bằng `isPipActiveRef`. */
  togglePip: () => void;
}

/**
 * Owns the whole PiP hand-off protocol: state publishing, the enter/return/
 * close transactions, the liveness poller and the `pip-action` bridge.
 *
 * Extracted verbatim from App.tsx (refactor only — every step, order, log
 * kind/level and toast is unchanged). `deps` carries the App-owned values;
 * the ref mirror below exists only because the event listeners are registered
 * once and must not close over a stale render.
 */
export function usePipController(deps: PipControllerDeps): PipController {
  const {
    currentTrack,
    isPlaying,
    isDownloading,
    isVideoActive,
    hasError,
    loadNonce,
    setIsNowPlayingOpen,
    setIsPlayerFullscreen,
  } = deps;

  const [isBuffering, setIsBuffering] = useState(false);
  const [hasEnded, setHasEnded] = useState(false);
  /**
   * Mirror of the module-level presentation status (lib/videoHost). The owner
   * says who the surface was last CONFIRMED to belong to; this says whether a
   * pipeline to that owner is known to exist. Kept as React state only so the
   * value is observable/assertable and survives a re-render — every write goes
   * through `commitPresentationStatus`, which updates both copies together.
   */
  const [presentationStatus, setPresentationStatus] =
    useState<VideoPresentationStatus>("healthy");
  const [pipStateTrackId, setPipStateTrackId] = useState(currentTrack?.id);
  const [pipStateLoadNonce, setPipStateLoadNonce] = useState(loadNonce);
  if (pipStateTrackId !== currentTrack?.id || pipStateLoadNonce !== loadNonce) {
    setPipStateTrackId(currentTrack?.id);
    setPipStateLoadNonce(loadNonce);
    setIsBuffering(false);
    setHasEnded(false);
  }
  const pipTransitionRef = useRef(false);
  // Mirror of isPipActive that event listeners and async recovery reads can
  // trust synchronously (state updates are not visible until the next render).
  const isPipActiveRef = useRef(false);
  const [isPipActive, setIsPipActive] = useState(false);

  // Freshest deps for the imperative paths (event listeners registered once).
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  }, [deps]);

  useEffect(() => {
    const audio = AudioController.getInstance();
    const isForeign = (identity: { trackId?: string } | undefined): boolean =>
      isForeignTrackEvent(identity, usePlayerStore.getState().currentTrack?.id);
    const unsubBuffering = audio.on(
      "buffering",
      ({ isBuffering: buffering, ...identity }) => {
        if (isForeign(identity)) return;
        setIsBuffering(buffering);
      },
    );
    const unsubEnded = audio.on("ended", (identity) => {
      if (isForeign(identity)) return;
      setHasEnded(true);
    });
    // A new engine `play` (auto-advance, replay, resume) starts a fresh
    // timeline: an untagged `ended` from the previous item must not keep the
    // video surface hidden for the next one.
    const unsubPlay = audio.on("play", (identity) => {
      if (isForeign(identity)) return;
      setHasEnded(false);
    });
    return () => {
      unsubBuffering();
      unsubEnded();
      unsubPlay();
    };
  }, []);

  useEffect(() => {
    isPipActiveRef.current = isPipActive;
  }, [isPipActive]);

  /**
   * Single writer for the presentation status: the React mirror and the
   * module-level copy must never diverge, because the geometry code reads the
   * module value synchronously (no render) while the UI/tests read this state.
   */
  const commitPresentationStatus = useCallback(
    (status: VideoPresentationStatus) => {
      setVideoPresentationStatus(status);
      setPresentationStatus(status);
    },
    [],
  );

  const publishPipState = useCallback(() => {
    const audio = AudioController.getInstance();
    const payload: PipStatePayload = {
      title: currentTrack?.title ?? "",
      isPlaying,
      currentTime: safePlaybackTime(audio.getCurrentTime()),
      duration: safePlaybackTime(audio.getDuration()),
      volume: safePlaybackVolume(audio.getVolume()),
      isMuted: audio.isMuted(),
      hasTrack: currentTrack !== null,
      isVideo: isVideoActive,
      isBuffering,
      hasError,
      hasEnded,
      buffered: readPipBuffered(audio),
      isDownloading,
      trackId: currentTrack?.id ?? null,
    };
    try {
      void emitTo(PIP_WINDOW_LABEL, PIP_EVENTS.state, payload).catch(
        (error: unknown) => {
          logPipError("pip-state-publish-failed", error, "warn");
        },
      );
    } catch (error) {
      logPipError("pip-state-publish-failed", error, "warn");
    }
  }, [
    currentTrack,
    isPlaying,
    isVideoActive,
    isBuffering,
    hasError,
    hasEnded,
    isDownloading,
  ]);

  const publishPipStateRef = useRef<() => void>(() => {});
  useEffect(() => {
    publishPipStateRef.current = publishPipState;
  }, [publishPipState]);

  // The main window can be minimized/hidden (tray) while PiP owns the video.
  // Returning must restore it BEFORE the PiP surface is destroyed, or the
  // retarget lands in a window nobody can see. Each step is independent:
  // show() on a minimized window is a no-op, so unminimize() is required too.
  const restoreMainWindowForPip = useCallback(async () => {
    try {
      const mainWindow = getCurrentWindow();
      try {
        await mainWindow.show();
      } catch (error) {
        logPipError("return-main-show-failed", error, "warn");
      }
      try {
        await mainWindow.unminimize();
      } catch (error) {
        logPipError("return-main-unminimize-failed", error, "warn");
      }
      try {
        await mainWindow.setFocus();
      } catch (error) {
        logPipError("return-main-focus-failed", error, "warn");
      }
    } catch (error) {
      logPipError("return-main-window-failed", error, "warn");
    }
  }, []);

  const enterPip = useCallback(async () => {
    if (pipTransitionRef.current || isPipActiveRef.current) return;
    if (!isVideoActive) {
      showErrorToast(i18next.t("player.pip.no_video"));
      return;
    }

    pipTransitionRef.current = true;
    let retargetedToPip = false;
    // Kept so the failure tail can report the HONEST pipeline status from the
    // outcome that actually failed, instead of guessing from "entry failed".
    let enterHandoff: PipHandoffResult | null = null;
    try {
      await openPipWindowAndWaitReady();
      publishPipStateRef.current();
      // The retarget needs a LIVE render surface, and that surface only exists
      // once the engine has been spawned (`player::ensure_spawned_with_window`
      // publishes ACTIVE_SURFACE; `video_surface_retarget` returns "no active
      // render surface to retarget" before that).
      //
      // A fresh session has no engine yet - the track was selected but never
      // played - so entering PiP there used to fail outright and surface the
      // "Couldn't open Picture in Picture" toast. Spawning first fixes it.
      //
      // `mpv_spawn` is the right call, not a play: it is idempotent while an
      // engine is alive (answers `{conn}` immediately), it creates the engine
      // and its render surface bound to the MAIN window, and it loads no
      // media. No frame is painted into main, so the resume below still owns
      // the first frame - and that frame lands in PiP.
      try {
        await invoke("mpv_spawn");
      } catch (error) {
        // Not fatal: an already-live engine answers Ok, and a real failure is
        // re-surfaced by the retarget right below. Log with context and go on.
        logPipError("enter-spawn-failed", error, "warn");
      }
      const pipResult = await handoffSurfaceToPip();
      enterHandoff = pipResult;
      // Only `retargeted` means PiP really presents the surface. The other two
      // resolved outcomes and any rejection must take the existing rollback
      // path below, so the window is never marked active on a failed switch.
      if (pipResult.kind !== "retargeted") {
        throw new Error(`pip retarget ${pipResult.kind}`);
      }
      retargetedToPip = true;
      commitPresentationStatus("healthy");
      setPipHostOwner("pip");

      let ownerSynced = await requestPipOwner("pip");
      if (!ownerSynced) {
        ownerSynced = await requestPipOwner("pip");
      }
      if (!ownerSynced) {
        throw new Error("pip window did not acknowledge ownership");
      }

      isPipActiveRef.current = true;
      setIsPipActive(true);
      setIsNowPlayingOpen(false);
      setIsPlayerFullscreen(false);
      publishPipStateRef.current();

      // Resume LAST, once the floating window is fully up: retargeted, owner
      // acknowledged, state published. Starting playback any earlier paints
      // the first frames in the MAIN window and then rips them across to PiP,
      // which reads as a flicker. Here the surface is already PiP's, so the
      // first frame the engine produces lands in the window that will show it.
      //
      // WHY resume at all: PiP is a video PRESENTATION, not a playback control.
      // Two cases arrive paused — a fresh session where the track was selected
      // but never started, and a mid-watch pause — and both would otherwise
      // hand over a surface with no frames (the black/“looks broken” window).
      //
      // `handleTogglePlay` is the only path that starts playback with the full
      // intent/queue bookkeeping (playbackIntent.ts), so it is reused rather
      // than calling the engine directly; when already playing this branch does
      // not run. Still fire-and-forget: playback start is never awaited anywhere
      // in the app (token fetch included), and the surface renders itself once
      // the engine has a frame.
      //
      // An ENDED video is left to the same call on purpose: `mpvAudio.playTrack`
      // treats a finished item as a fresh load (`playbackFinished` is true after
      // EOF), so the result is a replay from 0 — exactly what pressing Play on
      // an ended item does.
      //
      // Deliberately NOT in the catch/rollback paths: a failed entry leaves the
      // user where they were rather than starting playback into a window that
      // may be about to disappear.
      if (!isPlaying) {
        depsRef.current.onTogglePlay();
      }
    } catch (error) {
      logPipError("enter-failed", error);
      if (retargetedToPip) {
        const rollback = await handoffSurfaceToMain();
        if (rollback.kind !== "retargeted") {
          logPipError(
            "enter-rollback-retarget-failed",
            new Error(`rollback ${rollback.kind}`),
          );
          // The native target may still be the PiP window. Declaring main
          // here would strand the picture, so keep PiP as the presentation
          // owner (and the window alive) until a successful Return retries.
          //
          // Honest status: this branch only runs when PiP DID take ownership
          // (`retargetedToPip`), so the previous target the native side falls
          // back to is PiP itself. `rolled_back` therefore means the PiP
          // pipeline was recreated intact (healthy); `detached` means nothing
          // presents at all; `unresolved` means we simply do not know.
          commitPresentationStatus(statusForHandoff(rollback));
          isPipActiveRef.current = true;
          setIsPipActive(true);
          setIsNowPlayingOpen(false);
          setIsPlayerFullscreen(false);
          setPipHostOwner("pip");
          const resynced = await requestPipOwner("pip");
          if (!resynced) {
            logPipError(
              "enter-rollback-owner-resync-failed",
              new Error("pip window did not acknowledge ownership"),
              "warn",
            );
          }
          showErrorToast(i18next.t("player.pip.enter_error"));
          return;
        }
      }
      // Entry failed (or was rolled back to main).
      //
      // Two distinct situations, and only the second one can leave a broken
      // pipeline behind:
      //  * `retargetedToPip` — PiP took the surface and the rollback above
      //    SUCCEEDED (`retargeted`), so main presents again: healthy.
      //  * PiP never owned it. A `rolled_back` to-PiP hand-off means the
      //    previous (main) target was recreated, also healthy; `detached` and
      //    `unresolved` are carried over verbatim. No hand-off at all (the
      //    window failed to open) never touched the surface: healthy.
      if (retargetedToPip) {
        commitPresentationStatus("healthy");
      } else {
        commitPresentationStatus(
          enterHandoff === null ? "healthy" : statusForHandoff(enterHandoff),
        );
      }
      setPipHostOwner("main");
      isPipActiveRef.current = false;
      setIsPipActive(false);
      setIsNowPlayingOpen(true);
      showErrorToast(i18next.t("player.pip.enter_error"));
      try {
        await closePipWindow();
      } catch (closeError) {
        logPipError("enter-rollback-close-failed", closeError);
      }
    } finally {
      pipTransitionRef.current = false;
    }
  }, [
    commitPresentationStatus,
    isVideoActive,
    isPlaying,
    setIsNowPlayingOpen,
    setIsPlayerFullscreen,
  ]);

  const returnFromPip = useCallback(async () => {
    if (!isPipActiveRef.current || pipTransitionRef.current) return;
    pipTransitionRef.current = true;

    try {
      const result = await handoffSurfaceToMain();
      if (result.kind !== "retargeted") {
        // The surface did NOT make it back: leave the main window alone (no
        // restore/unminimize/focus — bringing forward a window with no picture
        // is worse than staying in PiP), keep the PiP ownership and window so
        // the user still has something to watch and a way to retry.
        commitPresentationStatus(
          result.kind === "rolled_back"
            ? "healthy"
            : result.kind === "detached"
              ? "detached"
              : "unresolved",
        );
        logPipError(
          result.kind === "rolled_back"
            ? "return-handoff-rolled-back"
            : result.kind === "detached"
              ? "return-handoff-detached"
              : "return-handoff-unresolved",
          result.kind === "unresolved" ? result.reason : result.kind,
        );
        try {
          await emitTo(PIP_WINDOW_LABEL, PIP_EVENTS.refreshSurface);
        } catch (refreshError) {
          logPipError("return-refresh-failed", refreshError, "warn");
        }
        showErrorToast(i18next.t("player.pip.return_error"));
        return;
      }

      commitPresentationStatus("healthy");
      // Retarget succeeded; the main window owns the surface now. Restore its
      // visibility BEFORE tearing the PiP window down.
      await restoreMainWindowForPip();

      setPipHostOwner("main");
      isPipActiveRef.current = false;
      setIsPipActive(false);
      setIsNowPlayingOpen(true);

      try {
        await closePipWindow();
      } catch (error) {
        logPipError("return-close-failed", error);
      }
    } finally {
      pipTransitionRef.current = false;
    }
  }, [commitPresentationStatus, restoreMainWindowForPip, setIsNowPlayingOpen]);

  /**
   * Close (X in the PiP window / Alt+F4): pause, hand the surface back to main
   * and tear the PiP window down, leaving the main window exactly where it is.
   *
   * Deliberately NOT `returnFromPip`: Return is "bring me back to the app"
   * (show + unminimize + focus + open Now Playing) and playback follows the
   * user into it. Close is the user saying "stop watching this" — the picture
   * goes back to main PAUSED while the app stays in the background (not shown,
   * not focused, not unminimized, Now Playing not forced open).
   *
   * WHY the pause is written here rather than through `handleTogglePlay`:
   * the toggle flips, so closing an ALREADY paused video would start it. The
   * two writers used below are the same pair the pause branch of
   * `handleTogglePlay` uses (engine first, then the named store commit), so
   * this path stays one source of truth without inheriting the toggle.
   *
   * The hand-off must SUCCEED before anything is torn down. This used to be
   * best-effort (log, then destroy the window anyway), which stranded the
   * native surface in a window that no longer existed: the user lost the
   * picture entirely and had nothing left to click. Now a failed hand-off
   * leaves the PiP window UP — the user keeps a recovery surface, sees the
   * video still there, and can press Close again (the guard is released in
   * `finally`), which retries the hand-off from scratch.
   */
  const closePipToBackground = useCallback(async () => {
    if (!isPipActiveRef.current || pipTransitionRef.current) return;
    pipTransitionRef.current = true;

    try {
      const result = await handoffSurfaceToMain();
      if (result.kind !== "retargeted") {
        // `rolled_back` = the native side recreated the PREVIOUS (PiP) target,
        // so the picture is still there and the pipeline is healthy.
        commitPresentationStatus(statusForHandoff(result));
        logPipError(
          result.kind === "rolled_back"
            ? "close-handoff-rolled-back"
            : result.kind === "detached"
              ? "close-handoff-detached"
              : "close-handoff-unresolved",
          result.kind === "unresolved" ? result.reason : result.kind,
        );
        // Best-effort only: ask the PiP window to re-measure once, in case the
        // target it was rolled back into lost its rect. Still its own
        // try/catch — a failed refresh must not skip the return below.
        try {
          await emitTo(PIP_WINDOW_LABEL, PIP_EVENTS.refreshSurface);
        } catch (refreshError) {
          logPipError("close-refresh-failed", refreshError, "warn");
        }
        return;
      }

      commitPresentationStatus("healthy");
      // Pause ONLY when something is actually playing: a close of a paused
      // video must not issue an engine command or touch the flag. Pausing here
      // (after a successful hand-off, never before) is what makes the failure
      // path above non-destructive: a failed close must not stop playback.
      if (usePlayerStore.getState().isPlaying) {
        AudioController.getInstance().pause();
        commitIsPlaying("intent", false);
      }

      setPipHostOwner("main");
      isPipActiveRef.current = false;
      setIsPipActive(false);

      try {
        await closePipWindow();
      } catch (error) {
        logPipError("close-close-failed", error);
      }
    } finally {
      pipTransitionRef.current = false;
    }
  }, [commitPresentationStatus]);

  const recoverFromExternalPipClose = useCallback(async () => {
    if (!isPipActiveRef.current || pipTransitionRef.current) return;
    pipTransitionRef.current = true;
    // Stop accepting PiP actions immediately: that window is gone.
    isPipActiveRef.current = false;
    try {
      logPipError(
        "pip-window-lost",
        "pip window disappeared while active; recovering to main",
        "warn",
      );
      // `handoffSurfaceToMain` never throws — a rejection is already folded
      // into `unresolved` — so there is no try/catch here on purpose.
      const result = await handoffSurfaceToMain();
      // Deliberately NOT `statusForHandoff`: that helper calls a `rolled_back`
      // healthy because there the PREVIOUS target is worth watching. Here the
      // previous target is the PiP window that just DISAPPEARED (this runs from
      // the liveness poller after `isPipWindowOpen()` answered false), so a
      // recreated PiP surface presents into a destroyed HWND — as useless as
      // `detached`. Only a real retarget to main yields a working pipeline.
      commitPresentationStatus(
        result.kind === "retargeted"
          ? "healthy"
          : result.kind === "detached"
            ? "detached"
            : "unresolved",
      );
      if (result.kind !== "retargeted") {
        logPipError(
          `pip-lost-handoff-${result.kind}`,
          result.kind === "unresolved" ? result.reason : result.kind,
        );
      }
      await restoreMainWindowForPip();
      setPipHostOwner("main");
      setIsPipActive(false);
      setIsNowPlayingOpen(true);
      showErrorToast(i18next.t("player.pip.return_error"));
    } finally {
      pipTransitionRef.current = false;
    }
  }, [commitPresentationStatus, restoreMainWindowForPip, setIsNowPlayingOpen]);

  // External destroy/crash: nothing in the PiP document can notify main, so
  // the owner polls for the window's existence and recovers the UI rather
  // than leaving isPipActive (and the hidden Now Playing overlay) latched.
  useEffect(() => {
    if (!isPipActive) return;
    let disposed = false;
    let checking = false;
    const timer = window.setInterval(() => {
      if (disposed || checking) return;
      checking = true;
      void isPipWindowOpen()
        .then((open) => {
          if (disposed || open || !isPipActiveRef.current) return;
          void recoverFromExternalPipClose();
        })
        .catch((error: unknown) => {
          logPipError("pip-window-poll-failed", error, "warn");
        })
        .finally(() => {
          checking = false;
        });
    }, PIP_WINDOW_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [isPipActive, recoverFromExternalPipClose]);

  // Music auto-advance while PiP is up: PiP only makes sense for video, and
  // suppressing Now Playing for audio would leave the track invisible.
  useEffect(() => {
    if (isPipActive && !isVideoActive) {
      void returnFromPip();
    }
  }, [isPipActive, isVideoActive, returnFromPip]);

  const returnFromPipRef = useRef<() => void>(() => {});
  useEffect(() => {
    returnFromPipRef.current = () => {
      void returnFromPip();
    };
  }, [returnFromPip]);

  // Same ref-delegate pattern as returnFromPipRef: the action listener is
  // registered once (empty deps), so it must not close over a stale callback.
  const closePipToBackgroundRef = useRef<() => void>(() => {});
  useEffect(() => {
    closePipToBackgroundRef.current = () => {
      void closePipToBackground();
    };
  }, [closePipToBackground]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let disposed = false;

    const track = (promise: Promise<() => void>, label: string): void => {
      void promise
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unsubs.push(unlisten);
        })
        .catch((error: unknown) => {
          logPipError(`${label}-listen-failed`, error, "warn");
        });
    };

    track(
      listen<unknown>(PIP_EVENTS.action, (event) => {
        const raw: unknown = event.payload;
        if (typeof raw !== "object" || raw === null) {
          logPipError("pip-action-invalid", "empty payload", "warn");
          return;
        }
        const { action, payload } = raw as PipActionEvent;
        if (action === undefined) {
          logPipError("pip-action-invalid", "missing action", "warn");
          return;
        }
        // A stale PiP window (failed teardown, post-reload page, or after main
        // already returned) must not drive playback. Return is gated too; its
        // own handler is a no-op when PiP is not active.
        if (!isPipActiveRef.current) {
          logPipError("pip-action-ignored", action, "warn");
          return;
        }
        const audio = AudioController.getInstance();

        switch (action) {
          case "togglePlay":
            depsRef.current.onTogglePlay();
            break;
          case "prev":
            depsRef.current.onPrevTrack();
            break;
          case "next":
            depsRef.current.onNextTrack();
            break;
          case "seek": {
            const seekPayload = payload;
            if (
              typeof seekPayload !== "number" ||
              !Number.isFinite(seekPayload)
            ) {
              logPipError("pip-action-invalid", "invalid seek payload", "warn");
              break;
            }
            const duration = safePlaybackTime(audio.getDuration());
            const target =
              duration > 0
                ? Math.min(Math.max(0, seekPayload), duration)
                : Math.max(0, seekPayload);
            audio.seek(target);
            break;
          }
          case "setVolume": {
            const volumePayload = payload;
            if (
              typeof volumePayload !== "number" ||
              !Number.isFinite(volumePayload)
            ) {
              logPipError(
                "pip-action-invalid",
                "invalid setVolume payload",
                "warn",
              );
              break;
            }
            const volume = Math.min(1, Math.max(0, volumePayload));
            if (volume > 0 && audio.isMuted()) {
              audio.toggleMute();
            }
            audio.setVolume(volume);
            // The PiP slider is a second view of the SAME engine value, so the
            // PlayerBar / NowPlaying sliders must follow it. Keyboard chords
            // already announce through this bus; the PiP path is an external
            // writer and has to announce too, or the two views drift apart.
            //
            // Re-read from the engine instead of reusing the payload: the
            // auto-unmute branch above may have flipped `isMuted`, so the bus
            // must carry the state that actually landed.
            emitPlayerUi("volume-changed", {
              volume: audio.getVolume(),
              muted: audio.isMuted(),
            });
            break;
          }
          case "toggleMute":
            audio.toggleMute();
            // The PiP slider is a second view of the SAME engine value, so the
            // PlayerBar / NowPlaying sliders must follow it. Keyboard chords
            // already announce through this bus; the PiP path is an external
            // writer and has to announce too, or the two views drift apart.
            //
            // Muting flips one engine flag and preserves the other (the level
            // is kept for unmute), so the announcement describes the state the
            // engine now holds rather than a pair this call site reconstructs.
            emitPlayerUi("volume-changed", {
              volume: audio.getVolume(),
              muted: audio.isMuted(),
            });
            break;
          case "retry":
            // Same retry the PlayerBar / NowPlaying error button runs (storm
            // guard reset + replay of the store's current track), so the PiP
            // error surface cannot drift from the fullscreen one. It reads the
            // store directly — no ref delegate needed.
            retryCurrentTrack();
            break;
          case "return":
            returnFromPipRef.current();
            break;
          case "closePip":
            closePipToBackgroundRef.current();
            break;
          default:
            logPipError("pip-action-unknown", action, "warn");
            break;
        }

        if (action !== "seek" && action !== "return" && action !== "closePip") {
          window.setTimeout(() => {
            publishPipStateRef.current();
          }, 0);
        }
      }),
      "pip-action",
    );

    track(
      listen(PIP_EVENTS.closeRequested, () => {
        if (!isPipActiveRef.current) return;
        // A native close request (Alt+F4; the window is undecorated so there
        // is no title-bar X) is the same intent as the in-window X: dismiss
        // the floating window, keep everything else untouched.
        closePipToBackgroundRef.current();
      }),
      "pip-close-requested",
    );

    track(
      listen(PIP_EVENTS.ready, () => {
        publishPipStateRef.current();
      }),
      "pip-ready",
    );

    return () => {
      disposed = true;
      unsubs.forEach((unlisten) => {
        unlisten();
      });
    };
  }, []);

  useEffect(() => {
    if (!isPipActive) return;
    publishPipState();
    const timer = window.setInterval(publishPipState, PIP_STATE_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [isPipActive, publishPipState]);

  const enterPipRequest = useCallback(() => {
    void enterPip();
  }, [enterPip]);

  const returnPipRequest = useCallback(() => {
    void returnFromPip();
  }, [returnFromPip]);

  const closePipRequest = useCallback(() => {
    void closePipToBackground();
  }, [closePipToBackground]);

  // Ctrl+P: one chord, two directions. `enterPip`/`returnFromPip` each guard
  // their own state, so the branch reads the same mirror those guards use (the
  // rendered state can lag a pending async transition).
  const togglePip = useCallback(() => {
    if (isPipActiveRef.current) {
      void returnFromPip();
    } else {
      void enterPip();
    }
  }, [enterPip, returnFromPip]);

  return {
    isPipActive,
    presentationStatus,
    enterPip: enterPipRequest,
    returnFromPip: returnPipRequest,
    closePipToBackground: closePipRequest,
    togglePip,
  };
}
