import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Track } from "../types";
import { captureError } from "../utils/errorLog";
import { usePlayerStore } from "../store/playerStore";
import type { BufferedSource } from "../utils/bufferedRange";
import type { AudioEventMap, AudioEventHandler } from "./audioNativeEvents";
import {
  BufferingTracker,
  describeError,
  dispatchMpvEvent,
  dispatchPropertyEvent,
  freshThrottleClocks,
  MPV_BOOL,
  MPV_COMMANDS,
  MPV_PROPERTY_ARGS,
  MPV_PROPERTIES,
  PROXY_ORIGIN,
  STREAM_PATH,
  TAURI_COMMANDS,
  TAURI_EVENTS,
  THROTTLE_MS,
  TimePosWatchdog,
  toTimeRanges,
  VOLUME_SCALE,
  type MpvEventCallbacks,
  type MpvRange,
} from "./mpvProtocol";
import { TimeInterpolator } from "./timeInterpolator";

/** MpvEngine — mpv sidecar playback over Tauri JSON IPC; Rust contract + watchdog in mpvProtocol.ts. */

const LOGGER_SOURCE = "MpvAudioController";

export class MpvAudioController {
  private listeners: { [K in keyof AudioEventMap]?: AudioEventHandler<K>[] } =
    {};
  private unlistenFns: UnlistenFn[] = [];
  private started = false;
  private proxyPort: number | null = null;
  private lastTrack: Track | null = null;
  private currentTrackId: string | null = null;
  private playbackFinished = true;
  private paused = false;
  private currentTime = 0;
  private duration = 0;
  private cacheRanges: MpvRange[] = [];
  private pendingSeek: number | null = null;
  private volume = 1;
  private muted = false;
  private throttle = freshThrottleClocks();
  // Why: guards the once-per-track `first-audio` emit so interpolated
  // timeupdates (which bypass onTimeUpdate) can never fake it.
  private firstAudioEmitted = false;
  private buffering = new BufferingTracker((isBuffering) => {
    this.emit("buffering", { isBuffering });
  });
  private watchdog = new TimePosWatchdog(
    () => usePlayerStore.getState().isPlaying,
    () =>
      invoke(TAURI_COMMANDS.mpvGetProperty, { prop: MPV_PROPERTIES.timePos }),
    (time) => {
      this.events.onTimeUpdate(time);
    },
  );
  private interpolator = new TimeInterpolator(
    () => usePlayerStore.getState().isPlaying,
    (time) => {
      // Interpolated emit: clock + consumer event only — deliberately NOT
      // watchdog.noteEmit/buffering.onTimeTick, so the watchdog keeps polling
      // during a push gap (its poll is the truth resync that re-bases this).
      this.currentTime = time;
      this.emitTimeupdate(time);
    },
  );

  private readonly events: MpvEventCallbacks = {
    onTimeUpdate: (time) => {
      this.currentTime = time;
      this.interpolator.noteRealTime(time);
      this.watchdog.noteEmit();
      this.buffering.onTimeTick();
      // Why: only the REAL mpv push path proves audio bytes flow — the
      // interpolator calls emitTimeupdate directly and never lands here.
      if (!this.firstAudioEmitted) {
        this.firstAudioEmitted = true;
        this.emit("first-audio", undefined);
      }
      this.emitTimeupdate(time);
    },
    onDuration: (dur) => {
      this.duration = dur;
      this.emit("durationchange", { duration: dur });
    },
    onPauseChange: (paused) => {
      this.paused = paused;
      if (paused) {
        // Drop the base: elapsed wall time during the pause must never drift
        // into the interpolation when playback resumes.
        this.interpolator.reset();
        this.watchdog.stop();
        this.emit("pause", undefined);
        usePlayerStore.getState().setIsPlaying(false);
      } else {
        this.buffering.onPlayEvent();
        this.emit("play", undefined);
        usePlayerStore.getState().setIsPlaying(true);
        this.watchdog.start();
        this.interpolator.start();
      }
    },
    onBuffering: (isBuffering) => {
      this.buffering.reportMpvBuffering(isBuffering);
    },
    onCacheState: (ranges) => {
      this.cacheRanges = ranges;
      this.emitProgress();
    },
    onFileLoaded: () => {
      this.applyPendingSeek();
    },
    onEndFile: (outcome) => {
      this.playbackFinished = true;
      this.interpolator.reset();
      if (outcome === "eof") {
        this.emit("ended", undefined);
        return;
      }
      this.emitEndFileError();
    },
    onMalformed: (detail) => {
      this.logWarn(detail);
    },
  };

