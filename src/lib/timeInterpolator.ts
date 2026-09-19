/**
 * Engine-level clock interpolation (audio-only files: mpv's time-pos push
 * chain stalls 2-3s at head-of-file, mpv#13695 — the watchdog only backfills
 * after >1.2s of silence, so seconds 1-2 never reach the UI). A 250ms tick
 * emits the interpolated position lastRealTime + (now - lastRealAt) whenever
 * no real push arrived within the tick window. Frozen while the buffering
 * spinner is shown (paused-for-cache keeps isPlaying true, so without this
 * gate the fill/clock would run during the stall). Real pushes (property push,
 * watchdog backfill, post-seek report) only resync the base — never
 * double-emit. Emissions ride the SAME emitTimeupdate throttle, so consumers
 * are unchanged; the watchdog stays the truth resync on total push loss.
 */

import type { TimerRegistry } from "./timerRegistry";

/** Tick cadence; also the minimum push silence before a synthetic emit. */
export const INTERPOLATOR_TICK_MS = 250;

export class TimeInterpolator {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Last real time-pos; null = no truth for this track yet (stay silent). */
  private baseTime: number | null = null;
  /** Date.now() of the last real push. */
  private baseAt = 0;
  /**
   * Why: a repeated-or-lower truth (watchdog poll backfilling a frozen
   * head-of-file position) proves the playhead is NOT advancing. Extrapolating
   * over it emits a forward run that the next frozen poll snaps back — the
   * 1-2-1-2 clock/fill oscillation before audio actually flows. While stalled
   * the tick stays silent at the truth; a truth that is actually higher clears
   * it (mpv#13695 push-gap case is untouched: no frozen truth arrives there).
   */
  private stalled = false;
  private readonly isPlaying: () => boolean;
  private readonly isBuffering: () => boolean;
  private readonly emit: (time: number) => void;
  /** Optional (R1.5): register the tick interval under a name + owner. */
  private readonly timers: TimerRegistry | null;

  constructor(
    isPlaying: () => boolean,
    emit: (time: number) => void,
    isBuffering: () => boolean = () => false,
    timers?: TimerRegistry,
  ) {
    this.isPlaying = isPlaying;
    this.isBuffering = isBuffering;
    this.emit = emit;
    this.timers = timers ?? null;
  }

  /** A real push arrived (push, watchdog backfill, seek report): resync base only. */
  noteRealTime(time: number): void {
    // `<=` (not `<`): an identical value is a frozen poll, not progress.
    this.stalled = this.baseTime !== null && time <= this.baseTime;
    this.baseTime = time;
    this.baseAt = Date.now();
  }

  /** pause / end-file / release / track change: no further synthetic emits. */
  reset(): void {
    this.stop();
    // Dropping the base matters as much as stopping: elapsed time during a
    // pause, or a finished track's position, must never drift into the next
    // interpolation run. The stall flag dies with the base it described.
    this.baseTime = null;
    this.stalled = false;
  }

  /** Arm the tick interval while playing; silent until the first real push. */
  start(): void {
    if (this.timer !== null || !this.isPlaying()) return;
    const tick = (): void => {
      this.tick();
    };
    this.timer =
      this.timers === null
        ? setInterval(tick, INTERPOLATOR_TICK_MS)
        : this.timers.setInterval("interpolator", tick, INTERPOLATOR_TICK_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    if (this.timers === null) clearInterval(this.timer);
    else this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.isPlaying()) {
      this.stop();
      return;
    }
    if (this.baseTime === null) return; // fresh track, no truth yet
    // Why: truth repeated its previous value — the playhead is frozen (no
    // audio flowing yet). Hold at the truth instead of extrapolating: each
    // frozen poll would otherwise snap the forward run back (1-2-1-2).
    if (this.stalled) return;
    // Why: mpv paused-for-cache keeps isPlaying true while no audio flows —
    // without this gate the clock/fill would run during the spinner. Re-anchor
    // instead of just skipping so the stall wall-time never pays out as a
    // catch-up jump when buffering settles.
    if (this.isBuffering()) {
      this.baseAt = Date.now();
      return;
    }
    const elapsedMs = Date.now() - this.baseAt;
    // A real push inside the last tick window: real data is fresher — skip.
    if (elapsedMs < INTERPOLATOR_TICK_MS) return;
    this.emit(this.baseTime + elapsedMs / 1000);
  }
}
