import { invoke, addPluginListener } from "@tauri-apps/api/core";
import { captureError } from "../utils/errorLog";
import { IS_MOBILE } from "../utils/platform";
import { usePlayerStore } from "../store/playerStore";
import type { Track } from "../types";
import type { BufferedSource } from "../utils/bufferedRange";
import type {
  NativeAudioEventMap,
  NativeAudioEventHandler,
  NativeAudioState,
  PlaybackEngine,
} from "./nativeAudioTypes";
import {
  PLUGIN_COMMAND,
  RESUME_HEALTH_CHECK_TIMEOUT_MS,
  SET_SOURCE_INVOKE_TIMEOUT_MS,
  TRANSPORT_INVOKE_TIMEOUT_MS,
  buildDriveStreamUrl,
  invokeWithTimeout,
} from "./nativeAudioInvoke";
import { buildSetQueuePayload, selectQueueTransport } from "./nativeAudioQueue";
import { NativeStateMapper } from "./nativeAudioStateMapper";

/** Empty TimeRanges for getBuffered(): the plugin exposes no buffered-range
 *  info, so the buffer bar renders empty on mobile (position fill only). */
function emptyBuffered(): TimeRanges {
  return {
    length: 0,
    start: () => 0,
    end: () => 0,
  };
}

/** Single-segment TimeRanges [0 → end] matching emptyBuffered's shape — the
 *  mobile analogue of desktop HTMLAudioElement.buffered with one loaded run. */
function makeSingleSegmentBuffered(end: number): TimeRanges {
  return {
    length: 1,
    start: () => 0,
    end: () => end,
  };
}

/** Native ExoPlayer engine implementing the shared PlaybackEngine contract —
 *  export the class type so tests can type the singleton. */
export class NativeAudioEngine implements PlaybackEngine {
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
  // State→event mapping (wasPlaying/lastTimeUpdate bookkeeping included)
  // lives in the pure NativeStateMapper; this engine only fans its queued
  // events out and keeps the engine-side state (lastState, queueMirror,
  // loadIntentActive, currentTrack) that feeds it.
  private mapper = new NativeStateMapper();
  // Native-queue mirror (set_queue path): the last playlist pushed to the
  // plugin. A native ExoPlayer auto-advance reports the new item's mediaId;
  // the JS side resolves it here to sync the store (UI + session save track
  // the real playing item). reset by release().
  private queueMirror: Track[] = [];
  // CF-2 fix (rapid A→B playTrack interleave): two mechanisms combined.
  // 1) playChain serializes load chains FIFO so one chain's set_source/
  //    seek_to/play commands can never interleave with another chain's.
  // 2) playSeq is a latest-wins generation (desktop parity: AudioController's
  //    changeToken): a chain that has been superseded while queued or while
  //    suspended on an await exits without firing its remaining commands,
  //    so no seek(restoreA)/play(A) ever lands on the newer source.
  private playSeq = 0;
  private playChain: Promise<void> = Promise.resolve();
  // Rapid-seek coalescing (latest-wins), the CF-2 mechanism applied to seek:
  // seeks ride the SAME playChain FIFO (so a seek never interleaves with a
  // running load's set_source/play), gated by their own seekSeq generation —
  // a queued seek that has been superseded by a newer seek exits silently
  // (dropped), mirroring ExoPlayer's pending-seek coalescing. seek() does NOT
  // bump playSeq (a seek must never invalidate a load) and playTrack does NOT
  // bump seekSeq (a queued seek stays valid across a superseded load).
  private seekSeq = 0;
  // Load-intent window (spinner fix): true while a JS-initiated playTrack
  // chain is executing (set_source/seek/play round-trips). Inside this window
  // Media3 reports isPlaying=false while buffering (isPlaying only flips true
  // at READY), which used to read as a "pause" edge and wrote isPlaying=false
  // over the user's play intent (set by usePlayer on track switch) — killing
  // the track-change spinner on Android. Edges outside the window (audio
  // focus loss, ended, error, a real user pause) sync the store exactly as
  // before; an explicit pause() closes the window first so a genuine pause
  // always wins, even mid-buffer.
  private loadIntentActive = false;
  // Long-suspend recovery: the visibilitychange listener is attached once per
  // engine (on first initOnce) and never re-attached on re-init, so a
  // recovered bridge never accumulates duplicate listeners.
  // resumeCheckInFlight guards two overlapping visible transitions.
  private resumeCheckListenerAttached = false;
  private resumeCheckInFlight = false;