  private getHandlers<K extends keyof AudioEventMap>(
    event: K,
  ): AudioEventHandler<K>[] {
    return this.listeners[event] ?? (this.listeners[event] = []);
  }

  public on<K extends keyof AudioEventMap>(
    event: K,
    handler: AudioEventHandler<K>,
  ): () => void {
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

  private logWarn(message: string): void {
    void captureError({ level: "warn", source: LOGGER_SOURCE, message });
  }

  private logError(message: string): void {
    void captureError({ level: "error", source: LOGGER_SOURCE, message });
  }

  private throttled(clock: { last: number }, emit: () => void): void {
    const now = Date.now();
    // `last === 0` sentinel: FIRST event always emits; Date.now() is monotonic.
    if (clock.last === 0 || now - clock.last > THROTTLE_MS) {
      clock.last = now;
      emit();
    }
  }

  private emitTimeupdate(time: number): void {
    this.throttled(this.throttle.lastTimeUpdate, () => {
      this.emit("timeupdate", { currentTime: time, duration: this.duration });
    });
  }

  private emitProgress(): void {
    this.throttled(this.throttle.lastProgressEmit, () => {
      this.emit("progress", undefined);
    });
  }

  private emitEndFileError(): void {
    this.logError("mpv end-file reason=error (track failed to play)");
    this.emit("error", {
      message: "File lỗi định dạng, đang bỏ qua...",
      code: "format_error",
    });
    // Plan 2.3: error does NOT emit `ended` — PlayerBar marks it broken from the code.
  }

  private async sendCommand(cmd: string[]): Promise<void> {
    await invoke(TAURI_COMMANDS.mpvCommand, { cmd });
  }

  private detachListeners(fns: UnlistenFn[]): void {
    for (const fn of fns) {
      try {
        fn();
      } catch (e: unknown) {
        this.logWarn(`unlisten-failed: ${describeError(e)}`);
      }
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    const attached: UnlistenFn[] = [];
    try {
      attached.push(
        await listen(TAURI_EVENTS.property, (event) => {
          dispatchPropertyEvent(event.payload, this.events);
        }),
        await listen(TAURI_EVENTS.event, (event) => {
          dispatchMpvEvent(event.payload, this.events);
        }),
      );
      await invoke(TAURI_COMMANDS.mpvSpawn);
    } catch (e: unknown) {
      this.detachListeners(attached);
      throw e;
    }
    this.unlistenFns = attached;
    this.started = true;
    // Fresh mpv starts at volume 100 — re-apply the stored (or muted) volume.
    this.applyVolume();
  }

  private async ensureProxyPort(): Promise<number> {
    if (this.proxyPort === null) {
      this.proxyPort = await invoke<number>(TAURI_COMMANDS.streamProxyStart);
    }
    return this.proxyPort;
  }

  private applyVolume(): void {
    const mpvVolume = this.muted ? 0 : this.volume * VOLUME_SCALE;
    void this.sendCommand([
      MPV_COMMANDS.setProperty,
      MPV_PROPERTY_ARGS.volume,
      String(Math.round(mpvVolume)),
    ]).catch((e: unknown) => {
      this.logWarn(`volume-apply-failed: ${describeError(e)}`);
    });
  }

  private beginTrack(track: Track, startTime?: number): void {
    this.lastTrack = track;
    this.currentTrackId = track.id;
    this.playbackFinished = false;
    // mpv resets the playhead on loadfile replace — report 0 immediately (plan 2.3 race rule).
    this.currentTime = 0;
    this.duration = 0;
    this.cacheRanges = [];
    this.pendingSeek = startTime ?? null;
    this.throttle = freshThrottleClocks();
    // Why: a new track has produced no audio yet — re-arm first-audio.
    this.firstAudioEmitted = false;
    // New track: no truth for it yet — the interpolator stays silent until
    // the first real time-pos push of THIS track (never drift from the old).
    this.interpolator.reset();
    this.interpolator.start();
    if (this.paused) {
      // mpv's pause flag is process-global: a loadfile while paused would
      // start the new track frozen. Clear it so the new track actually plays.
      this.paused = false;
      void this.sendCommand([
        MPV_COMMANDS.setProperty,
        MPV_PROPERTY_ARGS.pause,
        MPV_BOOL.no,
      ]).catch((e: unknown) => {
        this.logWarn(`resume-on-switch-failed: ${describeError(e)}`);
      });
    }
  }

  private playbackFailure(where: string, e: unknown): void {
    this.logError(`${where}: ${describeError(e)}`);
    this.emit("error", {
      message: "Không phát được bài hát này, hãy thử lại.",
      code: "network_interrupted",
    });
    usePlayerStore.getState().setIsPlaying(false);
  }

  public async playTrack(track: Track, startTime?: number): Promise<void> {
    try {
      if (this.currentTrackId === track.id && !this.playbackFinished) {
        // Same-track replay: paused -> resume only; playing -> no-op (web parity).
        if (this.paused) {
          await this.sendCommand([
            MPV_COMMANDS.setProperty,
            MPV_PROPERTY_ARGS.pause,
            MPV_BOOL.no,
          ]);
        }
        return;
      }
      await this.ensureStarted();
      const port = await this.ensureProxyPort();
      await this.sendCommand([
        MPV_COMMANDS.loadfile,
        `${PROXY_ORIGIN}:${String(port)}${STREAM_PATH}${track.id}`,
        MPV_COMMANDS.replace,
      ]);
      this.beginTrack(track, startTime);
      this.buffering.request();
    } catch (e: unknown) {
      this.playbackFailure("play-track-failed", e);
    }
  }

  public togglePlay(): void {
    if (!this.lastTrack) return;
    if (this.playbackFinished) {
      // Mirror HTMLMediaElement.play() on an ended element: restart from top.
      void this.playTrack(this.lastTrack);
      return;
    }
    void this.sendCommand([
      MPV_COMMANDS.setProperty,
      MPV_PROPERTY_ARGS.pause,
      this.paused ? MPV_BOOL.no : MPV_BOOL.yes,
    ]).catch((e: unknown) => {
      this.logWarn(`toggle-play-failed: ${describeError(e)}`);
    });
  }

  public pause(): void {
    if (!this.currentTrackId || this.playbackFinished) return;
    void this.sendCommand([
      MPV_COMMANDS.setProperty,
      MPV_PROPERTY_ARGS.pause,
      MPV_BOOL.yes,
    ]).catch((e: unknown) => {
      this.logWarn(`pause-failed: ${describeError(e)}`);
    });
  }

  public seek(time: number): void {
    if (!this.currentTrackId) {
      this.logWarn(`seek dropped: no track loaded, requested=${String(time)}s`);
      return;
    }
    this.buffering.request();
    void this.sendCommand([
      MPV_COMMANDS.seek,
      String(time),
      MPV_COMMANDS.absolute,
    ]).catch((e: unknown) => {
      this.logWarn(`seek-failed: ${describeError(e)}`);
    });
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
    // Muted: keep silent at 0 (unmute restores); pre-spawn it just stores — applied in ensureStarted.
    if (!this.muted && this.started) this.applyVolume();
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.started) this.applyVolume();
    return this.muted;
  }

  public getVolume(): number {
    return this.volume;
  }
  public isMuted(): boolean {
    return this.muted;
  }
  public getCurrentTime(): number {
    return this.currentTime;
  }

  public getDuration(): number {
    return this.duration;
  }

  public getBuffered(): BufferedSource {
    return {
      duration: this.duration,
      currentTime: this.currentTime,
      buffered: toTimeRanges(this.cacheRanges),
    };
  }

  public release(): void {
    this.detachListeners(this.unlistenFns);
    this.unlistenFns = [];
    this.started = false;
    this.proxyPort = null;
    this.lastTrack = null;
    this.currentTrackId = null;
    this.playbackFinished = true;
    this.paused = false;
    this.currentTime = 0;
    this.duration = 0;
    this.cacheRanges = [];
    this.pendingSeek = null;
    // Why: torn-down engine owns no track — stale flag must not suppress
    // the next track's first-audio after re-spawn.
    this.firstAudioEmitted = false;
    this.buffering.cancel();
    this.watchdog.stop();
    this.interpolator.reset();
    this.throttle = freshThrottleClocks();
    void invoke(TAURI_COMMANDS.mpvShutdown).catch((e: unknown) => {
      this.logWarn(`mpv-shutdown-failed: ${describeError(e)}`);
    });
  }

  private applyPendingSeek(): void {
    if (this.pendingSeek === null) return;
    const target = this.pendingSeek;
    this.pendingSeek = null;
    void this.sendCommand([
      MPV_COMMANDS.seek,
      String(target),
      MPV_COMMANDS.absolute,
    ]).catch((e: unknown) => {
      this.logWarn(`pending-seek-failed: ${describeError(e)}`);
    });
  }
}
