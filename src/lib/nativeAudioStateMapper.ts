/** Pure state→event mapper extracted from NativeAudioEngine.onNativeState —
 *  no tauri imports, no store access, no emit side effects: it returns the
 *  queued events and the engine fans them out. Owns the two pieces of
 *  playback-edge bookkeeping the engine used to carry (wasPlaying,
 *  lastTimeUpdate) so the mapping stays a single self-contained unit. */
import type { NativeAudioEventMap, NativeAudioState } from "./nativeAudioTypes";

/** One queued event: a discriminated pair derived from NativeAudioEventMap so
 *  the engine's fan-out loop stays fully typed (no casts). */
export type MapperEmit = {
  [K in keyof NativeAudioEventMap]: {
    event: K;
    payload: NativeAudioEventMap[K];
  };
}[keyof NativeAudioEventMap];

export interface MapperOptions {
  /** True while a JS-initiated playTrack chain is executing (load-intent
   *  window) — Media3 reports isPlaying=false while buffering inside it and
   *  that must not read as a pause. */
  loadIntentActive: boolean;
  /** The bound track is m4a moov-at-end — enriches the error message. */
  currentTrackStreamUnplayable: boolean;
  /** Store sync hook: called exactly where the engine used to call
   *  usePlayerStore.getState().setIsPlaying. */
  onStorePlaying: (playing: boolean) => void;
}

export interface MapperResult {
  emit: MapperEmit[];
}

export class NativeStateMapper {
  static readonly TIMEUPDATE_THROTTLE_MS = 200;

  private wasPlaying = false;
  private lastTimeUpdate = 0;

  /** Map a plugin snapshot onto the AudioController event surface. Mapping is
   *  verbatim from the original onNativeState — the branch order matters. */
  apply(
    prev: NativeAudioState | null,
    state: NativeAudioState,
    opts: MapperOptions,
  ): MapperResult {
    const emit: MapperEmit[] = [];

    if (state.status === "error") {
      const message = state.error ?? "native playback error";
      // m4a moov-at-end (streamUnplayable): ExoPlayer can only play it if the
      // server honors byte ranges; when it still fails, say why instead of a
      // bare format_error. The code stays "format_error" and the ended emit
      // below (auto-advance parity) is untouched.
      const hint = opts.currentTrackStreamUnplayable
        ? " (m4a moov-at-end — file không phát trực tiếp được)"
        : "";
      emit.push({
        event: "error",
        payload: { message: `${message}${hint}`, code: "format_error" },
      });
      // Parity with AudioController: error → ended → auto-advance.
      emit.push({ event: "ended", payload: undefined });
      this.wasPlaying = false;
      return { emit };
    }

    if (state.status === "ended") {
      emit.push({ event: "ended", payload: undefined });
      this.wasPlaying = false;
      return { emit };
    }

    if (state.buffering && !prev?.buffering) {
      emit.push({ event: "buffering", payload: { isBuffering: true } });
    } else if (!state.buffering && prev?.buffering) {
      emit.push({ event: "buffering", payload: { isBuffering: false } });
    }

    // Media3 collapses isPlaying to false while STATE_BUFFERING (isPlaying =
    // READY && playWhenReady && !suppressed), so a buffering snapshot can
    // never distinguish "buffering after a seek / slow network — the user
    // still intends playback" from "user paused mid-buffer". Only a SETTLED
    // not-playing snapshot ({isPlaying:false, buffering:false}) proves a
    // pause: Kotlin's pause() flips playWhileReady while the player stays
    // READY, so a real pause always lands with buffering=false.
    const pausedWhileBuffering = state.buffering && !state.isPlaying;

    if (state.isPlaying && !this.wasPlaying) {
      emit.push({ event: "play", payload: undefined });
      opts.onStorePlaying(true);
    } else if (
      !state.isPlaying &&
      this.wasPlaying &&
      // Inside a JS-initiated load window Media3 reports isPlaying=false
      // while buffering — that is the load, not a pause. See loadIntentActive.
      !opts.loadIntentActive &&
      // See pausedWhileBuffering: buffering snapshots never fire the edge,
      // no matter how long the buffering lasts — no time-window heuristic.
      !pausedWhileBuffering
    ) {
      emit.push({ event: "pause", payload: undefined });
      opts.onStorePlaying(false);
    }
    // A buffering-shaped not-playing snapshot must not corrupt the play-state
    // memory OUTSIDE the load window: keep wasPlaying=true through it so a
    // REAL pause right after (or during) the buffering still has its edge
    // once buffering settles, and the resumed-READY tick needs no phantom
    // "play" (the store never flipped). Load-window snapshots keep the old
    // unconditional clobber — the READY play edge re-affirms it.
    if (!pausedWhileBuffering || opts.loadIntentActive) {
      this.wasPlaying = state.isPlaying;
    }

    if (state.duration !== prev?.duration && state.duration > 0) {
      emit.push({
        event: "durationchange",
        payload: { duration: state.duration },
      });
    }

    // Buffer-bar input: emit "progress" only when the buffered estimate
    // actually MOVED. The plugin ticks at 40Hz, so emitting unconditionally
    // would spam DOM writes; Media3 has no dedicated buffered-position event
    // (EVENT_IS_LOADING_CHANGED is the closest and carries no position), so
    // the JS-side diff mirrors desktop AudioController's throttled native
    // `progress` handler. Emitted outside the timeupdate throttle gate so
    // paused-loading buffer growth still refreshes the bar.
    if (state.bufferedPosition !== prev?.bufferedPosition) {
      emit.push({ event: "progress", payload: undefined });
    }

    // Idle snapshots (initialize/get_state/pause right after a cold-start
    // session restore) must not surface as timeupdate: AudioController never
    // emits one without real media state, and SeekBar applies the payload
    // unconditionally, so a {0,0} push wipes the restored duration/position
    // seed to 0:00. The edge emits above must keep running untouched — only
    // the throttled tick is gated.
    if (state.duration > 0 || state.currentTime > 0) {
      // Throttle to ~5/s (desktop THROTTLE_MS parity) — the plugin ticks every
      // 25ms in foreground.
      const now = performance.now();
      if (
        now - this.lastTimeUpdate >=
        NativeStateMapper.TIMEUPDATE_THROTTLE_MS
      ) {
        this.lastTimeUpdate = now;
        emit.push({
          event: "timeupdate",
          payload: {
            currentTime: state.currentTime,
            duration: state.duration,
          },
        });
      }
    }

    return { emit };
  }
}