  /** Initialize the plugin once (notification permission on Android 13+ is
   *  requested by the plugin during initialize()). Safe to call repeatedly. */
  initOnce(): Promise<void> {
    if (!IS_MOBILE) return Promise.resolve();
    if (!this.initPromise) {
      this.initPromise = (async () => {
        // The resume health-check listener rides on the first init so it
        // exists even when this first initialize() fails — the probe's
        // re-init path is then the only recovery.
        this.attachResumeHealthCheck();
        // Bounded like every other invoke: a wedged bridge must fail here
        // (and reset initPromise below) instead of hanging the first load
        // chain — or the resume re-init — forever.
        await invokeWithTimeout(
          invoke(PLUGIN_COMMAND.initialize),
          TRANSPORT_INVOKE_TIMEOUT_MS,
          PLUGIN_COMMAND.initialize,
        );
        // Listener lives for the whole app session (no per-track teardown).
        await invokeWithTimeout(
          addPluginListener(
            "native-audio",
            "native_audio_state",
            (state: NativeAudioState) => {
              this.onNativeState(state);
            },
          ),
          TRANSPORT_INVOKE_TIMEOUT_MS,
          "plugin:native-audio|register_listener",
        );
      })().catch((e: unknown) => {
        // Reset so a later retry (e.g. after permission grant) can re-init.
        this.initPromise = undefined;
        throw e;
      });
    }
    return this.initPromise;
  }

