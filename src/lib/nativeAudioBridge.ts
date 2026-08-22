import { invoke, addPluginListener } from "@tauri-apps/api/core";
import { captureError } from "../utils/errorLog";
import { IS_MOBILE } from "../utils/platform";
import { usePlayerStore } from "../store/playerStore";
import type { Track } from "../types";
import { AudioController } from "./AudioController";
import type { BufferedSource } from "../utils/bufferedRange";

/**
 * Native (ExoPlayer/Media3) audio engine for Android — the PRIMARY playback
 * path on mobile (GATE branch B: the SW proxy is dead on Tauri Android,
 * wry#1710). Desktop playback is 100% untouched: this module is inert unless
 * IS_MOBILE, and `getPlaybackEngine()` returns the desktop AudioController
 * singleton on every non-mobile platform.
 *
 * The engine mirrors AudioController's public surface (on/playTrack/pause/
 * seek/getCurrentTime/getDuration/getBuffered/setVolume/toggleMute/release)
 * so the whole desktop player UI layer (PlayerBar storm guard, SeekBar,
 * auto-advance, session save) works against it unchanged — only the transport
 * differs: tauri-plugin-native-audio commands instead of HTMLAudioElement.
 */

export type NativeAudioStatus =
  "idle" | "loading" | "playing" | "ended" | "error";

export type NativeAudioState = {
  status: NativeAudioStatus;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  buffering: boolean;
  rate: number;
  error?: string;
};

type NativeAudioEventMap = {
  timeupdate: { currentTime: number; duration: number };
  durationchange: { duration: number };
  buffering: { isBuffering: boolean };
  progress: undefined;
  error: { message: string; code: string };
  ended: undefined;
  play: undefined;
  pause: undefined;
};

type NativeAudioEventHandler<K extends keyof NativeAudioEventMap> = (
  payload: NativeAudioEventMap[K],
) => void;

/** Events both engines emit, with identical payload shapes — the shared
 *  contract the desktop UI layer (PlayerBar/SeekBar/session save) listens on. */
export type PlaybackEngineEventMap = {
  timeupdate: { currentTime: number; duration: number };
  durationchange: { duration: number };
  buffering: { isBuffering: boolean };
  progress: undefined;
  error: { message: string; code: string };
  ended: undefined;
  play: undefined;
  pause: undefined;
};

export type PlaybackEngineEventHandler<K extends keyof PlaybackEngineEventMap> =
  (payload: PlaybackEngineEventMap[K]) => void;

/** Compile-time contract shared by the desktop AudioController and the native
 *  ExoPlayer engine. Both classes `implements` this, so a surface drift (a new
 *  method on one side, a changed signature on the other) fails tsc instead of
 *  silently diverging at runtime. */
export interface PlaybackEngine {
  on<K extends keyof PlaybackEngineEventMap>(
    event: K,
    handler: PlaybackEngineEventHandler<K>,
  ): () => void;
  playTrack(track: Track, startTime?: number): Promise<void>;
  /** Transport ops are sync on desktop, async on the native engine — the
   *  union documents both (consumers may ignore the returned promise). */
  pause(): void | Promise<void>;
  togglePlay(): void | Promise<void>;
  seek(time: number): void | Promise<void>;
  getCurrentTime(): number;
  getDuration(): number;
  getBuffered(): BufferedSource;
  setVolume(vol: number): void;
  toggleMute(): boolean;
  getVolume(): number;
  isMuted(): boolean;
  release(): void | Promise<void>;
}

/** Plugin command names (tauri-plugin-native-audio) — single source of truth;
 *  the exact strings are asserted in nativeAudioBridge.test.ts. */
const PLUGIN_COMMAND = {
  initialize: "plugin:native-audio|initialize",
  play: "plugin:native-audio|play",
  pause: "plugin:native-audio|pause",
  setSource: "plugin:native-audio|set_source",
  seekTo: "plugin:native-audio|seek_to",
} as const;

/** Google Drive media download URL (token travels in the Authorization
 *  header — Google blocked token query params since 2020). */
export function buildDriveStreamUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
}

/** Empty TimeRanges for getBuffered(): the plugin exposes no buffered-range
 *  info, so the buffer bar renders empty on mobile (position fill only). */
function emptyBuffered(): TimeRanges {
  return {
    length: 0,
    start: () => 0,
    end: () => 0,
  };
}

/** Native ExoPlayer engine implementing the shared PlaybackEngine contract —
 *  export the class type so tests can type the singleton. */
export class NativeAudioEngine implements PlaybackEngine {
  private static readonly TIMEUPDATE_THROTTLE_MS = 200;

  private listeners: {
    [K in keyof NativeAudioEventMap]?: NativeAudioEventHandler<K>[];
  } = {};

