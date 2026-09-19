/**
 * Playback state machines extracted from mpvProtocol.ts (structural split):
 * the display-delay BufferingTracker, the TimePosWatchdog push-gap backfill,
 * and the pinned-playhead StallReconciler. Timers arm through TimerRegistry;
 * engine state arrives via constructor callbacks. The Tauri/mpv wire contract
 * and the shared tuning constants stay in mpvProtocol.ts.
 */

import type { TimerRegistry } from "./timerRegistry";
import {
  asNumber,
  BUFFERING_TIMEOUT_MS,
  describeError,
  SPINNER_DELAY_MS,
  STALL_EPSILON_SECS,
  STALL_LOAD_GRACE_MS,
  STALL_POLL_INTERVAL_MS,
  STALL_RECONCILE_MS,
  STALL_RECOVER_MS,
  STALL_RECOVERY_MAX_ATTEMPTS,
  TICK_WINDOW_MS,
  truncateRaw,
  warnThrottled,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_STALE_MS,
} from "./mpvProtocol";

/**
 * Display-delay buffering tracker (Spotify/YT-Music spinner pattern) — v3.
 * Three states: idle -> pending (request armed, SPINNER_DELAY_MS timer
 * running) -> shown (spinner visible).
 * - request(true): a new track load (playTrack) — idle/pending promote
 *   IMMEDIATELY (emit true + arm the deadline) so the spinner covers the
 *   pre-audio window from the first frame. From shown it re-arms the net
 *   (dedupe: no re-emit).
 * - request(): seek — keeps the 250ms display delay (anti-flash when the
 *   seek target is already cached).
 * - settle(): playback confirmed — the 2nd time-pos tick with a CHANGED
 *   value within TICK_WINDOW_MS (a frozen value is not progress, mpv stalls
 *   keep time-pos pinned) or reportMpvBuffering(false) while shown.
 *   pause=false never settles: it follows a track switch made while paused
 *   (beginTrack clears mpv's process-global pause flag), proving nothing
 *   about audio flow (S3/S4). pending -> idle is SILENT (never showed, no
 *   emit — anti-flash); shown emits false once.
 * - reportMpvBuffering(): mpv's genuine paused-for-cache signal. true
 *   sustained for SPINNER_DELAY_MS promotes pending/idle to shown
 *   immediately (skips the remaining display delay); while shown it
 *   re-arms the net. false cancels the sustain timer and settles a
 *   shown spinner (a false while pending is just mpv's observe report —
 *   ignored, otherwise it would kill the spinner before the first tick).
 *   v4: the last reported value is cached — while mpv says the playhead is
 *   pinned, ticks and the safety net may NOT settle (only report(false),
 *   terminal events or release() end a genuine stall).
 * - Safety net (BUFFERING_TIMEOUT_MS from the last request/report): shown
 *   auto-settles, EXCEPT while mpv reports paused-for-cache — then the net
 *   re-arms (a real stall is open-ended; a long buffer must keep spinning).
 *   A stuck pending force-promotes (defensive branch).
 * Emits ONLY on idle->shown / shown->idle transitions.
 * cancel() resets silently for release() — no emit on a torn-down engine,
 * and the dead mpv's stall flag dies with it.
 */
export class BufferingTracker {
  private state: "idle" | "pending" | "shown" = "idle";
  private displayTimer: ReturnType<typeof setTimeout> | null = null;
  private sustainTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickAt: number | null = null;
  private lastTickValue: number | null = null;
  /** Last paused-for-cache value mpv reported (v4 spin-hold gate). */
  private mpvBuffering = false;
  private readonly emit: (isBuffering: boolean) => void;
  /** Optional (R1.5): register every arm/clear under a name + owner. */
  private readonly timers: TimerRegistry | null;

  constructor(emit: (isBuffering: boolean) => void, timers?: TimerRegistry) {
    this.emit = emit;
    this.timers = timers ?? null;
  }

