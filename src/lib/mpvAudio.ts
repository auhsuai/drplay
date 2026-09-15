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
  SEEK_ACK_TIMEOUT_MS,
  SEEK_ACK_TOLERANCE_SECS,
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
  // Why: release() must invalidate every async continuation still in flight
  // (listener attach / spawn / loadfile) so none resurrects engine state.
  private lifecycleEpoch = 0;
  /** Shared in-flight spawn attempt — concurrent playTrack calls join it. */
  private startPromise: Promise<boolean> | null = null;
  private proxyPort: number | null = null;
  private lastTrack: Track | null = null;
  private currentTrackId: string | null = null;
  private playbackFinished = true;
  private paused = false;
  private currentTime = 0;
  private duration = 0;
  private cacheRanges: MpvRange[] = [];
  private pendingSeek: number | null = null;
  // Why (S1): mpv's time-pos push chain + watchdog polls can still carry
  // pre-seek values in flight. Until a report lands within tolerance of the
  // requested target, every time-pos is either stale or unacknowledged.
  private seekTarget: number | null = null;
  private seekFailsafe: ReturnType<typeof setTimeout> | null = null;
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
    // Why: paused-for-cache stalls keep isPlaying true — gate the synthetic
    // clock on the spinner so fill/clock freeze instead of running blind.
    () => this.buffering.isShown(),
  );

  private readonly events: MpvEventCallbacks = {
    onTimeUpdate: (time) => {
      if (this.seekTarget !== null) {
        // Seek ack (S1): drop every report that is not close to the target —
        // queued pre-seek pushes and in-flight watchdog polls both land here,
        // so this single filter protects the clock, the interpolator base,
        // first-audio and the spinner tick from stale regressions.
        if (Math.abs(time - this.seekTarget) > SEEK_ACK_TOLERANCE_SECS) return;
        this.clearSeekAck();
      }
      this.currentTime = time;
      this.interpolator.noteRealTime(time);
      this.watchdog.noteEmit();
      this.buffering.onTimeTick(time);
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
        // v3: pause=false no longer settles the spinner (S3/S4) — it also
        // follows a switch-while-paused clearing mpv's global flag, proving
        // nothing about audio flow. Truth settles via ticks/end-file/mpv.
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
      // Why (S4): the track is terminal — no more ticks can confirm progress,
      // so the spinner must not ride the 8s safety net (eof and error alike).
      this.buffering.settle();
      this.watchdog.stop();
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
    // Why: parity with the old web engine (git 71bc085^: error THEN ended) —
    // `ended` is what drives auto-advance. PlayerBar marks the track broken on
    // the error and its storm guard caps the retry loop, so the queue moves on.
    this.emit("ended", undefined);
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

  private async ensureStarted(): Promise<boolean> {
    if (this.started) return true;
    // Why: dedupe concurrent playTrack calls — one spawn attempt wins, the
    // rest join it instead of attaching a second listener set.
    if (this.startPromise) return this.startPromise;
    const attempt = this.startEngine();
    this.startPromise = attempt;
    try {
      return await attempt;
    } finally {
      // Identity check: only this exact attempt owns the memo — a release or
      // a newer attempt must never be clobbered here.
      if (this.startPromise === attempt) this.startPromise = null;
    }
  }

  /** Spawn attempt body. Returns false when release() made it stale mid-flight. */
  private async startEngine(): Promise<boolean> {
    const epoch = this.lifecycleEpoch;
    const attached: UnlistenFn[] = [];
    try {
      attached.push(
        await listen(TAURI_EVENTS.property, (event) => {
          dispatchPropertyEvent(event.payload, this.events);
        }),
      );
      if (this.isStale(epoch)) return this.disposeStaleStart(attached);
      attached.push(
        await listen(TAURI_EVENTS.event, (event) => {
          dispatchMpvEvent(event.payload, this.events);
        }),
      );
      if (this.isStale(epoch)) return this.disposeStaleStart(attached);
      await invoke(TAURI_COMMANDS.mpvSpawn);
      if (this.isStale(epoch)) return this.disposeStaleStart(attached);
    } catch (e: unknown) {
      this.detachListeners(attached);
      throw e;
    }
    this.unlistenFns = attached;
    this.started = true;
    // Fresh mpv starts at volume 100 — re-apply the stored (or muted) volume.
    this.applyVolume();
    return true;
  }

  /** True when release() bumped the epoch past the captured one. */
  private isStale(epoch: number): boolean {
    return epoch !== this.lifecycleEpoch;
  }

  /** A stale start owns handles release() never saw: drop them, touch no state. */
  private disposeStaleStart(attached: UnlistenFn[]): boolean {
    this.detachListeners(attached);
    return false;
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
    // Why: a new track invalidates any seek filter from the previous one.
    this.clearSeekAck();
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
    // Why (S4): a failed command means no ticks will ever confirm progress —
    // never leave the spinner hanging on a dead path.
    this.buffering.settle();
    this.emit("error", {
      message: "Không phát được bài hát này, hãy thử lại.",
      code: "network_interrupted",
    });
    usePlayerStore.getState().setIsPlaying(false);
  }

  public async playTrack(track: Track, startTime?: number): Promise<void> {
    const epoch = this.lifecycleEpoch;
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
      if (!(await this.ensureStarted())) return;
      // Why: release() mid-start must abort silently — no loadfile into a
      // shutdown mpv and no state resurrection after the teardown.
      if (this.isStale(epoch)) return;
      const port = await this.ensureProxyPort();
      if (this.isStale(epoch)) return;
      await this.sendCommand([
        MPV_COMMANDS.loadfile,
        `${PROXY_ORIGIN}:${String(port)}${STREAM_PATH}${track.id}`,
        MPV_COMMANDS.replace,
      ]);
      if (this.isStale(epoch)) return;
      this.beginTrack(track, startTime);
      // v3 (S2): a new track promotes the spinner immediately — waiting for
      // the 250ms display delay left a no-source gap between first-audio and
      // the promote (the button flashed the Pause icon mid-load).
      this.buffering.request(true);
    } catch (e: unknown) {
      // Why: a command failing because release() tore the engine down is not
      // a playback failure — release paths are deliberately silent.
      if (this.isStale(epoch)) return;
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
    // Symmetric with pause(): after end-file there is no live track — a seek
    // would hit an idle mpv, reject, and arm a dead spinner window.
    if (!this.currentTrackId || this.playbackFinished) {
      this.logWarn(`seek dropped: no active track, requested=${String(time)}s`);
      return;
    }
    this.sendSeek(time);
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
    // Why: bump FIRST so every in-flight continuation (listener attach, spawn,
    // loadfile) observes the teardown at its next await boundary and aborts.
    this.lifecycleEpoch += 1;
    this.startPromise = null;
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
    this.clearSeekAck();
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

  /**
   * S1 seek-ack: snap the clock to the target, filter stale pre-seek reports
   * until mpv confirms, and re-arm the spinner (display-delay anti-flash).
   */
  private sendSeek(target: number): void {
    this.clearSeekAck();
    this.seekTarget = target;
    this.currentTime = target;
    // Snap the UI immediately: `last === 0` is the throttle's force-emit
    // sentinel, so the clock never sits on the old position after a drag.
    this.throttle.lastTimeUpdate.last = 0;
    this.emitTimeupdate(target);
    // Why: reset() drops the pre-seek interpolation base (E1); start() keeps
    // the synthetic clock alive afterwards, silent until the ack resyncs it
    // (same reset+start pattern as beginTrack).
    this.interpolator.reset();
    this.interpolator.start();
    this.seekFailsafe = setTimeout(() => {
      this.seekFailsafe = null;
      this.seekTarget = null;
    }, SEEK_ACK_TIMEOUT_MS);
    this.buffering.request();
    void this.sendCommand([
      MPV_COMMANDS.seek,
      String(target),
      MPV_COMMANDS.absolute,
    ]).catch((e: unknown) => {
      // A failed seek cannot ack: unfilter at once instead of waiting out the
      // failsafe timer.
      this.clearSeekAck();
      this.logWarn(`seek-failed: ${describeError(e)}`);
    });
  }

  /** Drops the seek-ack filter + its failsafe (ack, new track, release). */
  private clearSeekAck(): void {
    this.seekTarget = null;
    if (this.seekFailsafe !== null) {
      clearTimeout(this.seekFailsafe);
      this.seekFailsafe = null;
    }
  }

  private applyPendingSeek(): void {
    if (this.pendingSeek === null) return;
    const target = this.pendingSeek;
    this.pendingSeek = null;
    this.sendSeek(target);
  }
}
