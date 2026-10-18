import type { TimerRegistry } from "../timerRegistry";
import {
  BUFFERING_TIMEOUT_MS,
  SPINNER_DELAY_MS,
  TICK_WINDOW_MS,
} from "../mpvProtocol";

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
