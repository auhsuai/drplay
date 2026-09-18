/**
 * Tauri bridge to the app-owned Windows SMTC session
 * (src-tauri/src/media_controls.rs).
 *
 * - `updateMediaControls` pushes one player-state snapshot. The Rust side
 *   ignores snapshots that are not strictly newer than the applied
 *   `revision`, so a snapshot from track A can never overwrite track B's.
 * - `listenMediaControls` subscribes to OS button/timeline actions
 *   (`media-control` event) emitted by the Rust session.
 *
 * Outside Tauri (browser dev, jsdom) both functions no-op: there is no native
 * session to talk to, and media controls are accessory surface — never a
 * playback dependency. Failures are classified and logged; they must never
 * break playback.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { captureError } from "../utils/errorLog";

const MEDIA_CONTROLS_MODULE = "mediaControls";

export const MEDIA_CONTROLS_UPDATE_COMMAND = "media_controls_update";
export const MEDIA_CONTROL_EVENT = "media-control";

export type MediaControlAction =
  | "play"
  | "pause"
  | "toggle"
  | "stop"
  | "next"
  | "previous"
  | "seek"
  | "seek-forward"
  | "seek-backward";

export type MediaPlaybackState = "playing" | "paused" | "stopped";

export interface MediaControlsSnapshot {
  /** Strictly increasing per frontend call; stale revisions are dropped. */
  revision: number;
  title: string | null;
  artist: string | null;
  /** Track duration in seconds (null when unknown). */
  duration: number | null;
  playback: MediaPlaybackState;
  /** Playhead position in seconds (null when nothing is loaded). */
  position: number | null;
}

export interface MediaControlPayload {
  action: MediaControlAction;
  position?: number | null;
}

export const MEDIA_CONTROL_ACTIONS: ReadonlySet<string> = new Set([
  "play",
  "pause",
  "toggle",
  "stop",
  "next",
  "previous",
  "seek",
  "seek-forward",
  "seek-backward",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMediaControlPayload(
  value: unknown,
): value is MediaControlPayload {
  if (typeof value !== "object" || value === null) return false;
  const action = (value as { action?: unknown }).action;
  return typeof action === "string" && MEDIA_CONTROL_ACTIONS.has(action);
}

export async function updateMediaControls(
  snapshot: MediaControlsSnapshot,
): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke(MEDIA_CONTROLS_UPDATE_COMMAND, { update: snapshot });
  } catch (error) {
    void captureError({
      level: "warn",
      source: MEDIA_CONTROLS_MODULE,
      message: `update-failed: ${errorMessage(error)}`,
    });
  }
}

export async function listenMediaControls(
  handler: (payload: MediaControlPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  try {
    return await listen<unknown>(MEDIA_CONTROL_EVENT, (event) => {
      if (isMediaControlPayload(event.payload)) {
        handler(event.payload);
        return;
      }
      void captureError({
        level: "warn",
        source: MEDIA_CONTROLS_MODULE,
        message: "ignored malformed media-control payload",
      });
    });
  } catch (error) {
    void captureError({
      level: "warn",
      source: MEDIA_CONTROLS_MODULE,
      message: `listen-failed: ${errorMessage(error)}`,
    });
    return () => {};
  }
}
