import type { Track } from "../types";
import type { BufferedSource } from "../utils/bufferedRange";

export type NativeAudioStatus =
  "idle" | "loading" | "playing" | "ended" | "error";

export type NativeAudioState = {
  status: NativeAudioStatus;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  buffering: boolean;
  rate: number;
  // Buffered-end estimate in seconds (Media3 Player.getBufferedPosition,
  // reported by the plugin snapshot). Optional so update skew stays safe in
  // BOTH directions: an older plugin simply omits the key (read as
  // undefined → treated as 0) and a newer plugin's extra key is ignored by
  // JS structural typing — no version handshake needed.
  bufferedPosition?: number;
  error?: string;
};

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

// The native engine's own event map is the SAME shape as the shared contract
// — keep it as an alias of PlaybackEngineEventMap instead of duplicating the
// literal map, so the engine class body reads exactly as before.
export type NativeAudioEventMap = PlaybackEngineEventMap;
export type NativeAudioEventHandler<K extends keyof PlaybackEngineEventMap> =
  PlaybackEngineEventHandler<K>;

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
  release(): void | Promise<void>;
}