  /** Long-suspend recovery (tauri#15671 family): after the activity survives
   *  a long device sleep, the plugin event channel or the invoke bridge can
   *  be dead while the UI keeps rendering the cached lastState — progress
   *  freezes silently. On each visible transition, probe the bridge with the
   *  read-only get_state command; on failure reset the cached init, re-run
   *  initOnce() (re-subscribes the state listener) and re-pull the
   *  authoritative state through the normal onNativeState path. */
  private attachResumeHealthCheck(): void {
    if (this.resumeCheckListenerAttached) return;
    this.resumeCheckListenerAttached = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      void this.runResumeHealthCheck();
    });
  }

  private async runResumeHealthCheck(): Promise<void> {
    if (this.resumeCheckInFlight) return;
    this.resumeCheckInFlight = true;
    try {
      await this.pullCurrentState();
    } catch (e: unknown) {
      this.report("resume health-check failed, re-initializing", e);
      // Drop the cached init (possibly a dead listener registration) and
      // rebuild it; initOnce re-subscribes the plugin listener.
      this.initPromise = undefined;
      try {
        await this.initOnce();
        await this.pullCurrentState();
      } catch (reinitError: unknown) {
        // Still dead: everything stays reset so the NEXT visible transition
        // retries once more (bounded — no polling, no infinite loop).
        this.report("resume re-init failed", reinitError);
      }
    } finally {
      this.resumeCheckInFlight = false;
    }
  }

  /** Pull the authoritative player state once and feed it through the same
   *  onNativeState path as live events, so store + UI re-sync after a
   *  suspend: a still-playing foreground service resumes ticking into the
   *  fresh listener, and play/pause edges fire exactly as they would for
   *  live events (identical-state pushes are no-ops by design). */
  private async pullCurrentState(): Promise<void> {
    const state = await invokeWithTimeout(
      invoke<NativeAudioState | undefined>(PLUGIN_COMMAND.getState),
      RESUME_HEALTH_CHECK_TIMEOUT_MS,
      PLUGIN_COMMAND.getState,
    );
    if (state) this.onNativeState(state);
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
    // Open the load-intent window for this chain; closed in finally no
    // matter how the chain exits (completed, superseded or failed). Safe
    // against interleaving: a state processed inside any chain's window
    // already flips wasPlaying to its own isPlaying value, so a gap between
    // a superseded chain's exit and the next chain's start cannot fake a
    // pause edge (the edge needs wasPlaying=true, i.e. a READY state).
    this.loadIntentActive = true;
    try {
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
      // Native queue push: when the track belongs to a multi-item store
      // queue, load the WHOLE playlist so ExoPlayer auto-advances natively
      // (a backgrounded WebView cannot run the JS advance — Bug 3). A
      // single-item queue keeps the plain setSource path. seek/play below
      // act on the startIndex item.
      const { playbackQueue, playMode } = usePlayerStore.getState();
      const { useNativeQueue, queueMirror } = selectQueueTransport(
        track,
        playbackQueue,
      );
      if (useNativeQueue) {
        this.queueMirror = queueMirror;
        await this.invokeStateful(
          PLUGIN_COMMAND.setQueue,
          buildSetQueuePayload(
            playbackQueue,
            playbackQueue.findIndex((t) => t.id === track.id),
            this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
            playMode,
          ),
        );
      } else {
        this.queueMirror = queueMirror;
        await this.invokeStateful(PLUGIN_COMMAND.setSource, {
          src: buildDriveStreamUrl(track.id),
          title: track.title,
          artist: track.artist,
          headers: this.token
            ? { Authorization: `Bearer ${this.token}` }
            : undefined,
        });
      }
      if (seq !== this.playSeq) return;

      if (startTime !== undefined && startTime > 0) {
        await this.invokeStateful(PLUGIN_COMMAND.seekTo, {
          position: startTime,
        });
        if (seq !== this.playSeq) return;
      }
      await this.invokeStateful(PLUGIN_COMMAND.play);
    } finally {
      this.loadIntentActive = false;
    }
  }

  async pause(): Promise<void> {
    if (!IS_MOBILE) return;
    // An explicit pause is a user intent flip — close the load window first
    // so the native pause state syncs the store immediately (pause wins
    // instantly, even mid-buffer).
    this.loadIntentActive = false;
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

  /** Rapid seeks coalesce latest-wins on the shared playChain FIFO: older
   *  queued seeks are dropped when a newer one arrives, a seek waits for any
   *  running load chain instead of interleaving with set_source, and a
   *  rejected seek does not poison the queue for later commands. */
  async seek(time: number): Promise<void> {
    if (!IS_MOBILE) return;
    const seq = ++this.seekSeq;
    const turn = this.playChain.then(() => this.runSeekChain(seq, time));
    // Same anti-poison contract as playTrack: the failure still reaches THIS
    // call's caller (useSeekDrag recovery, media-session, seekRelative),
    // while later queued commands start settled.
    this.playChain = turn.catch(() => undefined);
    return turn;
  }

  /** One serialized seek turn — runs only after earlier chain turns settled.
   *  `seq` staleness is re-checked after the FIFO wait so a superseded seek
   *  is dropped entirely (latest-wins) instead of firing a stale seek_to. */
  private async runSeekChain(seq: number, time: number): Promise<void> {
    if (seq !== this.seekSeq) return;
    await this.initOnce().catch(() => undefined);
    if (seq !== this.seekSeq) return;
    // invokeStateful owns the error contract: classified log + rethrow to
    // this turn's caller (anti-poison lives in seek()'s queue wiring).
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
    // Media3's getBufferedPosition is a single end estimate (no per-range
    // detail), so expose exactly one segment spanning [0 → end] — the same
    // full-rail shape the UI renders from (bufferedRange computes the range
    // from 0, the position fill covers everything before the playhead;
    // Spotify/YouTube pattern). Never report [currentTime → X]: that would
    // leave the pre-playhead strip unstyled on the rail.
    const duration = this.lastState?.duration ?? 0;
    const rawEnd = this.lastState?.bufferedPosition ?? 0;
    // Clamp into [0, duration] and require a positive end: Media3 can return
    // 0 (nothing buffered / no estimate yet) and a stale snapshot may carry
    // an end past the track duration.
    const safeEnd = Math.min(Math.max(rawEnd, 0), duration);
    return {
      duration,
      currentTime: this.lastState?.currentTime ?? 0,
      buffered:
        safeEnd > 0 ? makeSingleSegmentBuffered(safeEnd) : emptyBuffered(),
    };
  }

  /** Logout / player-stop: stop playback and drop the token + track binding.
   *  The plugin's foreground service is stopped by the OS once playback
   *  pauses and the notification is dismissed. */
  async release(): Promise<void> {
    // Invalidate every queued/suspended play chain (latest-wins generation
    // bump): runPlayChain re-checks seq after each await, so no chain may
    // set_source/seek/play past a release (logout/stop) — same meaning as
    // usePlayer handleStop's abort guards (7484592). playTrack keeps working:
    // it assigns itself a fresh, newer seq. Seeks now ride the same queue, so
    // their generation is invalidated too: a queued user seek must not fire
    // seek_to on a released (stopped) player.
    this.playSeq++;
    this.seekSeq++;
    this.currentTrackId = null;
    this.currentTrack = null;
    // The mirror is dead state once the player stops: a late native snapshot
    // carrying an old mediaId must not resurrect a track into the store.
    this.queueMirror = [];
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
      // Isolate each listener so one throwing subscriber cannot block the
      // rest (Node EventEmitter / DOM dispatchEvent semantics). Snapshot
      // guards against unsubscribe-during-emit shifting the live array.
      for (const handler of [...handlers]) {
        try {
          handler(payload);
        } catch (err: unknown) {
          void captureError({
            level: "warn",
            source: "nativeAudioBridge",
            message: `emit ${event} handler failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  }

  // set_source performs the network load + container prepare (the one
  // legitimately slow command); every other command is fast local IPC.
  // set_queue is the queue flavour of set_source (same full playlist load +
  // container prepare) — it gets the same large budget.
  private invokeBudgetMs(command: string): number {
    return command === PLUGIN_COMMAND.setSource ||
      command === PLUGIN_COMMAND.setQueue
      ? SET_SOURCE_INVOKE_TIMEOUT_MS
      : TRANSPORT_INVOKE_TIMEOUT_MS;
  }

  private async invokeStateful(
    command: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const state = await invokeWithTimeout(
        invoke<NativeAudioState | undefined>(command, payload),
        this.invokeBudgetMs(command),
        command,
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
   *  desktop UI layer (PlayerBar/SeekBar/session save) behaves identically.
   *  The mapping itself lives in the pure NativeStateMapper; this method
   *  keeps only the engine-side bookkeeping (prev/lastState + the native
   *  auto-advance mediaId sync) and fans the mapper's queued events out. */
  private onNativeState(state: NativeAudioState): void {
    const prev = this.lastState;
    this.lastState = state;

    // Native auto-advance sync (BEFORE every status branch): with a queue
    // loaded, ExoPlayer moves to the next item on its own and reports it via
    // mediaId. Adopt the matching mirror track into the engine + store so
    // the UI and session save track the real playing item. PlayerBar's
    // effect then fires playTrack(next), which the same-track fast path
    // turns into a harmless no-op play() invoke. The status here is
    // playing/loading (NOT ended), so the JS auto-advance naturally stays
    // idle — no double-advance. "ended" (queue exhausted in normal mode)
    // still flows through the branches below untouched.
    const mediaId = state.mediaId;
    if (mediaId && mediaId !== this.currentTrack?.id) {
      const next = this.queueMirror.find((t) => t.id === mediaId);
      if (next) {
        this.currentTrack = next;
        this.currentTrackId = next.id;
        usePlayerStore.getState().setCurrentTrack(next);
      }
    }

    const result = this.mapper.apply(prev, state, {
      loadIntentActive: this.loadIntentActive,
      currentTrackStreamUnplayable:
        this.currentTrack?.streamUnplayable ?? false,
      onStorePlaying: (playing) => {
        usePlayerStore.getState().setIsPlaying(playing);
      },
    });
    for (const item of result.emit) {
      // Per-variant switch: each case narrows the discriminated pair so the
      // event key and its payload stay correlated — a fully typed fan-out,
      // no casts. Push order in the mapper IS the emit order here.
      switch (item.event) {
        case "error":
          this.emit("error", item.payload);
          break;
        case "ended":
          this.emit("ended", item.payload);
          break;
        case "buffering":
          this.emit("buffering", item.payload);
          break;
        case "play":
          this.emit("play", item.payload);
          break;
        case "pause":
          this.emit("pause", item.payload);
          break;
        case "durationchange":
          this.emit("durationchange", item.payload);
          break;
        case "progress":
          this.emit("progress", item.payload);
          break;
        case "timeupdate":
          this.emit("timeupdate", item.payload);
          break;
      }
    }
  }
}

export const nativeAudioEngine = new NativeAudioEngine();