  request(immediate = false): void {
    this.clearTimers();
    this.lastTickAt = null;
    this.lastTickValue = null;
    if (this.state === "shown") {
      this.rearmDeadline();
      return;
    }
    if (immediate) {
      this.promote();
      return;
    }
    this.state = "pending";
    this.displayTimer = this.setTimer(
      () => {
        this.displayTimer = null;
        this.promote();
      },
      SPINNER_DELAY_MS,
      "buffering-display",
    );
    this.rearmDeadline();
  }

  settle(): void {
    this.clearTimers();
    this.lastTickAt = null;
    this.lastTickValue = null;
    if (this.state === "shown") this.emit(false);
    this.state = "idle";
  }

  reportMpvBuffering(isBuffering: boolean): void {
    // Why (v4): cached because mpv's stall signal outranks time-pos pairing —
    // a changed tick while paused-for-cache is not proof that audio flows, and
    // letting it settle killed the spinner ~1s before the sound started.
    this.mpvBuffering = isBuffering;
    if (isBuffering) {
      if (this.state === "shown") {
        this.rearmDeadline();
        return;
      }
      if (this.sustainTimer === null) {
        this.sustainTimer = this.setTimer(
          () => {
            this.sustainTimer = null;
            this.promote();
          },
          SPINNER_DELAY_MS,
          "buffering-sustain",
        );
      }
      return;
    }
    this.clearSustainTimer();
    if (this.state === "shown") this.settle();
  }

  onTimeTick(value: number): void {
    if (this.state === "idle") return;
    // Why (v4): mpv reports paused-for-cache — the playhead is pinned, so a
    // changed time-pos cannot be confirmed progress (stale queued ticks used
    // to settle the spinner and un-gate the clock before audio flowed).
    if (this.mpvBuffering) return;
    // Why (S4): a frozen time-pos re-pushed (or re-sampled by the watchdog)
    // without change is NOT progress — only a CHANGED value can pair into
    // the 2-tick settle.
    if (this.lastTickValue !== null && value === this.lastTickValue) return;
    const now = Date.now();
    if (this.lastTickAt !== null && now - this.lastTickAt <= TICK_WINDOW_MS) {
      this.settle();
      return;
    }
    this.lastTickAt = now;
    this.lastTickValue = value;
  }

  /** True while the spinner is visible — the engine clock must freeze then. */
  isShown(): boolean {
    return this.state === "shown";
  }

  /** Track switch: silently drop the previous track's buffering session —
   *  timers, tick-pairing baseline and the cached stall flag all belong to
   *  that track. Never emits (unlike settle() there is no transition to
   *  report); the new track's own request() emits its state. */
  resetForTrack(): void {
    this.resetSession();
  }

  cancel(): void {
    // Why (v4): release() tears the mpv process down — its last
    // paused-for-cache report is dead state and must not suppress the next
    // engine's tick-settle.
    this.resetSession();
  }

  private resetSession(): void {
    this.clearTimers();
    this.lastTickAt = null;
    this.lastTickValue = null;
    this.state = "idle";
    this.mpvBuffering = false;
  }

  private promote(): void {
    if (this.state === "shown") return;
    this.state = "shown";
    this.emit(true);
    if (this.deadlineTimer === null) this.rearmDeadline();
  }

  private deadlineFire(): void {
    this.deadlineTimer = null;
    if (this.state === "shown") {
      // Why (v4): while mpv reports paused-for-cache the stall is real and
      // open-ended — re-arm instead of settling; a long buffer must not drop
      // the spinner mid-stall (report(false)/terminal/release still settle).
      if (this.mpvBuffering) {
        this.rearmDeadline();
        return;
      }
      this.settle();
      return;
    }
    if (this.state === "pending") this.promote();
  }

  private rearmDeadline(): void {
    this.clearTimer(this.deadlineTimer);
    this.deadlineTimer = this.setTimer(
      () => {
        this.deadlineTimer = null;
        this.deadlineFire();
      },
      BUFFERING_TIMEOUT_MS,
      "buffering-deadline",
    );
  }

