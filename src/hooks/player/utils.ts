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

/** Minimal audio surface seekRelative needs (AudioController satisfies it). */
export interface SeekableAudio {
  seek(time: number): void;
  getCurrentTime(): number;
  getDuration(): number;
}

/**
 * Relative seek shared by keyboard seek and media-session seek keys.
 * Guard: duration <= 0 (metadata not loaded yet) → no-op, never seek to 0.
 */
export function seekRelative(audio: SeekableAudio, delta: number): void {
  const duration = audio.getDuration();
  if (duration <= 0) return;
  audio.seek(Math.min(duration, Math.max(0, audio.getCurrentTime() + delta)));
}
