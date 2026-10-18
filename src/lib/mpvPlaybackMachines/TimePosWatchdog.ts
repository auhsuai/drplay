import type { TimerRegistry } from "../timerRegistry";
import {
  asNumber,
  describeError,
  truncateRaw,
  warnThrottled,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_STALE_MS,
} from "../mpvProtocol";

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