  private clearTimers(): void {
    this.clearSustainTimer();
    this.clearTimer(this.displayTimer);
    this.displayTimer = null;
    this.clearTimer(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private clearSustainTimer(): void {
    this.clearTimer(this.sustainTimer);
    this.sustainTimer = null;
  }

  private setTimer(
    fn: () => void,
    ms: number,
    name: string,
  ): ReturnType<typeof setTimeout> {
    if (this.timers === null) return setTimeout(fn, ms);
    return this.timers.setTimeout(name, fn, ms);
  }

  private clearTimer(handle: ReturnType<typeof setTimeout> | null): void {
    if (handle === null) return;
    if (this.timers === null) clearTimeout(handle);
    else this.timers.clearTimeout(handle);
  }
}

/** Watchdog backfill for lost time-pos push chains (mpv #13695). */
export class TimePosWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private polling = false;
  /** Bumped by stop(): an in-flight poll compares it after its await. */
  private generation = 0;
  private readonly isPlaying: () => boolean;
  private readonly getTimePos: () => Promise<unknown>;
  private readonly onTimeUpdate: (time: number) => void;
  /** Optional (R1.5): register the interval under a name + owner. */
  private readonly timers: TimerRegistry | null;
  constructor(
    isPlaying: () => boolean,
    getTimePos: () => Promise<unknown>,
    onTimeUpdate: (time: number) => void,
    timers?: TimerRegistry,
  ) {
    this.isPlaying = isPlaying;
    this.getTimePos = getTimePos;
    this.onTimeUpdate = onTimeUpdate;
    this.timers = timers ?? null;
  }
  noteEmit(): void {
    this.lastTickAt = Date.now();
  }
  start(): void {
    if (this.timer !== null || !this.isPlaying()) return;
    this.lastTickAt = Date.now();
    this.timer =
      this.timers === null
        ? setInterval(() => void this.poll(), WATCHDOG_INTERVAL_MS)
        : this.timers.setInterval(
            "watchdog",
            () => void this.poll(),
            WATCHDOG_INTERVAL_MS,
          );
  }
  stop(): void {
    // Why: clearing the interval cannot cancel a poll already awaiting the
    // IPC reply — the bump is what invalidates that continuation.
    this.generation += 1;
    if (this.timers === null) clearInterval(this.timer ?? undefined);
    else this.timers.clearInterval(this.timer);
    this.timer = null;
  }
  private async poll(): Promise<void> {
    if (!this.isPlaying()) {
      this.stop();
      return;
    }
    if (this.polling || Date.now() - this.lastTickAt <= WATCHDOG_STALE_MS)
      return;
    this.polling = true;
    const gen = this.generation;
    try {
      const raw = await this.getTimePos();
      // Stale round: stop() ran mid-flight (release/pause/self-heal) — this
      // time-pos describes a dead engine and must not resurrect state.
      if (gen !== this.generation) return;
      const time = asNumber(raw);
      if (time === null)
        warnThrottled(`time-pos nil-drop: ${truncateRaw(raw)}`);
      else {
        this.lastTickAt = Date.now();
        this.onTimeUpdate(time);
      }
    } catch (e) {
      warnThrottled(`time-pos poll failed: ${describeError(e)}`);
    } finally {
      this.polling = false;
    }
  }
}

/** One polled snapshot of mpv's own state (null = property unknown). */
export type StallTruth = {
  timePos: number | null;
  buffering: boolean | null;
  cacheEnd: number | null;
};

export type StallReconcilerCallbacks = {
  /** Actually playing: not paused, not finished, not torn down. */
  isActive: () => boolean;
  /** Mid-seek-ack — a reconcile round must not run while seeking. */
  isBusy: () => boolean;
  queryTruth: () => Promise<StallTruth>;
  /** Truth says mpv is NOT buffering — settle a spinner whose event was lost. */
  onReconcileBuffering: (buffering: boolean) => void;
  /** The playhead is pinned: reload the stream (attempt counts from 1). */
  onStallRecover: (pinnedTime: number, attempt: number) => void;
  /** Every recovery attempt failed to unpin the playhead — surface an error. */
  onStallExhausted: () => void;
};

/**
 * Stall reconciler — self-heal for a pinned playhead. mpv can wedge with the
 * playhead frozen and NO end-file/error ever reaching the app (ffmpeg reports
 * nothing to mpv in this class of network stalls, and a failed restart after a
 * seek silently disables cache-pause): the clock stops, the spinner can ride a
 * lost paused-for-cache=false forever, and the only cure used to be restarting
 * the app. This poller turns "pinned forever" into "self-recovered within a
 * bounded time, or a clear bounded error":
 * - once no playhead progress was observed for STALL_RECONCILE_MS, it queries
 *   the truth every STALL_POLL_INTERVAL_MS;
 * - progress is a moved time-pos, or cacheEnd growth ONCE the playhead has
 *   actually started (time-pos seen past STALL_EPSILON_SECS). Before that the
 *   download is not playback: a wedged load keeps cacheEnd growing with
 *   time-pos pinned at 0 forever, and counting that as progress was exactly
 *   what kept this reconciler from ever firing (2026-09-17 freeze report D1);
 * - a playhead pinned for STALL_RECOVER_MS (or, when it never started, for
 *   STALL_LOAD_GRACE_MS first) → onStallRecover (attempt 1..N), each attempt
 *   owning its own window;
 * - attempts exhausted → onStallExhausted exactly once, then it stops;
 * - a polled buffering=false → onReconcileBuffering(false) every round (a lost
 *   settle event must not leave the spinner stuck).
 * Rounds are skipped while !isActive() (pause/end/closed) or isBusy()
 * (seek-ack), so user actions never count as stall time; a query failure is a
 * progress-less round (logged, never a crash).
 */
export class StallReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Bumped by stop()/reset(): an in-flight round compares it after its await. */
  private generation = 0;
  private polling = false;
  /** Date.now() of the last observed progress (or the current window anchor). */
  private lastProgressAt = 0;
  private lastTimePos: number | null = null;
  private lastCacheEnd: number | null = null;
  /** The playhead has left the stream start (time-pos seen past
   *  STALL_EPSILON_SECS) — only then does cacheEnd growth prove anything. */
  private playheadStarted = false;
  private attempts = 0;
  private exhausted = false;
  private readonly cb: StallReconcilerCallbacks;
  /** Optional (R1.5): register the interval under a name + owner. */
  private readonly timers: TimerRegistry | null;

