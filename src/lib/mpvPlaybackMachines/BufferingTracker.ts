import type { TimerRegistry } from "../timerRegistry";
import {
  BUFFERING_TIMEOUT_MS,
  SPINNER_DELAY_MS,
  TICK_WINDOW_MS,
} from "../mpvProtocol";

/**
 * Which request opened the current spinner session.
 * - "startup": a new track load (request(true)) — the spinner covers the
 *   pre-audio window until playback is CONFIRMED.
 * - "seek": a seek (request()) — the 250ms display delay (anti-flash), the
 *   tick-pair settle and the 8s safety net.
 * - "none": the spinner was opened by mpv's own cache stall, not by a
 *   request.
 */
type SessionKind = "none" | "startup" | "seek";

/**
 * What the tracker knows about mpv's cache stall.
 * - "none": mpv never reported paused-for-cache=true for this track.
 * - "active": mpv reports paused-for-cache=true RIGHT NOW.
 * - "seen": a real stall happened and ended.
 */
type StallState = "none" | "active" | "seen";

/**
 * Display-delay buffering tracker (Spotify/YT-Music spinner pattern) — v5.
 *
 * One state machine, three session kinds (see SessionKind):
 * - request(true) — a new track load: the spinner is promoted IMMEDIATELY
 *   (the pre-audio window must have a spinner source) and stays up until
 *   playback is CONFIRMED. Only two things dismiss it: onPlaybackStart()
 *   (mpv's playback chain is up) or a real cache stall that ended. It is NOT
 *   dismissed by a time-pos tick pair, by the first `paused-for-cache=false`,
 *   by `pause=false` or by the 8s net — a slow load must keep its loader
 *   (the load deadline + the stall reconciler bound the startup instead).
 * - request() — a seek: unchanged (250ms anti-flash, tick-pair settle, 8s
 *   net) — UNLESS a startup session is still open: a seek that arrives while
 *   the load is unconfirmed (the deferred seek of playTrack(track, startTime))
 *   keeps the startup session, so the loader survives until playback is
 *   confirmed.
 * - mpv's own stall promotes the spinner from idle; the 8s net re-arms while
 *   the stall lasts (a real stall is open-ended — a long buffer must keep
 *   spinning).
 *
 * The stall knowledge is a tri-state (see StallState). The FIRST
 * `paused-for-cache=false` only means the property became available — it
 * proves nothing about audio flow, so it dismisses nothing; only a false
 * that FOLLOWS a real stall ends the stall.
 *
 * Emits ONLY on idle->shown / shown->idle transitions.
 * cancel() resets silently for release() — no emit on a torn-down engine,
 * and the dead mpv's stall flag dies with it.
 */
export class BufferingTracker {
  private state: "idle" | "pending" | "shown" = "idle";
  private session: SessionKind = "none";
  private stall: StallState = "none";
  private displayTimer: ReturnType<typeof setTimeout> | null = null;
  private sustainTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickAt: number | null = null;
  private lastTickValue: number | null = null;
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
    // Why (v6): a SEEK must never downgrade a STARTUP session. The startup
    // loader is dismissed only by a confirmed playback start, a real ended
    // stall, a terminal outcome or a user pause — never by the tick-pair
    // settle and never by the 8s net. A deferred seek (applyPendingSeek, which
    // runs on file-loaded for playTrack(track, startTime)) used to hand the
    // session to "seek", so a slow load lost its loader at the 8s mark
    // without playback ever having been confirmed.
    if (immediate) {
      this.session = "startup";
    } else if (this.session !== "startup") {
      this.session = "seek";
    }
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
    this.session = "none";
    if (this.state === "shown") this.emit(false);
    this.state = "idle";
  }

  /**
   * mpv's genuine paused-for-cache signal. `true` sustained for
   * SPINNER_DELAY_MS promotes pending/idle to shown (it skips the remaining
   * display delay); while shown it re-arms the net. `false` ends a REAL
   * stall — the first observation of `false` proves nothing and is ignored.
   */
  reportMpvBuffering(isBuffering: boolean): void {
    if (isBuffering) {
      this.stall = "active";
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
    // Why: the first paused-for-cache=false only says the property became
    // available (mpv pushes it right after a file load) — it must never
    // dismiss a spinner. Only a false that FOLLOWS a real stall ends it.
    if (this.stall !== "active") return;
    this.stall = "seen";
    this.clearSustainTimer();
    if (this.state === "shown") this.settle();
  }

  onTimeTick(value: number): void {
    if (this.state === "idle") return;
    // Why: mpv reports paused-for-cache — the playhead is pinned, so a
    // changed tick cannot be confirmed progress (stale queued ticks used
    // to settle the spinner and un-gate the clock before audio flowed).
    if (this.stall === "active") return;
    // Why: the startup loader waits for the CONFIRMED playback start, not
    // for a time-pos pair — a pair of changed ticks can land long before
    // mpv's chain is up.
    if (this.session !== "seek") return;
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

  /**
   * mpv's playback chain is up (playback-restart): the only proof that
   * playback actually started. It dismisses the startup loader — unless a
   * real stall is still in force (mpv is cache-paused, the chain is not
   * ready) or the session is a seek (a seek keeps its own settle rules).
   */
  onPlaybackStart(): void {
    if (this.state === "idle") return;
    if (this.stall === "active") return;
    if (this.session !== "startup") return;
    this.settle();
  }

  /**
   * Forget mpv's cache stall — the user's pause took over from it.
   *
   * The stall flag only gates the tick-pair settle and the 8s net, so a stale
   * "active" must not survive a pause: it would block the tick settle and
   * make the net re-arm forever while the user is paused (a seek issued
   * during the pause would never settle). The engine re-syncs the tracker
   * with mpv's raw `paused-for-cache` fact when the user resumes.
   *
   * A knowledge reset, not a state transition: it never emits.
   */
  clearStall(): void {
    this.stall = "none";
    this.clearSustainTimer();
  }

  /** True while the spinner is visible — the engine clock must freeze then. */
  isShown(): boolean {
    return this.state === "shown";
  }

  /** Track switch: silently drop the previous track's buffering session —
   *  timers, tick-pairing baseline, the session kind and the cached stall
   *  flag all belong to that track. Never emits (unlike settle() there is no
   *  transition to report); the new track's own request() emits its state. */
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
    this.session = "none";
    this.stall = "none";
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
      if (this.stall === "active") {
        this.rearmDeadline();
        return;
      }
      this.settle();
      return;
    }
    if (this.state === "pending") this.promote();
  }

  private rearmDeadline(): void {
    // Why: the startup loader is bounded by the load deadline + the stall
    // reconciler, never by this 8s net — a slow load must keep its loader.
    if (this.session === "startup") return;
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
