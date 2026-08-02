import { Track } from '../App';
import { usePlayerStore } from '../store/playerStore';
import { captureError } from '../utils/errorLog';
import { DRIVE_STREAM_PREFIX } from '../utils/streamPrefetcher';
import { isAbortError } from '../hooks/player/utils';
import type { BufferedSource } from '../utils/bufferedRange';

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
  progress: void;
  error: { message: string; code: string };
  ended: void;
  play: void;
  pause: void;
};

type AudioEventHandler<K extends keyof AudioEventMap> = (payload: AudioEventMap[K]) => void;

export class AudioController {
  private static readonly THROTTLE_MS = 200;
  private static readonly RETRY_DELAY_MS = 2000;
  private static readonly MAX_RETRIES = 3;
  private static readonly ENDED_THRESHOLD_SECONDS = 1;

  private static instance: AudioController;
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
  private listeners: { [K in keyof AudioEventMap]?: AudioEventHandler<K>[] } = {};
  
  private lastTimeUpdate = 0;
  private lastProgressEmit = 0;

  // Retained reference to every native listener attached by setupAudio(),
  // keyed by element then event type. Anonymous handlers are unreachable and
  // can never be removeEventListener'd (MDN); holding the reference here makes
  // a future teardown able to detach them. WeakMap so the table itself never
  // keeps an element alive.
  private readonly elementListeners = new WeakMap<HTMLAudioElement, Record<string, EventListener>>();

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
    try { await audio.play(); } catch { /* autoplay policy — silent */ }
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
        this.emit('timeupdate', { currentTime: audio.currentTime, duration: audio.duration || 0 });
      }
    };

    // Surface metadata readiness so consumers can render the real duration
    // even before the first timeupdate (e.g. paused with metadata loaded).
    handlers.durationchange = () => {
      if (audio === this.activeAudio) {
        this.emit('durationchange', { duration: audio.duration || 0 });
        this.emit('progress', undefined);
      }
    };

    // Buffer-bar reliability beyond `progress`: for a small/fast file the LAST
    // native progress event can fire with buffered still empty, then loading
    // finishes with NO further progress event — the bar would stay empty even
    // though buffered is full (race). These discrete events prove the buffered
    // state may have changed, so re-emit `progress` so consumers re-read
    // getBuffered(). They fire rarely -> no throttle (no DOM churn).
    handlers.seeked = () => {
      if (audio === this.activeAudio) {
        this.emit('progress', undefined);
      }
    };

    handlers.loadeddata = () => {
      if (audio === this.activeAudio) {
        this.emit('progress', undefined);
      }
    };

    handlers.suspend = () => {
      if (audio === this.activeAudio) {
        this.emit('progress', undefined);
      }
    };

    // Native `progress` fires periodically while the media resource loads —
    // this is when audio.buffered grows (paused OR playing, unlike timeupdate
    // which only fires during playback). Throttled to ~5/s to avoid DOM churn
    // in buffer-bar consumers. The sentinel `=== 0` guarantees the FIRST
    // event always emits, even when the throttle clock is at t=0 (fake timers).
    handlers.progress = () => {
      if (audio !== this.activeAudio) return;
      const now = performance.now();
      if (this.lastProgressEmit === 0 || now - this.lastProgressEmit > AudioController.THROTTLE_MS) {
        this.lastProgressEmit = now;
        this.emit('progress', undefined);
      }
    };

    handlers.waiting = () => {
      if (audio === this.activeAudio) {
        this.emit('buffering', { isBuffering: true });
      }
    };

    handlers.playing = () => {
      if (audio === this.activeAudio) {
        this.emit('buffering', { isBuffering: false });
        this.emit('play', undefined);
        usePlayerStore.getState().setIsPlaying(true);
      }
    };

    handlers.pause = () => {
      if (audio === this.activeAudio) {
        this.emit('pause', undefined);
        usePlayerStore.getState().setIsPlaying(false);
      }
    };

    handlers.ended = () => {
      if (audio === this.activeAudio) {
        if (audio.duration && audio.currentTime < audio.duration - AudioController.ENDED_THRESHOLD_SECONDS) return;
        this.emit('ended', undefined);
      }
    };

    handlers.error = () => {
      if (audio !== this.activeAudio) return;
      this.retryCount++;
      captureError({ level: 'error', source: 'AudioController', message: `Audio error (attempt ${this.retryCount})` });
      
      if (this.retryCount < AudioController.MAX_RETRIES && this.currentTrackId) {
        this.emit('error', { message: 'Mạng không ổn định, đang thử lại...', code: 'network_interrupted' });
        const pos = audio.currentTime;
        // B1: capture track id + change token at schedule time; when the timer
        // fires, a stale retry (track switched in between) is a no-op.
        const trackId = this.currentTrackId;
        const token = this.changeToken;
        this.clearRetryTimer();
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.retry(pos, trackId, token);
        }, AudioController.RETRY_DELAY_MS);
      } else {
        // B1: giving up — no zombie retry may fire later.
        this.clearRetryTimer();
        this.emit('error', { message: 'File lỗi định dạng, đang bỏ qua...', code: 'format_error' });
        this.emit('ended', undefined); 
      }
    };

    for (const [type, handler] of Object.entries(handlers)) {
      audio.addEventListener(type, handler);
    }
    this.elementListeners.set(audio, handlers);
  }

  private getHandlers<K extends keyof AudioEventMap>(event: K): AudioEventHandler<K>[] {
    const list = this.listeners[event];
    return list ? list as AudioEventHandler<K>[] : (this.listeners[event] = []) as AudioEventHandler<K>[];
  }

  public on<K extends keyof AudioEventMap>(event: K, handler: AudioEventHandler<K>) {
    const list = this.getHandlers(event);
    list.push(handler);
    return () => {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  private emit<K extends keyof AudioEventMap>(event: K, payload: AudioEventMap[K]) {
    const handlers = this.listeners[event] as AudioEventHandler<K>[] | undefined;
    if (handlers) {
      handlers.forEach(h => h(payload));
    }
  }

  public async playTrack(track: Track, startTime?: number) {
    // B1: any pending retry from the previous track must not fire on this one.
    this.changeToken++;
    this.clearRetryTimer();

    if (this.currentTrackId === track.id) {
      if (this.activeAudio.paused) {
        this.safePlay(this.activeAudio);
      }
      return;
    }

    this.currentTrackId = track.id;
    this.retryCount = 0;
    
    const oldAudio = this.activeAudio;
    oldAudio.pause();
    oldAudio.removeAttribute('src');
    // B2: MDN 3-step release — load() after removeAttribute('src') so the
    // old element's buffers/decoder are actually freed.
    oldAudio.load();

    this.activeIndex = this.activeIndex === 0 ? 1 : 0;
    const newAudio = this.activeAudio;
    
    const url = track.streamUrl || `${DRIVE_STREAM_PREFIX}${track.id}`;
    newAudio.src = url;
    newAudio.volume = this.muted ? 0 : this.volume;
    newAudio.load();

    if (startTime !== undefined) {
      const handleMetadata = () => {
        newAudio.currentTime = startTime;
        newAudio.removeEventListener('loadedmetadata', handleMetadata);
      };
      newAudio.addEventListener('loadedmetadata', handleMetadata);
    }

    try {
      await newAudio.play();
    } catch (e: unknown) {
      if (!isAbortError(e) && this.currentTrackId === track.id) {
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
    audio.removeAttribute('src');
    // B2: MDN 3-step release before pointing the element at a new source.
    audio.load();
    
    // Strip old query params and add new retry param
    const baseUrl = src.split('?')[0];
    audio.src = baseUrl + '?retry=' + Date.now();
    audio.load();
    
    const handleMetadata = () => {
      audio.currentTime = position;
      audio.removeEventListener('loadedmetadata', handleMetadata);
    };
    audio.addEventListener('loadedmetadata', handleMetadata);

    try {
      await audio.play();
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name !== 'AbortError') captureError({ level: 'warn', source: 'AudioController', message: `Retry autoplay failed (${e.name})` });
    }
  }

  public togglePlay() {
    if (!this.currentTrackId) return;
    if (this.activeAudio.paused) {
      this.safePlay(this.activeAudio);
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
    for (const a of [this.audio1, this.audio2]) a.volume = this.muted ? 0 : this.volume;
    return this.muted;
  }

  public getVolume() { return this.volume; }
  public isMuted() { return this.muted; }
  public getCurrentTime() { return this.activeAudio.currentTime; }
  public getDuration() { return this.activeAudio.duration || 0; }

  /**
   * Snapshot of the ACTIVE element's buffering state, for buffer-bar rendering.
   * `audio.buffered` only changes while a native `progress` event fires, so
   * consumers should call this from a `progress` handler (MDN pattern).
   */
  public getBuffered(): BufferedSource {
    const audio = this.activeAudio;
    return { duration: audio.duration, currentTime: audio.currentTime, buffered: audio.buffered };
  }
  
  // Expose prefetch for gapless if needed
  public preloadTrack(url: string) {
    const inactiveAudio = this.activeIndex === 0 ? this.audio2 : this.audio1;
    inactiveAudio.src = url;
    inactiveAudio.load();
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
        el.removeAttribute('src');
        el.load();
      } catch (err) {
        captureError({ level: 'warn', source: 'AudioController', message: `release-element-failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }
}
