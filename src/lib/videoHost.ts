/**
 * React side of the native video host (VIDEO-EMBEDDING-ARCHITECTURE.md,
 * Slice 2). The pixels come from a Win32 child HWND that Rust creates and
 * positions; this module owns the three IPC calls plus the pure geometry /
 * visibility decisions, so both the engine (ordering) and the surface
 * (rect + visibility) share one source of truth.
 *
 * NOT a <video> element and never one: the HWND paints above the WebView2
 * surface, so React cannot draw over it and must never overlap the rect.
 */

import { invoke } from "@tauri-apps/api/core";
import { captureError } from "../utils/errorLog";

export const VIDEO_HOST_COMMANDS = {
  acquire: "video_host_acquire",
  setRect: "video_host_set_rect",
  setVisible: "video_host_set_visible",
  firstFramePresented: "video_host_first_frame_presented",
} as const;

const LOGGER_SOURCE = "videoHost";

/** Physical-pixel rect, relative to the Tauri window's CLIENT area. */
export interface PhysicalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Shared acquire attempt. `null` = not started, so a failure can be retried;
 *  a resolved handle memoizes for the whole session (Rust acquire is
 *  idempotent, but one IPC per session is still one IPC less). */
let acquireInFlight: Promise<number> | null = null;

/**
 * Create-or-reuse the host HWND. MUST complete before the first `mpv_spawn`:
 * mpv reads `--wid` only at spawn, so a spawn that wins the race renders into
 * mpv's own top-level window for that whole engine session. The engine awaits
 * this immediately before spawning (mpvAudio.startEngine); App also calls it on
 * startup so the host exists even in a session that never plays video.
 *
 * Resolves 0 when the host is unavailable — a missing host degrades to mpv's
 * own window (the pre-Slice-1 behavior), never to a thrown error that would
 * take playback down with it.
 */
export function ensureVideoHostAcquired(): Promise<number> {
  acquireInFlight ??= invoke<number>(VIDEO_HOST_COMMANDS.acquire)
    .then((hwnd) => (typeof hwnd === "number" ? hwnd : 0))
    .catch((e: unknown) => {
      void captureError({
        level: "warn",
        source: LOGGER_SOURCE,
        message: `acquire-failed: ${e instanceof Error ? e.message : String(e)}`,
        kind: "video-host-acquire-failed",
      });
      return 0;
    })
    .then((hwnd) => {
      // A 0 must not be memoized forever: the window may not have been ready.
      if (hwnd === 0) acquireInFlight = null;
      return hwnd;
    });
  return acquireInFlight;
}

/** Move/resize the host. Fire-and-forget: a failed rect call must never break
 *  a render, and Rust logs the real cause. */
export function setVideoHostRect(rect: PhysicalRect): void {
  void invoke(VIDEO_HOST_COMMANDS.setRect, {
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
  }).catch((e: unknown) => {
    void captureError({
      level: "warn",
      source: LOGGER_SOURCE,
      message: `set-rect-failed: ${e instanceof Error ? e.message : String(e)}`,
      kind: "video-host-set-rect-failed",
    });
  });
}

/** Show/hide the host. Idempotent on the Rust side, so this is safe to send on
 *  every transition. */
export function setVideoHostVisible(visible: boolean): void {
  void invoke(VIDEO_HOST_COMMANDS.setVisible, { visible }).catch(
    (e: unknown) => {
      void captureError({
        level: "warn",
        source: LOGGER_SOURCE,
        message: `set-visible-failed: ${String(visible)} / ${e instanceof Error ? e.message : String(e)}`,
        kind: "video-host-set-visible-failed",
      });
    },
  );
}

/**
 * Pull complement to the one-shot `video-first-frame` event: has the render
 * thread already handed a frame of the CURRENT media load to the composition
 * surface? The event has no replay, so a listener that (re)registered after
 * the emit — page reload while the engine kept playing, a warm-engine media
 * switch — asks this instead and recovers the signal.
 *
 * Resolves false on any failure (legacy engine, no engine, IPC error): "no
 * frame yet" is the safe answer, and the push event remains the fast path.
 */
export function firstFramePresented(): Promise<boolean> {
  return invoke<boolean>(VIDEO_HOST_COMMANDS.firstFramePresented).catch(
    (e: unknown) => {
      void captureError({
        level: "warn",
        source: LOGGER_SOURCE,
        message: `first-frame-pull-failed: ${e instanceof Error ? e.message : String(e)}`,
        kind: "video-host-first-frame-pull-failed",
      });
      return false;
    },
  );
}

/**
 * CSS px (from getBoundingClientRect, viewport-relative) -> physical px
 * (relative to the window's client area).
 *
 * The multiply by devicePixelRatio is exact for this app: tao puts the process
 * in PER_MONITOR_AWARE_V2 mode, so GetClientRect returns PHYSICAL pixels with
 * no DPI virtualization, and wry sizes the WebView2 child window to exactly
 * that client rect at client origin (0,0) — see the report for the code
 * evidence. So `physical = css * devicePixelRatio` with zero offset.
 *
 * Returns null for a collapsed box (minimized window, or a rect read before
 * first layout): a zero/negative size is not a window, so it must never reach
 * Rust.
 */
export function toPhysicalRect(
  rect: { left: number; top: number; width: number; height: number },
  devicePixelRatio: number,
): PhysicalRect | null {
  if (
    !Number.isFinite(devicePixelRatio) ||
    devicePixelRatio <= 0 ||
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return null;
  }
  const x = Math.round(rect.left * devicePixelRatio);
  const y = Math.round(rect.top * devicePixelRatio);
  const w = Math.round(rect.width * devicePixelRatio);
  const h = Math.round(rect.height * devicePixelRatio);
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

export function sameRect(a: PhysicalRect | null, b: PhysicalRect): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export interface VideoHostVisibilityInput {
  /** A track is loaded (nothing to show before the first one). */
  hasTrack: boolean;
  /** The loaded track is a VIDEO, per classifyMediaKind. */
  isVideo: boolean;
  /** The Now Playing overlay is open — video lives in that surface only. */
  isOpen: boolean;
  /** A full-screen modal covers the shell (login / folder selection). */
  isShellLocked: boolean;
  /** The current track errored. */
  hasError: boolean;
  /** mpv reported end-of-file for the current track. */
  hasEnded: boolean;
}

/**
 * The whole show/hide rule in one predicate — the SINGLE owner of host
 * visibility. Fullscreen is deliberately NOT a term here: it is a refinement
 * of the overlay, not a second surface, so it cannot change this decision.
 *
 * `hasError` hides the host deliberately: native child content cannot be
 * covered by CSS, so ErrorToast and the retry affordance would be painted
 * OVER by the host. Hiding is the only way to keep the error surface readable.
 *
 * `hasEnded` hides it for the same class of reason (the visible surface must
 * stay truthful), plus one more: after end-file there is no live frame, so
 * leaving the host up freezes the last frame on screen and it looks like it is
 * still playing while the queue advances underneath it.
 *
 * The Media Information dialog is deliberately NOT a term. It is a React
 * overlay (fixed inset-0, z-[10000]) and the DComp video composites BELOW the
 * webview, so the dialog simply draws on top of a still-rendering video. The
 * old hide-during-dialog term belonged to the native-child era (CSS could not
 * cover a native child HWND) and was removed with it.
 */
export function shouldShowVideoHost(input: VideoHostVisibilityInput): boolean {
  return (
    input.hasTrack &&
    input.isVideo &&
    input.isOpen &&
    !input.isShellLocked &&
    !input.hasError &&
    !input.hasEnded
  );
}
