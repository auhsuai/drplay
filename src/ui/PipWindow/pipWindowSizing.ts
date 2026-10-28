import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { getVideoAspect } from "../../lib/mpvControl/videoControls";
import { logPipViewFailure } from "./pipWindowLog";

/** Most of the monitor a PiP target may occupy, in LOGICAL px. The remaining
 *  10% is slack for the taskbar and for the window's own translated position,
 *  so a portrait video never ends up taller than the screen. */
const ASPECT_MONITOR_FRACTION = 0.9;
/** The min-size floor is a LENGTH on the long side, not two fixed axes: a floor
 *  that is not the video's ratio is re-clamped by WM_GETMINMAXINFO *after*
 *  WM_SIZING, which is exactly where a 16:9 lock leaks (320x180 -> 320x200). */
const ASPECT_MIN_LONG_SIDE_PX = 320;

export interface WindowSize {
  width: number;
  height: number;
}

export function safeTime(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export function safeVolume(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** The min-size floor that AGREES with `aspect`, so WM_GETMINMAXINFO cannot
 *  re-clamp a corner off the ratio. A 320px floor is applied to the LONG side
 *  and the short side is derived. */
export function minSizeForAspect(aspect: number): WindowSize {
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
export function clampToMonitor(
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
export async function applyPipAspect(): Promise<void> {
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
