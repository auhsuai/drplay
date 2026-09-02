import { captureError } from "../utils/errorLog";
import { usePlayerStore } from "../store/playerStore";

export type AudioEventMap = {
  timeupdate: { currentTime: number; duration: number };
  durationchange: { duration: number };
  buffering: { isBuffering: boolean };
  /** Native `progress` event — buffered data grew. Consumers re-read
   *  `getBuffered()` to render the buffer bar (audio.buffered only changes
   *  while a `progress` event fires). Throttled to ~5/s. Also re-emitted from
   *  seeked/loadeddata/suspend/durationchange because for a small/fast file the
   *  LAST native `progress` can fire with buffered empty — those discrete
   *  events are the only proof the final buffer state settled. */
  progress: undefined;
  error: { message: string; code: string };
  ended: undefined;
  play: undefined;
  pause: undefined;
};

export type AudioEventHandler<K extends keyof AudioEventMap> = (
  payload: AudioEventMap[K],
) => void;

const THROTTLE_MS = 200;
const ENDED_THRESHOLD_SECONDS = 1;
// Task B: mediaError.code values, per MDN MediaError constants (same
// values lib.dom declares on the global `MediaError` constructor). The
// global is NOT implemented by jsdom (the test environment), so referencing
// `MediaError.MEDIA_ERR_*` at runtime would throw ReferenceError in tests —
// the named values below carry the same semantics without that dependency.
// MEDIA_ERR_NETWORK (2) is intentionally NOT declared: the retry path below
// covers "every remaining code" (NETWORK or a null mediaError), so a
// constant for it would be an unused variable (TS6133).
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

// State + orchestration the native-event handlers need from the
// AudioController facade. Everything is passed in (nothing is read from
// module scope), so createNativeEventHandlers is a pure factory: same deps +
// same element -> same handlers.
export type NativeAudioDeps = {
  isActive: (audio: HTMLAudioElement) => boolean;
  emit: <K extends keyof AudioEventMap>(
    event: K,
    payload: AudioEventMap[K],
  ) => void;
  // Shared throttle clocks, mutated in place by the handler closures.
  throttle: { lastTimeUpdate: number; lastProgressEmit: number };
  // DECODE / SRC_NOT_SUPPORTED: the resource itself is unusable — no retry
  // can help. The controller owns give-up emission (clearRetryTimer + log +
  // error/ended events).
  onUnrecoverableError: (mediaErrorCode: number) => void;
  // NETWORK / null mediaError: transient. The controller owns the retry
  // decision (retryCount, retryTimer, changeToken) and receives the position
  // to resume from.
  onTransientError: (position: number) => void;
};

export function createNativeEventHandlers(
  audio: HTMLAudioElement,
  deps: NativeAudioDeps,
): Record<string, EventListener> {
  // Handlers are held as named properties (not inline anonymous closures)
  // so each reference is retained in the controller's elementListeners table
  // and removable.
  const handlers: Record<string, EventListener> = {};

  handlers.timeupdate = () => {
    if (!deps.isActive(audio)) return;
    const now = performance.now();
    if (now - deps.throttle.lastTimeUpdate > THROTTLE_MS) {
      deps.throttle.lastTimeUpdate = now;
      deps.emit("timeupdate", {
        currentTime: audio.currentTime,
        duration: audio.duration || 0,
      });
    }
  };

  // Surface metadata readiness so consumers can render the real duration
  // even before the first timeupdate (e.g. paused with metadata loaded).
  handlers.durationchange = () => {
    if (deps.isActive(audio)) {
      deps.emit("durationchange", { duration: audio.duration || 0 });
      deps.emit("progress", undefined);
    }
  };

  // Buffer-bar reliability beyond `progress`: for a small/fast file the LAST
  // native progress event can fire with buffered still empty, then loading
  // finishes with NO further progress event — the bar would stay empty even
  // though buffered is full (race). These discrete events prove the buffered
  // state may have changed, so re-emit `progress` so consumers re-read
  // getBuffered(). They fire rarely -> no throttle (no DOM churn).
  const reemitProgress = () => {
    if (deps.isActive(audio)) {
      deps.emit("progress", undefined);
    }
  };

  handlers.seeked = reemitProgress;
  handlers.loadeddata = reemitProgress;
  handlers.suspend = reemitProgress;

  // Native `progress` fires periodically while the media resource loads —
  // this is when audio.buffered grows (paused OR playing, unlike timeupdate
  // which only fires during playback). Throttled to ~5/s to avoid DOM churn
  // in buffer-bar consumers. The sentinel `=== 0` guarantees the FIRST
  // event always emits, even when the throttle clock is at t=0 (fake timers).
  handlers.progress = () => {
    if (!deps.isActive(audio)) return;
    const now = performance.now();
    if (
      deps.throttle.lastProgressEmit === 0 ||
      now - deps.throttle.lastProgressEmit > THROTTLE_MS
    ) {
      deps.throttle.lastProgressEmit = now;
      deps.emit("progress", undefined);
    }
  };

  handlers.waiting = () => {
    if (deps.isActive(audio)) {
      deps.emit("buffering", { isBuffering: true });
    }
  };

  handlers.playing = () => {
    if (deps.isActive(audio)) {
      deps.emit("buffering", { isBuffering: false });
      deps.emit("play", undefined);
      usePlayerStore.getState().setIsPlaying(true);
    }
  };

  handlers.pause = () => {
    if (deps.isActive(audio)) {
      deps.emit("pause", undefined);
      usePlayerStore.getState().setIsPlaying(false);
    }
  };

  handlers.ended = () => {
    if (deps.isActive(audio)) {
      if (
        audio.duration &&
        audio.currentTime < audio.duration - ENDED_THRESHOLD_SECONDS
      )
        return;
      deps.emit("ended", undefined);
    }
  };

  handlers.error = () => {
    if (!deps.isActive(audio)) return;

    // Task B: classify by mediaError.code (MDN) — the code decides whether a
    // retry can ever help. ABORTED means the user/browser cancelled the
    // fetch (not a failure — stay silent, a retry could restart playback
    // the user just cancelled); DECODE / SRC_NOT_SUPPORTED mean the resource
    // itself is unusable, so retrying would only burn ~6s before hitting the
    // same give-up — skip the track right away. Everything remaining is
    // transient (NETWORK or a null mediaError) → existing retry path.
    const mediaErrorCode = audio.error?.code ?? null;

    if (mediaErrorCode === MEDIA_ERR_ABORTED) {
      void captureError({
        level: "warn",
        source: "AudioController",
        message: `Audio error aborted by user (mediaError.code=${String(MEDIA_ERR_ABORTED)})`,
      });
      return;
    }

    if (
      mediaErrorCode === MEDIA_ERR_DECODE ||
      mediaErrorCode === MEDIA_ERR_SRC_NOT_SUPPORTED
    ) {
      deps.onUnrecoverableError(mediaErrorCode);
      return;
    }

    deps.onTransientError(audio.currentTime);
  };

  return handlers;
}
