import type { Track } from "../types";
import { usePlayerStore } from "../store/playerStore";
import { captureError } from "../utils/errorLog";
import { buildStreamUrl } from "../utils/streamPrefetcher";
import { isAbortError } from "../hooks/player/utils";
import type { BufferedSource } from "../utils/bufferedRange";
import type { PlaybackEngine } from "./nativeAudioBridge";

type AudioEventMap = {
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

type AudioEventHandler<K extends keyof AudioEventMap> = (
  payload: AudioEventMap[K],
) => void;

export class AudioController implements PlaybackEngine {
  private static readonly THROTTLE_MS = 200;
  private static readonly RETRY_DELAY_MS = 2000;
  private static readonly MAX_RETRIES = 3;
  private static readonly ENDED_THRESHOLD_SECONDS = 1;
  // Task B: mediaError.code values, per MDN MediaError constants (same
  // values lib.dom declares on the global `MediaError` constructor). The
  // global is NOT implemented by jsdom (the test environment), so referencing
  // `MediaError.MEDIA_ERR_*` at runtime would throw ReferenceError in tests —
  // the named values below carry the same semantics without that dependency.
  // MEDIA_ERR_NETWORK (2) is intentionally NOT declared: the retry path below
  // covers "every remaining code" (NETWORK or a null mediaError), so a
  // constant for it would be an unused private member (TS6133).
  private static readonly MEDIA_ERR_ABORTED = 1;
  private static readonly MEDIA_ERR_DECODE = 3;
  private static readonly MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

  private static instance: AudioController | undefined;
  private audio1: HTMLAudioElement;
  private audio2: HTMLAudioElement;
  private activeIndex: 0 | 1 = 0;

  private currentTrackId: string | null = null;
  private retryCount = 0;
  // B1: pending retry timer + monotonic change token. playTrack()/release()
  // bump the token and clear the timer so a stale retry scheduled for the
  // previous track can never touch the current track.
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private changeToken = 0;
  private volume = 1;
  private muted = false;
  private listeners: { [K in keyof AudioEventMap]?: AudioEventHandler<K>[] } =
    {};

  private lastTimeUpdate = 0;
  private lastProgressEmit = 0;

  // Retained reference to every native listener attached by setupAudio(),
  // keyed by element then event type. Anonymous handlers are unreachable and
  // can never be removeEventListener'd (MDN); holding the reference here makes
  // a future teardown able to detach them. WeakMap so the table itself never
  // keeps an element alive.
  private readonly elementListeners = new WeakMap<
    HTMLAudioElement,
    Record<string, EventListener>
  >();

  private constructor() {
    this.audio1 = new Audio();
    this.audio2 = new Audio();

    // Attach listeners so the elements can play via the /drive-stream SW proxy
    this.setupAudio(this.audio1);
    this.setupAudio(this.audio2);
  }

  public static getInstance(): AudioController {
    if (!AudioController.instance) {
      AudioController.instance = new AudioController();
    }
    return AudioController.instance;
  }

  private get activeAudio() {
    return this.activeIndex === 0 ? this.audio1 : this.audio2;
  }

  private clearRetryTimer() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async safePlay(audio: HTMLAudioElement): Promise<void> {
    try {
      await audio.play();
    } catch (e: unknown) {
      if (
        !isAbortError(e) &&
        !(e instanceof DOMException && e.name === "NotAllowedError")
      ) {
        void captureError({
          level: "warn",
          source: "AudioController",
          message: `safe-play-failed: ${e instanceof Error ? e.name : String(e)}`,
        });
      }
    }
  }

  // One-shot loadedmetadata listener: set currentTime once metadata arrives,
  // then detach itself (MDN pattern). Prevents the listener from leaking and
  // from re-applying the position on later metadata events.
  private seekOnLoadedMetadata(
    audio: HTMLAudioElement,
    position: number,
  ): void {
    const onMetadata = () => {
      audio.currentTime = position;
      audio.removeEventListener("loadedmetadata", onMetadata);
    };
    audio.addEventListener("loadedmetadata", onMetadata);
  }

  // Buffer-bar reliability beyond `progress`: for a small/fast file the LAST
  // native progress event can fire with buffered still empty, then loading
  // finishes with NO further progress event — the bar would stay empty even
  // though buffered is full (race). These discrete events prove the buffered
  // state may have changed, so re-emit `progress` so consumers re-read
  // getBuffered(). They fire rarely -> no throttle (no DOM churn).
  private reemitProgress(audio: HTMLAudioElement): void {
    if (audio === this.activeAudio) {
      this.emit("progress", undefined);
    }
  }

  private setupAudio(audio: HTMLAudioElement) {
    // Handlers are held as named properties (not inline anonymous closures)
    // so each reference is retained in this.elementListeners and removable.
    // Behaviour is identical to the previous inline arrows.
    const handlers: Record<string, EventListener> = {};

    handlers.timeupdate = () => {
      if (audio !== this.activeAudio) return;
      const now = performance.now();
      if (now - this.lastTimeUpdate > AudioController.THROTTLE_MS) {
        this.lastTimeUpdate = now;
        this.emit("timeupdate", {
          currentTime: audio.currentTime,
          duration: audio.duration || 0,
        });
      }
    };

    // Surface metadata readiness so consumers can render the real duration
    // even before the first timeupdate (e.g. paused with metadata loaded).
    handlers.durationchange = () => {
      if (audio === this.activeAudio) {
        this.emit("durationchange", { duration: audio.duration || 0 });
        this.emit("progress", undefined);
      }
    };

    handlers.seeked = () => {
      this.reemitProgress(audio);
    };

    handlers.loadeddata = () => {
      this.reemitProgress(audio);
    };

    handlers.suspend = () => {
      this.reemitProgress(audio);
    };

    // Native `progress` fires periodically while the media resource loads —
    // this is when audio.buffered grows (paused OR playing, unlike timeupdate
    // which only fires during playback). Throttled to ~5/s to avoid DOM churn
    // in buffer-bar consumers. The sentinel `=== 0` guarantees the FIRST
    // event always emits, even when the throttle clock is at t=0 (fake timers).
    handlers.progress = () => {
      if (audio !== this.activeAudio) return;
      const now = performance.now();
      if (
        this.lastProgressEmit === 0 ||
        now - this.lastProgressEmit > AudioController.THROTTLE_MS
      ) {
        this.lastProgressEmit = now;
        this.emit("progress", undefined);
      }
    };

    handlers.waiting = () => {
      if (audio === this.activeAudio) {
        this.emit("buffering", { isBuffering: true });
      }
    };

    handlers.playing = () => {
      if (audio === this.activeAudio) {
        this.emit("buffering", { isBuffering: false });
        this.emit("play", undefined);
        usePlayerStore.getState().setIsPlaying(true);
      }
    };

    handlers.pause = () => {
      if (audio === this.activeAudio) {
        this.emit("pause", undefined);
        usePlayerStore.getState().setIsPlaying(false);
      }
    };

    handlers.ended = () => {
      if (audio === this.activeAudio) {
        if (
          audio.duration &&
          audio.currentTime <
            audio.duration - AudioController.ENDED_THRESHOLD_SECONDS
        )
          return;
        this.emit("ended", undefined);
      }
    };

    handlers.error = () => {
      if (audio !== this.activeAudio) return;

      // Task B: classify by mediaError.code (MDN) — the code decides whether a
      // retry can ever help. ABORTED means the user/browser cancelled the
      // fetch (not a failure — stay silent, a retry could restart playback
      // the user just cancelled); DECODE / SRC_NOT_SUPPORTED mean the resource
      // itself is unusable, so retrying would only burn ~6s before hitting the
      // same give-up — skip the track right away. Everything remaining is
      // transient (NETWORK or a null mediaError) → existing retry path.
      const mediaErrorCode = audio.error?.code ?? null;

      if (mediaErrorCode === AudioController.MEDIA_ERR_ABORTED) {
        void captureError({
          level: "warn",
          source: "AudioController",
          message: `Audio error aborted by user (mediaError.code=${String(AudioController.MEDIA_ERR_ABORTED)})`,
        });
        return;
      }

      if (
        mediaErrorCode === AudioController.MEDIA_ERR_DECODE ||
        mediaErrorCode === AudioController.MEDIA_ERR_SRC_NOT_SUPPORTED
      ) {
        this.clearRetryTimer();
        void captureError({
          level: "error",
          source: "AudioController",
          message: `Audio error (unrecoverable — mediaError.code=${String(mediaErrorCode)})`,
        });
        this.emit("error", {
          message: "File lỗi định dạng, đang bỏ qua...",
          code: "format_error",
        });
        this.emit("ended", undefined);
        return;
      }

      this.retryCount++;
      void captureError({
        level: "error",
        source: "AudioController",
        message: `Audio error (attempt ${String(this.retryCount)})`,
      });

      if (
        this.retryCount < AudioController.MAX_RETRIES &&
        this.currentTrackId
      ) {
        this.emit("error", {
          message: "Mạng không ổn định, đang thử lại...",
          code: "network_interrupted",
        });
        const pos = audio.currentTime;
        // B1: capture track id + change token at schedule time; when the timer
        // fires, a stale retry (track switched in between) is a no-op.
        const trackId = this.currentTrackId;
        const token = this.changeToken;
        this.clearRetryTimer();
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          // Fire-and-forget: timer-scheduled retry; errors are handled (and
          // logged) inside retry() itself.
          void this.retry(pos, trackId, token);
        }, AudioController.RETRY_DELAY_MS);
      } else {
        // B1: giving up — no zombie retry may fire later.
        this.clearRetryTimer();
        this.emit("error", {
          message: "File lỗi định dạng, đang bỏ qua...",
          code: "format_error",
        });
        this.emit("ended", undefined);
      }
    };

    for (const [type, handler] of Object.entries(handlers)) {
      audio.addEventListener(type, handler);
    }
    this.elementListeners.set(audio, handlers);
  }

  private getHandlers<K extends keyof AudioEventMap>(
    event: K,
  ): AudioEventHandler<K>[] {
    return this.listeners[event] ?? (this.listeners[event] = []);
  }

  public on<K extends keyof AudioEventMap>(
    event: K,
    handler: AudioEventHandler<K>,
  ) {
    const list = this.getHandlers(event);
    list.push(handler);
    return () => {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  private emit<K extends keyof AudioEventMap>(
    event: K,
    payload: AudioEventMap[K],
  ) {
    const handlers = this.listeners[event];
    if (handlers) {
      handlers.forEach((h) => {
        h(payload);
      });
    }
  }

  public async playTrack(track: Track, startTime?: number) {
    // B1: any pending retry from the previous track must not fire on this one.
    this.changeToken++;
    this.clearRetryTimer();

    if (this.currentTrackId === track.id) {
      if (this.activeAudio.paused) {
        // Fire-and-forget: safePlay never rejects (errors are logged inside).
        void this.safePlay(this.activeAudio);
      }
      return;
    }

    this.currentTrackId = track.id;
    this.retryCount = 0;

    const oldAudio = this.activeAudio;
    // Task C: flip the active element BEFORE pausing the old one. pause() can
    // deliver its native pause event synchronously (MDN: "sent once the
    // pause() method returns") or as a queued task, and the store already
    // points at the NEW track by this point (usePlayer sets currentTrack
    // before PlayerBar's effect calls playTrack). With the old element still
    // "active", its pause handler would pass the `audio === this.activeAudio`
    // guard and the session hook would persist "new track @ old position".
    // Flipping first makes every stale event from the released element
    // (pause/ended/error) hit the guard and get dropped — the same pattern
    // the ended/error handlers already rely on.
    this.activeIndex = this.activeIndex === 0 ? 1 : 0;
    oldAudio.pause();
    oldAudio.removeAttribute("src");
    // B2: MDN 3-step release — load() after removeAttribute('src') so the
    // old element's buffers/decoder are actually freed.
    oldAudio.load();

    const newAudio = this.activeAudio;

    const url = track.streamUrl || buildStreamUrl(track.id, track.originalName);
    newAudio.src = url;
    newAudio.volume = this.muted ? 0 : this.volume;
    newAudio.load();

    if (startTime !== undefined) {
      this.seekOnLoadedMetadata(newAudio, startTime);
    }

    try {
      await newAudio.play();
    } catch (e: unknown) {
      if (!isAbortError(e) && this.currentTrackId === track.id) {
        void captureError({
          level: "warn",
          source: "AudioController",
          message: `play-failed: ${e instanceof Error ? e.name : String(e)}`,
        });
        usePlayerStore.getState().setIsPlaying(false);
      }
    }
  }

  private async retry(position: number, trackId: string, token: number) {
    // B1: stale retry — the track changed (or was released) while the timer
    // was pending. Never touch the current track with the old track's intent.
    if (token !== this.changeToken) return;
    if (!this.currentTrackId || this.currentTrackId !== trackId) return;
    const audio = this.activeAudio;
    const src = audio.src;
    audio.pause();
    audio.removeAttribute("src");
    // B2: MDN 3-step release before pointing the element at a new source.
    audio.load();

    // Rebuild the URL keeping every existing query param (the ?ext= MIME hint
    // must survive the retry — dropping it would undo the SW Content-Type
    // override for octet-stream FLAC/OGG/Opus) and replacing the retry marker.
    const url = new URL(src, window.location.origin);
    url.searchParams.set("retry", String(Date.now()));
    audio.src = /^[a-z][a-z\d+.-]*:/i.test(src)
      ? url.href
      : `${url.pathname}${url.search}`;
    audio.load();

    this.seekOnLoadedMetadata(audio, position);

    try {
      await audio.play();
    } catch (e: unknown) {
      if (!isAbortError(e))
        void captureError({
          level: "warn",
          source: "AudioController",
          message: `Retry autoplay failed (${e instanceof Error ? e.name : String(e)})`,
        });
    }
  }

  public togglePlay() {
    if (!this.currentTrackId) return;
    if (this.activeAudio.paused) {
      // Fire-and-forget: safePlay never rejects (errors are logged inside).
      void this.safePlay(this.activeAudio);
    } else {
      this.activeAudio.pause();
    }
  }

  public pause() {
    this.activeAudio.pause();
  }

  public seek(time: number) {
    if (this.activeAudio.readyState > 0) {
      this.activeAudio.currentTime = time;
    }
  }

  public setVolume(vol: number) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (!this.muted) {
      for (const a of [this.audio1, this.audio2]) a.volume = this.volume;
    }
  }

  public toggleMute() {
    this.muted = !this.muted;
    for (const a of [this.audio1, this.audio2])
      a.volume = this.muted ? 0 : this.volume;
    return this.muted;
  }

  public getVolume() {
    return this.volume;
  }
  public isMuted() {
    return this.muted;
  }
  public getCurrentTime() {
    return this.activeAudio.currentTime;
  }
  public getDuration() {
    return this.activeAudio.duration || 0;
  }

  /**
   * Snapshot of the ACTIVE element's buffering state, for buffer-bar rendering.
   * `audio.buffered` only changes while a native `progress` event fires, so
   * consumers should call this from a `progress` handler (MDN pattern).
   */
  public getBuffered(): BufferedSource {
    const audio = this.activeAudio;
    return {
      duration: audio.duration,
      currentTime: audio.currentTime,
      buffered: audio.buffered,
    };
  }

  // B3: fully release audio resources (logout / player-stop). Each element is
  // handled independently so one throwing element cannot leave the others
  // (or the state) unreleased.
  // NOTE: the 11 native listeners per element (setupAudio) are intentionally
  // NOT detached here. release() runs on logout, but the app does not reload:
  // the singleton instance and its 2 elements are reused after re-login
  // (useAuth.handleLogout -> 'player-stop' -> release(); the next login calls
  // playTrack on the SAME elements). Detaching the listeners here would leave
  // the reused elements silent — no timeupdate/pause/ended/error emission —
  // breaking progress, isPlaying, retry and session-save. The handlers are
  // retained as named references in this.elementListeners, so a real teardown
  // path (if one is ever introduced) can remove them.
  public release() {
    this.clearRetryTimer();
    this.changeToken++;
    this.currentTrackId = null;
    this.retryCount = 0;

    for (const el of [this.audio1, this.audio2]) {
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch (err) {
        void captureError({
          level: "warn",
          source: "AudioController",
          message: `release-element-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
}
