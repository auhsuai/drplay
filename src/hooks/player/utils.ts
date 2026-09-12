import type { Track, PlayMode } from "../../types";

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

export function sameTrack(a: Track, b: Track): boolean {
  if (a.queueItemId && b.queueItemId) return a.queueItemId === b.queueItemId;
  return a.id === b.id;
}

export function resolveNextTrack(
  playbackQueue: readonly Track[],
  currentTrack: Track,
  playMode: PlayMode,
  brokenTrackIds: readonly string[],
): Track | null {
  const currentIndex = playbackQueue.findIndex((item) =>
    sameTrack(item, currentTrack),
  );
  if (currentIndex === -1) return null;

  const wraps = playMode === "repeat-all" || playMode === "shuffle";
  const isBroken = (track: Track): boolean => brokenTrackIds.includes(track.id);

  let target: Track | null = null;
  for (let step = 1; step <= playbackQueue.length; step++) {
    let index = currentIndex + step;
    if (index >= playbackQueue.length) {
      if (!wraps) break;
      index -= playbackQueue.length;
    }
    const candidate = playbackQueue[index];
    if (candidate !== undefined && !isBroken(candidate)) {
      target = candidate;
      break;
    }
  }
  return target;
}
