import type { TimerRegistry } from "../timerRegistry";
import {
  describeError,
  warnThrottled,
  STALL_EPSILON_SECS,
  STALL_LOAD_GRACE_MS,
  STALL_POLL_INTERVAL_MS,
  STALL_RECONCILE_MS,
  STALL_RECOVER_MS,
  STALL_RECOVERY_MAX_ATTEMPTS,
} from "../mpvProtocol";

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