  private initPromise: Promise<void> | undefined;
  private token: string | null = null;
  private currentTrackId: string | null = null;
  // The full Track bound to the current source — read in the error path to
  // enrich the emitted message when the track is known-unstreamable (m4a
  // moov-at-end flagged by the metadata pipeline). Cleared on release().
  private currentTrack: Track | null = null;
  private lastState: NativeAudioState | null = null;
  private lastTimeUpdate = 0;
  private wasPlaying = false;
  // CF-2 fix (rapid A→B playTrack interleave): two mechanisms combined.
  // 1) playChain serializes load chains FIFO so one chain's set_source/
  //    seek_to/play commands can never interleave with another chain's.
  // 2) playSeq is a latest-wins generation (desktop parity: AudioController's
  //    changeToken): a chain that has been superseded while queued or while
  //    suspended on an await exits without firing its remaining commands,
  //    so no seek(restoreA)/play(A) ever lands on the newer source.
  private playSeq = 0;
  private playChain: Promise<void> = Promise.resolve();

  /** Initialize the plugin once (notification permission on Android 13+ is
   *  requested by the plugin during initialize()). Safe to call repeatedly. */
  initOnce(): Promise<void> {
    if (!IS_MOBILE) return Promise.resolve();
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await invoke(PLUGIN_COMMAND.initialize);
        // Listener lives for the whole app session (no per-track teardown).
        await addPluginListener(
          "native-audio",
          "native_audio_state",
          (state: NativeAudioState) => {
            this.onNativeState(state);
          },
        );
      })().catch((e: unknown) => {
        // Reset so a later retry (e.g. after permission grant) can re-init.
        this.initPromise = undefined;
        throw e;
      });
    }
    return this.initPromise;
  }

  /** Access token for the Authorization header — kept in memory only, never
   *  logged, cleared on release(). */
  setToken(token: string | null): void {
    this.token = token;
  }

  async playTrack(track: Track, startTime?: number): Promise<void> {
    if (!IS_MOBILE) return;
    const seq = ++this.playSeq;
    const turn = this.playChain.then(() =>
      this.runPlayChain(seq, track, startTime),
    );
    // A failed load must not poison the queue: its error still reaches THIS
    // call's caller via `turn`, while later queued chains start settled.
    this.playChain = turn.catch(() => undefined);
    return turn;
  }

  /** One serialized load chain — runs only after every earlier playTrack
   *  chain has settled. `seq` staleness is re-checked after each await so a
   *  superseded chain abandons the rest of its commands (latest-wins). */
  private async runPlayChain(
    seq: number,
    track: Track,
    startTime?: number,
  ): Promise<void> {
    if (seq !== this.playSeq) return;
    await this.initOnce();
    if (seq !== this.playSeq) return;

    this.currentTrack = track;

    if (this.currentTrackId === track.id) {
      const state = this.lastState;
      if (state && !state.isPlaying) {
        await this.invokeStateful(PLUGIN_COMMAND.play);
      }
      return;
    }

    this.currentTrackId = track.id;
    await this.invokeStateful(PLUGIN_COMMAND.setSource, {
      src: buildDriveStreamUrl(track.id),
      title: track.title,
      artist: track.artist,
      headers: this.token
        ? { Authorization: `Bearer ${this.token}` }
        : undefined,
    });
    if (seq !== this.playSeq) return;

    if (startTime !== undefined && startTime > 0) {
      await this.invokeStateful(PLUGIN_COMMAND.seekTo, {
        position: startTime,
      });
      if (seq !== this.playSeq) return;
    }
    await this.invokeStateful(PLUGIN_COMMAND.play);
  }

  async pause(): Promise<void> {
    if (!IS_MOBILE) return;
    await this.initOnce().catch(() => undefined);
    await this.invokeStateful(PLUGIN_COMMAND.pause);
  }

  async togglePlay(): Promise<void> {
    if (!IS_MOBILE) return;
    const state = this.lastState;
    if (state?.isPlaying) {
      await this.pause();
    } else {
      await this.invokeStateful(PLUGIN_COMMAND.play);
    }
  }

  async seek(time: number): Promise<void> {
    if (!IS_MOBILE) return;
    await this.initOnce().catch(() => undefined);
    await this.invokeStateful(PLUGIN_COMMAND.seekTo, {
      position: time,
    });
  }

  getCurrentTime(): number {
    return this.lastState?.currentTime ?? 0;
  }

  getDuration(): number {
    return this.lastState?.duration ?? 0;
  }

  getBuffered(): BufferedSource {
    return {
      duration: this.lastState?.duration ?? 0,
      currentTime: this.lastState?.currentTime ?? 0,
      buffered: emptyBuffered(),
    };
  }

  /** Volume is not exposed by the plugin — keep the desktop API shape as
   *  no-ops so VolumeSlider renders unchanged on mobile. */
  setVolume(): void {}
  toggleMute(): boolean {
    return false;
  }
  getVolume(): number {
    return 1;
  }
  isMuted(): boolean {
    return false;
  }

  /** Logout / player-stop: stop playback and drop the token + track binding.
   *  The plugin's foreground service is stopped by the OS once playback
   *  pauses and the notification is dismissed. */
  async release(): Promise<void> {
    // Invalidate every queued/suspended play chain (latest-wins generation
    // bump): runPlayChain re-checks seq after each await, so no chain may
    // set_source/seek/play past a release (logout/stop) — same meaning as
    // usePlayer handleStop's abort guards (7484592). playTrack keeps working:
    // it assigns itself a fresh, newer seq.
    this.playSeq++;
    this.currentTrackId = null;
    this.currentTrack = null;
    this.token = null;
    if (!IS_MOBILE) return;
    try {
      await this.pause();
    } catch (e: unknown) {
      this.report("release-failed", e);
    }
  }

  getState(): NativeAudioState | null {
    return this.lastState;
  }

  on<K extends keyof NativeAudioEventMap>(
    event: K,
    handler: NativeAudioEventHandler<K>,
  ): () => void {
    const list = this.getHandlers(event);
    list.push(handler);
    return () => {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  private getHandlers<K extends keyof NativeAudioEventMap>(
    event: K,
  ): NativeAudioEventHandler<K>[] {
    return this.listeners[event] ?? (this.listeners[event] = []);
  }

  private emit<K extends keyof NativeAudioEventMap>(
    event: K,
    payload: NativeAudioEventMap[K],
  ): void {
    const handlers = this.listeners[event];
    if (handlers) {
      handlers.forEach((h) => {
        h(payload);
      });
    }
  }

  private async invokeStateful(
    command: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const state = await invoke<NativeAudioState | undefined>(
        command,
        payload,
      );
      if (state) this.onNativeState(state);
    } catch (e: unknown) {
      this.report(`${command} failed`, e);
      throw e;
    }
  }

  private report(context: string, e: unknown): void {
    void captureError({
      level: "warn",
      source: "nativeAudioBridge",
      message: `${context}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  /** Map plugin state events onto the AudioController event surface so the
   *  desktop UI layer (PlayerBar/SeekBar/session save) behaves identically. */
  private onNativeState(state: NativeAudioState): void {
    const prev = this.lastState;
    this.lastState = state;

    if (state.status === "error") {
      const message = state.error ?? "native playback error";
      // m4a moov-at-end (streamUnplayable): ExoPlayer can only play it if the
      // server honors byte ranges; when it still fails, say why instead of a
      // bare format_error. The code stays "format_error" and the ended emit
      // below (auto-advance parity) is untouched.
      const hint = this.currentTrack?.streamUnplayable
        ? " (m4a moov-at-end — file không phát trực tiếp được)"
        : "";
      this.emit("error", {
        message: `${message}${hint}`,
        code: "format_error",
      });
      // Parity with AudioController: error → ended → auto-advance.
      this.emit("ended", undefined);
      this.wasPlaying = false;
      return;
    }

    if (state.status === "ended") {
      this.emit("ended", undefined);
      this.wasPlaying = false;
      return;
    }

    if (state.buffering && !prev?.buffering) {
      this.emit("buffering", { isBuffering: true });
    } else if (!state.buffering && prev?.buffering) {
      this.emit("buffering", { isBuffering: false });
    }

    if (state.isPlaying && !this.wasPlaying) {
      this.emit("play", undefined);
      usePlayerStore.getState().setIsPlaying(true);
    } else if (!state.isPlaying && this.wasPlaying) {
      this.emit("pause", undefined);
      usePlayerStore.getState().setIsPlaying(false);
    }
    this.wasPlaying = state.isPlaying;

    if (state.duration !== prev?.duration && state.duration > 0) {
      this.emit("durationchange", { duration: state.duration });
    }

    // Throttle to ~5/s (desktop THROTTLE_MS parity) — the plugin ticks every
    // 25ms in foreground.
    const now = performance.now();
    if (now - this.lastTimeUpdate >= NativeAudioEngine.TIMEUPDATE_THROTTLE_MS) {
      this.lastTimeUpdate = now;
      this.emit("timeupdate", {
        currentTime: state.currentTime,
        duration: state.duration,
      });
    }
  }
}

export const nativeAudioEngine = new NativeAudioEngine();

/**
 * Single engine selector for the whole app: desktop keeps the HTMLAudio
 * controller, mobile gets the native ExoPlayer engine. Both classes declare
 * `implements PlaybackEngine`, so their surface can never drift silently —
 * a signature change on either side fails tsc at compile time.
 */
export function getPlaybackEngine(): PlaybackEngine {
  return IS_MOBILE ? nativeAudioEngine : AudioController.getInstance();
}
