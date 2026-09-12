// Shared event contract between the AudioController facade and the mpv
// engine: mpvAudio.ts maps mpv property events onto these payloads. The DOM
// audio implementation was deleted with the mpv cutover (plan 2026-09-11
// Task 4) — these types are the surviving piece of the facade 2.1 contract.
export type AudioEventMap = {
  timeupdate: { currentTime: number; duration: number };
  durationchange: { duration: number };
  buffering: { isBuffering: boolean };
  /** Buffered data grew — consumers re-read `getBuffered()` to render the
   *  buffer bar. Throttled to ~5/s (mpv demuxer-cache-state mapping). */
  progress: undefined;
  error: { message: string; code: string };
  ended: undefined;
  play: undefined;
  pause: undefined;
  /** First real time-pos push of the current track (mpv onTimeUpdate path
   *  only — never the TimeInterpolator synthetic emits). Proves audio bytes
   *  are flowing; lets callers defer display-only work (e.g. Drive metadata
   *  fetch) off the critical first-byte path. Emitted once per track. */
  "first-audio": undefined;
};

export type AudioEventHandler<K extends keyof AudioEventMap> = (
  payload: AudioEventMap[K],
) => void;
