import { captureError } from "../../utils/errorLog";

export const PIP_WINDOW_LABEL = "pip";

export const PIP_EVENTS = {
  ready: "pip-ready",
  requestReady: "pip-request-ready",
  state: "pip-state",
  action: "pip-action",
  owner: "pip-owner",
  ownerAck: "pip-owner-ack",
  release: "pip-release",
  releaseAck: "pip-release-ack",
  closeRequested: "pip-close-requested",
  refreshSurface: "pip-surface-refresh",
} as const;

const LOGGER_SOURCE = "pipWindow";
export const PIP_READY_TIMEOUT_MS = 6_000;
export const PIP_ACK_TIMEOUT_MS = 1_200;
export const PIP_CLOSE_VERIFY_MS = 250;
export const PIP_CLOSE_ATTEMPTS = 2;

export type PipOwner = "main" | "pip";

export type PipActionName =
  | "togglePlay"
  | "prev"
  | "next"
  | "seek"
  | "setVolume"
  | "toggleMute"
  | "retry"
  | "return"
  /** Hand the video back and disappear WITHOUT bringing the app forward. */
  | "closePip";

export interface PipWindowOptions {
  width?: number;
  height?: number;
}

export interface PipActionEvent {
  action?: string;
  payload?: unknown;
}

/**
 * One buffered segment, as PLAIN data.
 *
 * Why not ship the engine's `TimeRanges` directly: `AudioController.getBuffered`
 * returns an object whose `start`/`end` are closures (see `toTimeRanges` in
 * mpvProtocol.ts). Closures are not structured-cloneable, so Tauri's IPC would
 * drop or corrupt them. The main window therefore flattens the ranges once and
 * the PiP window only ever sees `{start,end}` numbers.
 */
export interface BufferedRangePayload {
  start: number;
  end: number;
}

export interface PipStatePayload {
  title: string;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  hasTrack: boolean;
  isVideo: boolean;
  isBuffering: boolean;
  hasError: boolean;
  hasEnded: boolean;
  /** Buffered segments for the PiP seekbar's buffer fill. Empty when unknown. */
  buffered: BufferedRangePayload[];
  /** "Preparing to play" intent window — gates the PiP spinner exactly like
   *  the fullscreen transport surfaces (isDownloading || isBuffering). */
  isDownloading: boolean;
  /**
   * Stable identity of the current media (`Track.id`), `null` when no track is
   * selected. Optional so every partial publish stays type-safe under
   * `exactOptionalPropertyTypes`; the PiP view treats a missing field as
   * "no identity", exactly like `null`.
   *
   * WHY it is here at all: the PiP window keys its aspect-ratio re-apply on the
   * media identity, and title+duration cannot distinguish two different items
   * that happen to share both.
   */
  trackId?: string | null;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logPipFailure(
  level: "warn" | "error",
  kind: string,
  error: unknown,
): void {
  void captureError({
    level,
    source: LOGGER_SOURCE,
    message: `${kind}: ${describeError(error)}`,
    kind,
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(() => {
      resolve();
    }, ms);
  });
}
