import { captureError } from "../../utils/errorLog";

export function classifyPlayerError(err: unknown): {
  name: string;
  message: string;
} {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { name: "Error", message: err };
  return { name: "UnknownError", message: "Unknown error" };
}

// Duck-typed abort check: DOMException is NOT instanceof Error in some
// environments (jsdom), yet carries a reliable .name (mirrors errName).
export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "AbortError")
  );
}

/** Shared seek step for ArrowLeft/ArrowRight and media-session seek keys. */
export const SEEK_STEP_SECONDS = 5;

/** Minimal audio surface seekRelative needs — AudioController satisfies it
 *  (sync void seek), the native engine too (async promise seek, the union
 *  mirrors PlaybackEngine.seek so rejections are catchable here). */
export interface SeekableAudio {
  seek(time: number): void | Promise<void>;
  getCurrentTime(): number;
  getDuration(): number;
}

/**
 * Relative seek shared by keyboard seek and media-session seek keys.
 * Guard: duration <= 0 (metadata not loaded yet) → no-op, never seek to 0.
 * The native engine rethrows after reporting (invokeStateful
 * log-then-rethrow), so a bare fire-and-forget promise would surface as an
 * unhandled rejection — a returned promise gets a catch that logs through
 * captureError; the desktop sync-void engine has nothing to catch.
 */
export function seekRelative(audio: SeekableAudio, delta: number): void {
  const duration = audio.getDuration();
  if (duration <= 0) return;
  const target = Math.min(
    duration,
    Math.max(0, audio.getCurrentTime() + delta),
  );
  const logSeekFailure = (err: unknown): void => {
    void captureError({
      level: "warn",
      source: "playerUtils",
      message: `seek-failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  };
  try {
    const seekResult = audio.seek(target);
    if (seekResult) {
      seekResult.catch(logSeekFailure);
    }
  } catch (err: unknown) {
    // Sync throw (desktop engine contract violation): same logging, no crash.
    logSeekFailure(err);
  }
}
