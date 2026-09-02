/** Bounded-invoke plumbing for the tauri-plugin-native-audio bridge —
 *  command names, timeout budgets, the classified timeout error and the
 *  Promise.race wrapper. Pure infrastructure: no engine state, no DOM, no
 *  store access. */

/** Plugin command names (tauri-plugin-native-audio) — single source of truth;
 *  the exact strings are asserted in nativeAudioBridge.test.ts. */
export const PLUGIN_COMMAND = {
  initialize: "plugin:native-audio|initialize",
  play: "plugin:native-audio|play",
  pause: "plugin:native-audio|pause",
  setSource: "plugin:native-audio|set_source",
  seekTo: "plugin:native-audio|seek_to",
  // Read-only state probe (Kotlin NativeAudioPlugin.getState) — no audio, no
  // transport mutation. The resume health-check uses it both to verify the
  // invoke bridge is alive and to re-sync the authoritative player state.
  getState: "plugin:native-audio|get_state",
} as const;

// Long-suspend recovery bounds (values pinned by nativeAudioBridge.test.ts).
// Resume probe: pure local IPC with no media work — if get_state cannot
// answer within 3s the bridge is considered dead and re-init is the only
// recovery. Transport: bounded so one wedged invoke can never stall the FIFO
// playChain (play/pause/seek queue) forever. set_source is the one
// legitimately slow command (network load + container prepare) and gets its
// own larger budget.
export const RESUME_HEALTH_CHECK_TIMEOUT_MS = 3_000;
export const TRANSPORT_INVOKE_TIMEOUT_MS = 10_000;
export const SET_SOURCE_INVOKE_TIMEOUT_MS = 30_000;

/** Classified timeout failure for a native-audio invoke — the message carries
 *  the command name and the word "timeout" so callers can classify by string
 *  (same convention as apiClient.withTimeout). Never includes payload data. */
export class NativeInvokeTimeoutError extends Error {
  readonly command: string;
  constructor(command: string, ms: number) {
    super(
      `timeout: native audio command "${command}" did not respond within ${String(ms)}ms`,
    );
    this.name = "NativeInvokeTimeoutError";
    this.command = command;
  }
}

// Tauri invoke has no AbortSignal (tauri-apps/tauri#8351): the command keeps
// running after the timeout fires. Promise.race attaches handlers to both
// promises immediately, so the loser's late settlement can never surface as
// an unhandled rejection; the timer is cleared on whichever side settles.
export function invokeWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  command: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new NativeInvokeTimeoutError(command, ms));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Google Drive media download URL (token travels in the Authorization
 *  header — Google blocked token query params since 2020). */
export function buildDriveStreamUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
}
