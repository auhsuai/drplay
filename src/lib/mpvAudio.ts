import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Track } from "../types";
import { captureError } from "../utils/errorLog";
import { usePlayerStore } from "../store/playerStore";
import type { BufferedSource } from "../utils/bufferedRange";
import type {
  AudioEventIdentity,
  AudioEventMap,
  AudioEventHandler,
} from "./audioNativeEvents";
import {
  asBoolean,
  asNumber,
  asString,
  BufferingTracker,
  classifyEndFileError,
  describeError,
  dispatchMpvEvent,
  dispatchPropertyEvent,
  extractCacheRanges,
  freshThrottleClocks,
  isRecord,
  LOADFILE_DEADLINE_MS,
  LOADFILE_RESTART_MAX_ATTEMPTS,
  LOADFILE_RESTART_TIMEOUT_MS,
  maxRangeEnd,
  MPV_BOOL,
  MPV_COMMANDS,
  MPV_PROPERTY_ARGS,
  MPV_PROPERTIES,
  PROXY_ORIGIN,
  PROXY_START_TIMEOUT_MS,
  SEEK_ACK_TIMEOUT_MS,
  SEEK_ACK_TOLERANCE_SECS,
  StallReconciler,
  STALL_MIN_RESUME_SECS,
  STREAM_PATH,
  TAURI_COMMANDS,
  TAURI_EVENTS,
  THROTTLE_MS,
  TimePosWatchdog,
  toTimeRanges,
  VOLUME_SCALE,
  withStallQueryTimeout,
  type MpvEventCallbacks,
  type MpvRange,
  type StallTruth,
} from "./mpvProtocol";
import { TimeInterpolator } from "./timeInterpolator";
import { TimerRegistry } from "./timerRegistry";

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
  // Why (Fix B3): stale-event identity across a loadfile — Rust tags every
  // mpv-property/mpv-event with the load-epoch of the sidecar connection it
  // was dispatched under, and every `mpv_command` reply carries the current
  // tag (`load_epoch`). Events below the latest loadfile reply's epoch belong
  // to the previous track and must not drive the new one.
  private engineEpoch = 0;
  // Why (R2.2): the epoch counter is per connection — a fresh sidecar restarts
  // it at 0 (Fix B3), so an in-flight event of the REPLACED connection can sit
  // above the new base and pass the epoch filter (B1), and release() resetting
  // the base to 0 lets late events drive a torn-down engine (RC-1). Rust mints
  // a process-wide monotonic `conn` per connection and tags every event with
  // it; the engine adopts it from the `mpv_spawn` reply and drops every event
  // of another connection. `null` = no live connection (pre-spawn / released).
  private engineConn: number | null = null;
  /** Shared in-flight spawn attempt — concurrent playTrack calls join it. */
  private startPromise: Promise<boolean> | null = null;
  /** Shared in-flight sidecar swap of a load-deadline restart (F8-1): every
   *  new load request parks on it (ensureStarted) instead of issuing a
   *  loadfile into the dying process. */
  private restartInFlight: Promise<void> | null = null;
  /** Monotonic id of the latest load request that supersedes the current
   *  playback (a track switch, never a same-track no-op/resume click). A
   *  deadline restart captured the id it belongs to and must never reload a
   *  superseded track over the newcomer (F8-1). */
  private loadRequestSeq = 0;
  /** Why (R2.1): engine load identity paired with `currentTrackId` at
   *  beginTrack — every load the engine begins (switch, retry, deadline
   *  restart) mints a new attempt, so consumers can tell an event of a
   *  previous load from the current one even on the same track id. Distinct
   *  from `loadRequestSeq` (supersede tracking, F8-1) and from the
   *  intent-level attemptId of RC-1/R3.1. Monotonic; never reset. */
  private loadAttemptSeq = 0;
  private proxyPort: number | null = null;
  /** Latest `stream-proxy-error` for the current stream (R05) — state only,
   *  never a display channel: mpv's end-file is the single place an error
   *  surfaces (the two events describe the same failure — dedupe). */
  private lastProxyError: { fileId: string; status: number } | null = null;
  private lastTrack: Track | null = null;
  private currentTrackId: string | null = null;
  private playbackFinished = true;
  private paused = false;
  // Why (F5-6/F8-2): pause() is fire-and-forget and no-ops before beginTrack,
  // so a pause requested inside the load window (or before a deadline sidecar
  // restart) would leave no trace — beginTrack then forced mpv back to play
  // and the pause=false push dragged the store to playing. This latch records
  // "the user asked to pause" until an explicit play request supersedes it.
  // The store is deliberately NOT the source: playbackFailure/end-file set
  // isPlaying=false with no user pause, and a retry (retryCurrentTrack) must
  // still start playing, not resume pinned.
  private pauseIntent = false;
  // Why (F8-6): a crash mid-loadfile fires BOTH onEngineClosed and the
  // command-rejection catch — this latch keeps a single terminal failure
  // surface (error/log/store) per load attempt. Reset at every new attempt
  // (playTrack entry / a deadline restart / beginTrack) and on release.
  private failureSurfacedForAttempt = false;
  private currentTime = 0;
  private duration = 0;
  private cacheRanges: MpvRange[] = [];
  private pendingSeek: number | null = null;
  // Why (S1): mpv's time-pos push chain + watchdog polls can still carry
  // pre-seek values in flight. Until a report lands within tolerance of the
  // requested target, every time-pos is either stale or unacknowledged.
  private seekTarget: number | null = null;
  private seekFailsafe: ReturnType<typeof setTimeout> | null = null;
  /** `file-loaded` deadline for the load in flight (H1: a wedged chain never
   *  emits it) — see armLoadDeadline. */
  private loadDeadline: ReturnType<typeof setTimeout> | null = null;
  /** Sidecar restarts spent on the current load (bounded by
   *  LOADFILE_RESTART_MAX_ATTEMPTS, reset per user/UI load attempt). */
  private loadRestarts = 0;
  private volume = 1;
  private muted = false;
  private throttle = freshThrottleClocks();
  // Why: guards the once-per-track `first-audio` emit so interpolated
  // timeupdates (which bypass onTimeUpdate) can never fake it.
  private firstAudioEmitted = false;
  // Why (R1.5): one registry owns every playback timer (engine arms + the 3
  // machines + the interpolator) so `release()` can assert an empty registry
  // instead of trusting five scattered clear sites.
  private timers = new TimerRegistry();
  private buffering = new BufferingTracker((isBuffering) => {
    this.emit("buffering", { isBuffering });
  }, this.timers);
  private watchdog = new TimePosWatchdog(
    () => usePlayerStore.getState().isPlaying,
    () =>
      invoke(TAURI_COMMANDS.mpvGetProperty, { prop: MPV_PROPERTIES.timePos }),
    (time) => {
      this.events.onTimeUpdate(time);
    },
    this.timers,
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
    this.timers,
  );
  /**
   * Pinned-playhead self-heal (mpv can freeze time-pos with no end-file/error
   * ever arriving — the clock stops with zero logs and only an app restart
   * used to cure it): poll the truth while progress is silent, settle a
   * spinner whose paused-for-cache=false was lost, reload the stream after a
   * bounded pin, then surface a bounded error the user can retry.
   */
  private reconciler = new StallReconciler(
    {
      isActive: () =>
        usePlayerStore.getState().isPlaying &&
        !this.paused &&
        !this.playbackFinished,
      isBusy: () => this.seekTarget !== null,
      queryTruth: () => this.queryStallTruth(),
      onReconcileBuffering: (buffering) => {
        this.buffering.reportMpvBuffering(buffering);
      },
      onStallRecover: (pinnedTime, attempt) => {
        this.recoverFromStall(pinnedTime, attempt);
      },
      onStallExhausted: () => {
        this.handleStallExhausted();
      },
    },
    this.timers,
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
      this.reconciler.noteTick(time);
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
      // Why (R3): mpv's `pause` is process-global — an observe push can arrive
      // with no track loaded (spawn), after end-file, or between tracks. Only
      // an active track may drive the store or arm timers; this.paused above
      // still records the engine truth unconditionally.
      const active = this.currentTrackId !== null && !this.playbackFinished;
      if (paused) {
        // Stop unconditionally (idempotent): a stray pause=true must never
        // leave orphan timers behind, even for an inactive engine.
        // Drop the base: elapsed wall time during the pause must never drift
        // into the interpolation when playback resumes.
        this.interpolator.reset();
        this.watchdog.stop();
        this.reconciler.stop();
        if (!active) return;
        this.emit("pause", undefined);
        usePlayerStore.getState().setIsPlaying(false);
      } else {
        if (!active) return;
        // v3: pause=false no longer settles the spinner (S3/S4) — it also
        // follows a switch-while-paused clearing mpv's global flag, proving
        // nothing about audio flow. Truth settles via ticks/end-file/mpv.
        this.emit("play", undefined);
        usePlayerStore.getState().setIsPlaying(true);
        this.watchdog.start();
        this.reconciler.start();
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
      // The load completed: the wedged-chain deadline no longer applies.
      this.clearLoadDeadline();
      this.applyPendingSeek();
      // Why: mpv's pause flag does not change across a loadfile replace, so
      // track N>1 never gets a pause=false event — file-loaded is the moment
      // the backfill watchdog and the stall reconciler must be (re)armed.
      this.watchdog.start();
      this.reconciler.start();
    },
    onEndFile: (outcome, mpvError) => {
      this.playbackFinished = true;
      this.clearLoadDeadline();
      this.interpolator.reset();
      // Why (S4): the track is terminal — no more ticks can confirm progress,
      // so the spinner must not ride the 8s safety net (eof and error alike).
      this.buffering.settle();
      this.watchdog.stop();
      this.reconciler.stop();
      if (outcome === "eof") {
        this.emit("ended", undefined);
        return;
      }
      const proxyStatus = this.proxyStatusForCurrentStream();
      if (classifyEndFileError(mpvError, proxyStatus) === "network") {
        // Why (R02-1): a transport failure is retryable — do NOT mark the
        // track broken and do NOT auto-advance (same surface as a failed
        // command), unlike the terminal format_error path below.
        this.playbackFailure("end-file-network-error", mpvError);
        return;
      }
      this.emitEndFileError();
    },
    onEngineClosed: (cause) => {
      // Why (R02-2): mpv died without an end-file — nothing else tells the
      // engine; reset lifecycle so the next playTrack respawns via mpv_spawn.
      this.logError(`mpv engine closed: ${cause}`);
      this.started = false;
      // R2.2: the connection is gone — any further event tagged with its id is
      // late by definition and must not drive the engine.
      this.engineConn = null;
      this.clearLoadDeadline();
      this.detachListeners(this.unlistenFns);
      this.unlistenFns = [];
      this.playbackFinished = true;
      this.watchdog.stop();
      this.reconciler.stop();
      this.interpolator.reset();
      // playbackFailure dedupes (F8-6): if the command-rejection catch
      // surfaced this same crash already, this call is the no-op duplicate.
      this.playbackFailure("mpv-engine-closed", cause);
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

  /** Identity attached to every emitted event (R2.1). `trackIdOverride`
   *  attributes an event to a load target the engine has not begun yet (a
   *  failed new load); such an event carries no attempt — no engine load
   *  identity exists for it. A missing current track yields `{}` so the
   *  event stays untagged and consumers keep legacy behavior. */
  private eventIdentity(trackIdOverride?: string): AudioEventIdentity {
    const trackId = trackIdOverride ?? this.currentTrackId;
    if (trackId === null) return {};
    return trackId === this.currentTrackId
      ? { trackId, attempt: this.loadAttemptSeq }
      : { trackId };
  }

  private emit<K extends keyof AudioEventMap>(
    event: K,
    payload: AudioEventMap[K],
    trackIdOverride?: string,
  ) {
    const handlers = this.listeners[event];
    if (handlers) {
      // Tag every payload with the engine identity (R2.1). Spread keeps the
      // event's own fields authoritative and tolerates `undefined` payloads.
      const tagged = {
        ...this.eventIdentity(trackIdOverride),
        ...(payload as object | undefined),
      } as AudioEventMap[K];
      handlers.forEach((h) => {
        h(tagged);
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

  /** Record one `stream-proxy-error` payload (R05): status memory only. */
  private noteProxyError(payload: unknown): void {
    if (!isRecord(payload)) {
      this.logWarn("stream-proxy-error payload malformed (skipped)");
      return;
    }
    const fileId = asString(payload["fileId"]);
    const status = asNumber(payload["status"]);
    if (fileId === null || status === null) {
      this.logWarn("stream-proxy-error payload malformed (skipped)");
      return;
    }
    this.lastProxyError = { fileId, status };
  }

  /** The proxy status usable for THIS stream only — a stale event (other
   *  fileId, previous stream) must never steer end-file classification. */
  private proxyStatusForCurrentStream(): number | null {
    const error = this.lastProxyError;
    if (error === null || error.fileId !== this.currentTrackId) return null;
    return error.status;
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

  private async sendCommand(cmd: string[]): Promise<unknown> {
    return invoke(TAURI_COMMANDS.mpvCommand, { cmd });
  }

  /** True when a tagged event payload cannot drive THIS engine (Fix B3 +
   *  R2.2): its connection is not the live one, or it predates the latest
   *  loadfile reply. Robust by contract: a payload missing the tag passes, so
   *  an older sender stays compatible. */
  private isStaleEnginePayload(payload: unknown): boolean {
    if (!isRecord(payload)) return false;
    const conn = payload["conn"];
    if (
      typeof conn === "number" &&
      (this.engineConn === null || conn !== this.engineConn)
    ) {
      // A tagged event of a replaced (or absent) connection: its epoch base
      // was reset by the respawn/release, so it must never drive this engine.
      return true;
    }
    const epoch = payload["epoch"];
    return typeof epoch === "number" && epoch < this.engineEpoch;
  }

  /** Adopt the connection identity of an `mpv_spawn` reply (R2.2). Idempotent
   *  for the spawn no-op path (running sidecar answers with its own id); a
   *  malformed/legacy reply without a numeric `conn` is a no-op. */
  private noteSpawnReply(reply: unknown): void {
    if (!isRecord(reply)) return;
    const conn = reply["conn"];
    if (typeof conn === "number") this.engineConn = conn;
  }

  /** Adopt the load epoch of a `loadfile` reply (Rust returns
   *  `{ data, load_epoch }` for every `mpv_command`). Monotonic — a lower tag
   *  never lowers the base; a missing/malformed tag is a no-op. */
  private noteLoadEpoch(reply: unknown): void {
    if (!isRecord(reply)) return;
    const epoch = reply["load_epoch"];
    if (typeof epoch !== "number") return;
    this.engineEpoch = Math.max(this.engineEpoch, epoch);
  }

  private detachListeners(fns: UnlistenFn[]): void {
    for (const fn of fns) {
      try {
        // Why (B6): runtime unlisten returns a promise despite UnlistenFn's
        // `() => void` signature — without this handler a rejection would
        // surface as an unhandled rejection during teardown.
        const call = fn as () => Promise<unknown> | undefined;
        void Promise.resolve(call()).catch((e: unknown) => {
          this.logWarn(`unlisten-failed: ${describeError(e)}`);
        });
      } catch (e: unknown) {
        this.logWarn(`unlisten-failed: ${describeError(e)}`);
      }
    }
  }

  private async ensureStarted(epoch: number): Promise<boolean> {
    // Why (F8-1): a load-deadline restart swaps the sidecar internally — the
    // old mpv is going away and its replacement is not up yet, so issuing a
    // loadfile now would race a dying process (and the restart's own reload
    // would then clobber the newcomer). Park the request until the swap
    // settles; `started` deliberately stays true across it. A failed swap
    // resolves the wait and lets the request surface its own bounded failure.
    if (this.restartInFlight) {
      try {
        await this.restartInFlight;
      } catch {
        // onLoadDeadline owns the swap's single failure surface (F8-6 dedupe).
      }
      // Release during the wait: this request belongs to a torn-down
      // lifecycle — it must not boot a fresh engine (no resurrection).
      if (this.isStale(epoch)) return false;
    }
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
          if (this.isStaleEnginePayload(event.payload)) return;
          dispatchPropertyEvent(event.payload, this.events);
        }),
      );
      if (this.isStale(epoch)) return this.disposeStaleStart(attached);
      attached.push(
        await listen(TAURI_EVENTS.event, (event) => {
          if (this.isStaleEnginePayload(event.payload)) return;
          dispatchMpvEvent(event.payload, this.events);
        }),
      );
      if (this.isStale(epoch)) return this.disposeStaleStart(attached);
      attached.push(
        await listen(TAURI_EVENTS.streamProxyError, (event) => {
          this.noteProxyError(event.payload);
        }),
      );
      if (this.isStale(epoch)) return this.disposeStaleStart(attached);
      const reply = await invoke(TAURI_COMMANDS.mpvSpawn);
      if (this.isStale(epoch)) return this.disposeStaleStart(attached);
      // Fix B3: a fresh sidecar's load epoch restarts at 0 (the Rust counter
      // is per connection) — adopting that base keeps its events from being
      // dropped below a previous track's epoch after a crash respawn.
      this.engineEpoch = 0;
      // R2.2: adopt the new connection's identity so its events — and only
      // its — are accepted from here on.
      this.noteSpawnReply(reply);
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

  /** Why (F8-1): true when a load-deadline's load was superseded while the
   *  restart awaited — released, a newer track request, or a terminal outcome.
   *  A method (not inline field reads) so TypeScript's flow narrowing cannot
   *  freeze the fields across the restart's awaits. */
  private deadlineSuperseded(
    epoch: number,
    trackId: string,
    seq: number,
  ): boolean {
    return (
      this.isStale(epoch) ||
      this.playbackFinished ||
      this.currentTrackId !== trackId ||
      this.loadRequestSeq !== seq
    );
  }

  private async ensureProxyPort(): Promise<number> {
    if (this.proxyPort === null) {
      // Why (D8): a hung stream_proxy_start reply must not hold the playback
      // attempt open forever. The timeout throws before the assignment, so
      // proxyPort stays null — the next attempt re-invokes (Rust side is
      // idempotent) and a late reply can never write a stale port.
      this.proxyPort = await withStallQueryTimeout(
        invoke<number>(TAURI_COMMANDS.streamProxyStart),
        PROXY_START_TIMEOUT_MS,
      );
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
    this.loadAttemptSeq += 1;
    this.playbackFinished = false;
    // A live track starts its own failure scope (F8-6).
    this.failureSurfacedForAttempt = false;
    // A new stream resets the proxy-error signal: an event from the previous
    // track must never classify THIS track's end-file (R05).
    this.lastProxyError = null;
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
    // Fresh track, fresh stall window: drop the previous track's baselines
    // and its (possibly spent) recovery budget.
    this.reconciler.reset();
    // Why (R2): stop() bumps the watchdog generation, so a poll of the
    // PREVIOUS track already awaiting its IPC reply can never land on this
    // one (onFileLoaded re-arms for the new track).
    this.watchdog.stop();
    this.clearLoadDeadline();
    this.armLoadDeadline(track.id);
    // Why (R4): the buffering session state (sticky stall flag, tick
    // baselines, safety net) belongs to the previous track — the new track
    // must start clean instead of inheriting a spinner it cannot settle.
    this.buffering.resetForTrack();
    // mpv's pause flag is process-global and a loadfile never resets it: a
    // switch made while mpv is paused would start the new track frozen, and a
    // lost `pause` push (the property-push class TimePosWatchdog covers) meant
    // the cached flag below never learned the real state — the new track then
    // stayed silent while the app believed it played. Clear the flag for a
    // newly loaded track — EXCEPT when the user paused inside the load window
    // or before a deadline sidecar restart: that intent is consumed here, so
    // the reload comes up pinned instead of erasing the pause (F5-6/F8-2).
    const keepPaused = this.pauseIntent;
    this.pauseIntent = false;
    this.paused = keepPaused;
    void this.sendCommand([
      MPV_COMMANDS.setProperty,
      MPV_PROPERTY_ARGS.pause,
      keepPaused ? MPV_BOOL.yes : MPV_BOOL.no,
    ]).catch((e: unknown) => {
      this.logWarn(`initial-pause-apply-failed: ${describeError(e)}`);
    });
  }

  private playbackFailure(
    where: string,
    e: unknown,
    trackIdOverride?: string,
  ): void {
    // Why (F8-6): one failure surface per attempt — a crash mid-loadfile
    // fires both onEngineClosed and the command-rejection catch, and only
    // the first may surface (log/error/store), whichever order they land in.
    if (this.failureSurfacedForAttempt) return;
    this.failureSurfacedForAttempt = true;
    // Why (F8-5): a failed load/command is terminal — without this flag a
    // later playTrack of the same track took the same-track resume branch
    // (no-op, or a resume command into the same broken engine) instead of
    // reloading. All other callers set it before surfacing already.
    this.playbackFinished = true;
    this.logError(`${where}: ${describeError(e)}`);
    // Why (S4): a failed command means no ticks will ever confirm progress —
    // never leave the spinner hanging on a dead path.
    this.buffering.settle();
    this.emit(
      "error",
      {
        message: "Không phát được bài hát này, hãy thử lại.",
        code: "network_interrupted",
      },
      trackIdOverride,
    );
    usePlayerStore.getState().setIsPlaying(false);
  }

  public async playTrack(track: Track, startTime?: number): Promise<void> {
    const epoch = this.lifecycleEpoch;
    // Any explicit play request supersedes a pending pause intent — including
    // a retry after a failure, where the store is false without a user pause.
    this.pauseIntent = false;
    // A fresh attempt owns a fresh failure surface (F8-6).
    this.failureSurfacedForAttempt = false;
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
      // Why (F8-1): only a request that actually changes the track supersedes
      // an in-flight deadline restart of the previous one. Same-track
      // no-op/resume clicks deliberately do not bump: the restart's reload is
      // still the cure for the track they refer to.
      this.loadRequestSeq += 1;
      if (!(await this.ensureStarted(epoch))) return;
      // Why: release() mid-start must abort silently — no loadfile into a
      // shutdown mpv and no state resurrection after the teardown.
      if (this.isStale(epoch)) return;
      // A user/UI load attempt owns a fresh sidecar-restart budget (the
      // restart-reload below must NOT reset its own budget).
      this.loadRestarts = 0;
      await this.loadTrack(track, startTime, epoch);
    } catch (e: unknown) {
      // Why: a command failing because release() tore the engine down is not
      // a playback failure — release paths are deliberately silent.
      if (this.isStale(epoch)) return;
      // Why (R2.1): this failure is ABOUT the requested track, which the
      // engine may not have begun yet (loadfile/command rejected) — attribute
      // it to that target so a track-switch failure still surfaces on it.
      this.playbackFailure("play-track-failed", e, track.id);
    }
  }

  /** Issue one `loadfile replace` for a track and begin its per-track
   *  bookkeeping (spinner, pause flag, load deadline). Shared by the user
   *  load path and the load-deadline sidecar restart. */
  private async loadTrack(
    track: Track,
    startTime: number | undefined,
    epoch: number,
    requestSeq?: number,
  ): Promise<void> {
    const port = await this.ensureProxyPort();
    if (this.isStale(epoch)) return;
    const reply = await this.sendCommand([
      MPV_COMMANDS.loadfile,
      this.streamUrl(track.id, port),
      MPV_COMMANDS.replace,
    ]);
    this.noteLoadEpoch(reply);
    if (this.isStale(epoch)) return;
    // Why (F8-1): a deadline restart's reload must not begin the stale track
    // if a newer load request landed while the loadfile reply was in flight —
    // the loadfile itself predates the switch, but the newcomer owns the
    // engine state and must not be superseded by beginTrack(track).
    if (requestSeq !== undefined && this.loadRequestSeq !== requestSeq) return;
    this.beginTrack(track, startTime);
    // v3 (S2): a new track promotes the spinner immediately — waiting for
    // the 250ms display delay left a no-source gap between first-audio and
    // the promote (the button flashed the Pause icon mid-load).
    this.buffering.request(true);
  }

  public togglePlay(): void {
    if (!this.lastTrack) return;
    if (this.playbackFinished) {
      // Mirror HTMLMediaElement.play() on an ended element: restart from top.
      void this.playTrack(this.lastTrack);
      return;
    }
    const resuming = this.paused;
    // Keep the latch in step with the command sent: a toggle that pauses is a
    // pause intent for the next load, a resume supersedes an older one.
    this.pauseIntent = !resuming;
    void this.sendCommand([
      MPV_COMMANDS.setProperty,
      MPV_PROPERTY_ARGS.pause,
      resuming ? MPV_BOOL.no : MPV_BOOL.yes,
    ]).catch((e: unknown) => {
      this.logWarn(`toggle-play-failed: ${describeError(e)}`);
    });
  }

  public pause(): void {
    // Record the intent BEFORE the no-op guards: in the load window there is
    // no track yet, so the request has nowhere to land until beginTrack —
    // dropping it here is exactly how the user's pause was swallowed (F5-6).
    this.pauseIntent = true;
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

  /** Live playback timers (R1.5) — 0 after release(), by invariant. */
  public activeTimerCount(): number {
    return this.timers.activeTimerCount();
  }

  /** Names of the live playback timers, for tests/diagnostics (R1.5). */
  public activeTimerNames(): string[] {
    return this.timers.activeTimerNames();
  }

  public release(): void {
    // Why: bump FIRST so every in-flight continuation (listener attach, spawn,
    // loadfile) observes the teardown at its next await boundary and aborts.
    this.lifecycleEpoch += 1;
    this.startPromise = null;
    this.restartInFlight = null;
    this.detachListeners(this.unlistenFns);
    this.unlistenFns = [];
    this.started = false;
    // Fix B3: a torn-down sidecar owns no epoch — the next spawn starts fresh.
    this.engineEpoch = 0;
    // R2.2: and no connection — late events of the torn-down sidecar (already
    // queued in the bridge) must not revive timers/state (RC-1).
    this.engineConn = null;
    this.proxyPort = null;
    this.lastProxyError = null;
    this.lastTrack = null;
    this.currentTrackId = null;
    this.playbackFinished = true;
    this.paused = false;
    this.pauseIntent = false;
    this.failureSurfacedForAttempt = false;
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
    // Stop first (kills the interval), then a clean slate for the next engine.
    this.reconciler.stop();
    this.reconciler.reset();
    this.clearLoadDeadline();
    this.loadRestarts = 0;
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
    this.seekFailsafe = this.timers.setTimeout(
      "seek-failsafe",
      () => {
        this.seekFailsafe = null;
        this.seekTarget = null;
      },
      SEEK_ACK_TIMEOUT_MS,
    );
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
      this.timers.clearTimeout(this.seekFailsafe);
      this.seekFailsafe = null;
    }
  }

  private applyPendingSeek(): void {
    if (this.pendingSeek === null) return;
    const target = this.pendingSeek;
    this.pendingSeek = null;
    this.sendSeek(target);
  }

  /** Single source of truth for a track's local stream-proxy URL. */
  private streamUrl(trackId: string, port: number): string {
    return `${PROXY_ORIGIN}:${String(port)}${STREAM_PATH}${trackId}`;
  }

  /** Polled mpv truth for one reconcile round (each query bounded). */
  private async queryStallTruth(): Promise<StallTruth> {
    const [timePosRaw, bufferingRaw, cacheRaw] = await Promise.all([
      withStallQueryTimeout(
        invoke(TAURI_COMMANDS.mpvGetProperty, { prop: MPV_PROPERTIES.timePos }),
      ),
      withStallQueryTimeout(
        invoke(TAURI_COMMANDS.mpvGetProperty, {
          prop: MPV_PROPERTIES.pausedForCache,
        }),
      ),
      withStallQueryTimeout(
        invoke(TAURI_COMMANDS.mpvGetProperty, {
          prop: MPV_PROPERTIES.cacheState,
        }),
      ),
    ]);
    return {
      timePos: asNumber(timePosRaw),
      buffering: asBoolean(bufferingRaw),
      cacheEnd: maxRangeEnd(extractCacheRanges(cacheRaw)),
    };
  }

  /** Stall self-heal step 1: reload the stream at the pinned position. */
  private recoverFromStall(pinnedTime: number, attempt: number): void {
    const trackId = this.currentTrackId;
    const port = this.proxyPort;
    if (trackId === null || port === null) {
      this.logWarn(
        `stall-recovery attempt=${String(attempt)} skipped: no active stream`,
      );
      return;
    }
    this.logWarn(
      `stall-recovery attempt=${String(attempt)} pinned=${pinnedTime.toFixed(1)}s`,
    );
    // Why: resume at the pinned position once the reloaded file reports ready
    // — the existing file-loaded -> applyPendingSeek path does the seek.
    this.pendingSeek = pinnedTime > STALL_MIN_RESUME_SECS ? pinnedTime : null;
    void this.sendCommand([
      MPV_COMMANDS.loadfile,
      this.streamUrl(trackId, port),
      MPV_COMMANDS.replace,
    ])
      .then((reply) => {
        this.noteLoadEpoch(reply);
      })
      .catch((e: unknown) => {
        // Why: a failed reload consumes this attempt only — the next reconcile
        // window still runs and the exhausted path is the single error surface.
        this.logWarn(`stall-recovery-reload-failed: ${describeError(e)}`);
      });
    // Keep the spinner up across the reload window.
    this.buffering.request(true);
  }

  /** Stall self-heal step 2: budget spent — bounded error, replayable track. */
  private handleStallExhausted(): void {
    this.failTerminal(
      "stall-recovery-exhausted",
      "playhead pinned; reload failed",
    );
  }

  /** Terminal playback failure: no ticks can confirm progress anymore — stop
   *  the self-heal machinery, then surface the bounded error + play state. */
  private failTerminal(where: string, detail: unknown): void {
    // Why these flags: playbackFailure surfaces `network_interrupted` and
    // flips isPlaying off; playbackFinished=true is what routes a later
    // playTrack(same track) through the full reload path (mpvAudio guard).
    this.playbackFinished = true;
    this.clearLoadDeadline();
    this.interpolator.reset();
    this.watchdog.stop();
    this.reconciler.stop();
    this.playbackFailure(where, detail);
  }

  /** Arm the `file-loaded` deadline for the load just issued. H1 (2026-09-17
   *  freeze report): mpv can wedge its playback chain after `loadfile
   *  replace` — no `file-loaded`, no `end-file`, no error, pipe alive, the
   *  demuxer still downloading. Nothing in the IPC contract reports it, so
   *  the engine treats "no file-loaded within the deadline" as a wedged
   *  chain and restarts the sidecar (the only proven cure). */
  private armLoadDeadline(trackId: string): void {
    this.clearLoadDeadline();
    const epoch = this.lifecycleEpoch;
    this.loadDeadline = this.timers.setTimeout(
      "load-deadline",
      () => {
        this.loadDeadline = null;
        void this.onLoadDeadline(trackId, epoch);
      },
      LOADFILE_DEADLINE_MS,
    );
  }

  private clearLoadDeadline(): void {
    if (this.loadDeadline !== null) {
      this.timers.clearTimeout(this.loadDeadline);
      this.loadDeadline = null;
    }
  }

  /** One load-deadline sidecar swap (F8-1): shutdown the wedged mpv, spawn
   *  the replacement, then re-base the per-connection state (Fix B3 epoch,
   *  facade volume). Shared through `restartInFlight` so concurrent load
   *  requests wait it out instead of racing a dying process. Each IPC call is
   *  bounded; a release mid-swap aborts at the next await boundary. */
  private async swapSidecar(epoch: number): Promise<void> {
    await withStallQueryTimeout(
      invoke(TAURI_COMMANDS.mpvShutdown),
      LOADFILE_RESTART_TIMEOUT_MS,
    );
    if (this.isStale(epoch)) return;
    const reply = await withStallQueryTimeout(
      invoke(TAURI_COMMANDS.mpvSpawn),
      LOADFILE_RESTART_TIMEOUT_MS,
    );
    if (this.isStale(epoch)) return;
    // Fix B3: the replacement sidecar's epoch counter restarts at 0 — a stale
    // engineEpoch would drop every event of whatever loads next.
    this.engineEpoch = 0;
    // R2.2: the replacement is a new connection — the old id's events (its
    // epoch base reset above) must never pass again.
    this.noteSpawnReply(reply);
    // A fresh mpv starts at volume 100 — re-apply the facade volume.
    this.applyVolume();
  }

  private async onLoadDeadline(trackId: string, epoch: number): Promise<void> {
    // Stale (release/teardown) or superseded (another track loading, or a
    // terminal outcome already decided): this deadline has nothing to cure.
    if (this.isStale(epoch)) return;
    if (this.currentTrackId !== trackId) return;
    if (this.playbackFinished) return;
    // The deadline restart is a fresh load sub-attempt: its own failure
    // surface (F8-6) — e.g. a restart whose reload rejects must still report.
    this.failureSurfacedForAttempt = false;
    if (this.loadRestarts >= LOADFILE_RESTART_MAX_ATTEMPTS) {
      this.failTerminal(
        "load-deadline-exhausted",
        `no file-loaded within ${String(LOADFILE_DEADLINE_MS)}ms after a sidecar restart`,
      );
      return;
    }
    this.loadRestarts += 1;
    this.logWarn(
      `load-deadline: no file-loaded for ${trackId} within ${String(LOADFILE_DEADLINE_MS)}ms — restarting the mpv sidecar (attempt ${String(this.loadRestarts)})`,
    );
    const track = this.lastTrack;
    if (track === null) return;
    // Why (F8-1): the load request this deadline belongs to. A newer request
    // must never be clobbered by the stale reload below.
    const seq = this.loadRequestSeq;
    const swap = this.swapSidecar(epoch);
    this.restartInFlight = swap;
    try {
      await swap;
      // Superseded while the sidecar swapped (user switched, release, or a
      // terminal outcome landed): the newer request owns playback and loads
      // through its own path on the fresh sidecar. Reloading the stale track
      // here is exactly the F8-1 clobber.
      if (this.deadlineSuperseded(epoch, trackId, seq)) return;
      // Why (F3-9): the wedged load never reached file-loaded, so its pending
      // resume position (the playTrack startTime) is still queued — replay it
      // after the recovery instead of restarting the track from the top.
      const resumeAt = this.pendingSeek;
      await this.loadTrack(track, resumeAt ?? undefined, epoch, seq);
    } catch (e: unknown) {
      if (this.isStale(epoch)) return;
      // Why (per 0/6): a failed restart or reload is terminal for this load —
      // surface the bounded error instead of retrying the sidecar forever.
      this.failTerminal("load-deadline-restart-failed", e);
    } finally {
      if (this.restartInFlight === swap) this.restartInFlight = null;
    }
  }
}