  constructor(cb: StallReconcilerCallbacks, timers?: TimerRegistry) {
    this.cb = cb;
    this.timers = timers ?? null;
  }

  /** Start watching (idempotent). Why it re-anchors even when already
   *  running: wall time spent paused or loading is not pin time — each
   *  (re)start (pause=false, file-loaded) begins a fresh window. */
  start(): void {
    if (!this.cb.isActive()) return;
    this.lastProgressAt = Date.now();
    if (this.timer !== null) return;
    this.timer =
      this.timers === null
        ? setInterval(() => void this.round(), STALL_POLL_INTERVAL_MS)
        : this.timers.setInterval(
            "reconciler",
            () => void this.round(),
            STALL_POLL_INTERVAL_MS,
          );
  }

  /** Stop watching (idempotent): no callback can fire after this returns. */
  stop(): void {
    this.generation += 1;
    if (this.timer !== null) {
      if (this.timers === null) clearInterval(this.timer);
      else this.timers.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** New track / fresh lifecycle: drop baselines and the attempt budget. */
  reset(): void {
    this.generation += 1;
    this.lastProgressAt = Date.now();
    this.lastTimePos = null;
    this.lastCacheEnd = null;
    this.playheadStarted = false;
    this.attempts = 0;
    this.exhausted = false;
  }

  /** A real time-pos push (property push or watchdog backfill). Only a CHANGED
   *  value is progress: a frozen value re-pushed while the playhead is pinned
   *  (exactly what the watchdog backfills) must not mask the stall it is
   *  evidence of. */
  noteTick(time: number): void {
    if (this.lastTimePos === null) {
      this.lastTimePos = time;
      return;
    }
    if (Math.abs(time - this.lastTimePos) <= STALL_EPSILON_SECS) return;
    this.lastTimePos = time;
    this.lastProgressAt = Date.now();
  }

  private async round(): Promise<void> {
    if (this.polling || this.exhausted) return;
    if (!this.cb.isActive()) {
      // Why: a deactivated reconciler (pause/end/finished) has nothing left
      // to observe — stop the interval instead of running a no-op round
      // every 5s until release. The engine's normal re-arm paths
      // (pause=false / file-loaded) call start() again.
      this.stop();
      return;
    }
    if (Date.now() - this.lastProgressAt < STALL_RECONCILE_MS) return;
    if (this.cb.isBusy()) return;
    const gen = this.generation;
    this.polling = true;
    let truth: StallTruth | null = null;
    try {
      truth = await this.cb.queryTruth();
    } catch (e: unknown) {
      // Why: an unreadable truth is a progress-less round, not a crash — if
      // nothing can be observed, the pin window keeps counting.
      warnThrottled(`stall-reconcile query failed: ${describeError(e)}`);
    } finally {
      this.polling = false;
    }
    if (gen !== this.generation) return; // stopped/reset while the query flew
    // Why: an unreadable truth (null) counts as no progress — with nothing
    // observable, the pin window keeps counting.
    if (truth !== null) {
      if (truth.buffering === false) this.cb.onReconcileBuffering(false);
      if (this.noteTruthProgress(truth)) {
        this.lastProgressAt = Date.now();
        return;
      }
    }
    // Why: a playhead that never left the stream start gets the load grace
    // before the first reload — a slow-but-healthy first load must not be
    // reloaded early. In every other state the normal recovery cadence holds,
    // including after a reload attempt was already made.
    const recoverAfterMs =
      this.attempts === 0 && !this.playheadStarted
        ? STALL_LOAD_GRACE_MS
        : STALL_RECOVER_MS;
    if (Date.now() - this.lastProgressAt < recoverAfterMs) return;
    if (this.attempts >= STALL_RECOVERY_MAX_ATTEMPTS) {
      this.exhausted = true;
      this.stop();
      this.cb.onStallExhausted();
      return;
    }
    this.attempts += 1;
    // Why: every attempt owns its own window, so a reload that does not unpin
    // the playhead cannot fire the next one instantly.
    this.lastProgressAt = Date.now();
    this.cb.onStallRecover(this.lastTimePos ?? 0, this.attempts);
  }

  /** Truth observations: time-pos moved (either direction — a backward seek
   *  is movement, not a pin) OR cacheEnd grew = progress — but cacheEnd
   *  growth only counts once the playhead actually started (time-pos seen
   *  past STALL_EPSILON_SECS since beginTrack). While the playhead has never
   *  left the start, a growing cacheEnd is the stream being downloaded, not
   *  audio flowing (2026-09-17 freeze report D1: mpv wedged after `loadfile`
   *  with the clock stuck at 0 while the demuxer kept fetching data). A first
   *  observation only anchors its baseline. */
  private noteTruthProgress(truth: StallTruth): boolean {
    let progressed = false;
    if (truth.timePos !== null) {
      if (
        this.lastTimePos !== null &&
        Math.abs(truth.timePos - this.lastTimePos) > STALL_EPSILON_SECS
      ) {
        progressed = true;
      }
      if (truth.timePos > STALL_EPSILON_SECS) this.playheadStarted = true;
      this.lastTimePos = truth.timePos;
    }
    if (truth.cacheEnd !== null) {
      if (
        this.playheadStarted &&
        this.lastCacheEnd !== null &&
        truth.cacheEnd - this.lastCacheEnd > STALL_EPSILON_SECS
      ) {
        progressed = true;
      }
      this.lastCacheEnd = truth.cacheEnd;
    }
    return progressed;
  }
}
