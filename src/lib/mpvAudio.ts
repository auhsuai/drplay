import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Track } from "../types";
import { captureError } from "../utils/errorLog";
import { usePlayerStore } from "../store/playerStore";
import type { BufferedSource } from "../utils/bufferedRange";
import type { AudioEventMap, AudioEventHandler } from "./audioNativeEvents";
import {
  describeError,
  dispatchMpvEvent,
  dispatchPropertyEvent,
  MPV_BOOL,
  MPV_COMMANDS,
  MPV_PROPERTY_ARGS,
  PROXY_ORIGIN,
  STREAM_PATH,
  TAURI_COMMANDS,
  TAURI_EVENTS,
  THROTTLE_MS,
  toTimeRanges,
  VOLUME_SCALE,
  type MpvEventCallbacks,
  type MpvRange,
} from "./mpvProtocol";

/** MpvEngine — mpv sidecar playback over Tauri JSON IPC (plan 2026-09-11 2.3).
 *  Rust contract fixed by Tasks 1+2 (constants/dispatch in mpvProtocol.ts),
 *  mapped onto the AudioEventMap payloads of audioNativeEvents.ts. */

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
  private throttle = {
    lastTimeUpdate: { last: 0 },
    lastProgressEmit: { last: 0 },
  };

  // Stable dispatch callbacks — created once; property events are frequent.
  private readonly events: MpvEventCallbacks = {
    onTimeUpdate: (time) => {
      this.currentTime = time;
      this.emitTimeupdate(time);
    },
    onDuration: (dur) => {
      this.duration = dur;
      this.emit("durationchange", { duration: dur });
    },
    onPauseChange: (paused) => {
      this.paused = paused;
      if (paused) {
        this.emit("pause", undefined);
        usePlayerStore.getState().setIsPlaying(false);
      } else {
        this.emit("play", undefined);
        usePlayerStore.getState().setIsPlaying(true);
      }
    },
    onBuffering: (isBuffering) => {
      this.emit("buffering", { isBuffering });
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
  ): void {
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
    // `last === 0` sentinel: the FIRST event always emits (web-engine
    // pattern). Date.now() is monotonic and > 0 in real sessions.
    if (clock.last === 0 || now - clock.last > THROTTLE_MS) {
      clock.last = now;
      emit();
    }
  }

  private emitTimeupdate(time: number): void {
    this.throttled(this.throttle.lastTimeUpdate, () => {
      this.emit("timeupdate", {
        currentTime: time,
        duration: this.duration,
      });
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
    // Plan 2.3 contract: error does NOT emit `ended`. PlayerBar marks the
    // track broken from the format_error code; auto-advance stays manual.
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
    // A fresh mpv process starts at volume 100 — re-apply the stored (or
    // muted) facade volume so pre-playback volume/mute choices survive spawn.
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
    // mpv resets the playhead on loadfile replace, but its property event may
    // lag — report 0 immediately (plan 2.3 race rule).
    this.currentTime = 0;
    this.duration = 0;
    this.cacheRanges = [];
    this.pendingSeek = startTime ?? null;
    this.throttle = {
      lastTimeUpdate: { last: 0 },
      lastProgressEmit: { last: 0 },
    };
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
        // Same-track replay (PlayerBar re-invokes playTrack on resume):
        // paused -> resume only; already playing -> no-op (web parity).
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
    // While muted the facade keeps volume silent at 0 (unmute restores the
    // stored value); before spawn it just stores — applied in ensureStarted.
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
    this.throttle = {
      lastTimeUpdate: { last: 0 },
      lastProgressEmit: { last: 0 },
    };
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
