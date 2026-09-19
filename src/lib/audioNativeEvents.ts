// Shared event contract between the AudioController facade and the mpv
// engine: mpvAudio.ts maps mpv property events onto these payloads. The DOM
// audio implementation was deleted with the mpv cutover (plan 2026-09-11
// Task 4) — these types are the surviving piece of the facade 2.1 contract.

/**
 * Engine-side identity attached to every emitted event (R2.1): which track the
 * event belongs to and which engine load attempt produced it. Both fields are
 * optional so an untagged payload (older sender, event with no active track)
 * stays type-compatible; consumers only filter when `trackId` is present.
 */
export type AudioEventIdentity = {
  /** Track the event belongs to — the engine's current track at emit-time
   *  (or the load target for a failed load attempt). */
  trackId?: string;
  /** Monotonic engine load-attempt id, bumped per `beginTrack` and paired
   *  with `trackId`. Not the intent-level attemptId of RC-1/R3.1. */
  attempt?: number;
};

export type AudioEventMap = {
  timeupdate: AudioEventIdentity & { currentTime: number; duration: number };
  durationchange: AudioEventIdentity & { duration: number };
  buffering: AudioEventIdentity & { isBuffering: boolean };
  /** Buffered data grew — consumers re-read `getBuffered()` to render the
   *  buffer bar. Throttled to ~5/s (mpv demuxer-cache-state mapping). */
  progress: AudioEventIdentity | undefined;
  error: AudioEventIdentity & { message: string; code: string };
  ended: AudioEventIdentity | undefined;
  play: AudioEventIdentity | undefined;
  pause: AudioEventIdentity | undefined;
  /** First real time-pos push of the current track (mpv onTimeUpdate path
   *  only — never the TimeInterpolator synthetic emits). Proves audio bytes
   *  are flowing; lets callers defer display-only work (e.g. Drive metadata
   *  fetch) off the critical first-byte path. Emitted once per track. */
  "first-audio": AudioEventIdentity | undefined;
};

export type AudioEventHandler<K extends keyof AudioEventMap> = (
  payload: AudioEventMap[K],
) => void;
