/**
 * mpv/Tauri IPC protocol constants + payload narrowing helpers shared by the
 * MpvAudioController (plan 2026-09-11-mpv-engine, Task 3 file split — the
 * engine class stays in mpvAudio.ts). The string values are the Rust
 * contract fixed by Tasks 1+2 (src-tauri/src/mpv/mod.rs, stream_proxy/mod.rs):
 * commands `mpv_spawn` / `mpv_command` / `mpv_shutdown` / `stream_proxy_start`,
 * events `mpv-property` {name,data} + `mpv-event` {event,reason,error}
 * (`error`/`file_error` from mpv; `ipc-closed` when the pipe ends) +
 * `stream-proxy-error` {fileId,status} (R04: the real status the local
 * stream proxy returned for a failing request; consumed by mpvAudio.ts as
 * the primary error-kind source — see classifyEndFileError).
 */

import { captureError } from "../utils/errorLog";

export const TAURI_COMMANDS = {
  mpvSpawn: "mpv_spawn",
  mpvCommand: "mpv_command",
  mpvShutdown: "mpv_shutdown",
  mpvGetProperty: "mpv_get_property",
  streamProxyStart: "stream_proxy_start",
} as const;

export const TAURI_EVENTS = {
  property: "mpv-property",
  event: "mpv-event",
  streamProxyError: "stream-proxy-error",
} as const;

export const MPV_PROPERTIES = {
  timePos: "time-pos",
  duration: "duration",
  pause: "pause",
  pausedForCache: "paused-for-cache",
  cacheState: "demuxer-cache-state",
} as const;

export const MPV_EVENTS = {
  fileLoaded: "file-loaded",
  endFile: "end-file",
  ipcClosed: "ipc-closed",
} as const;

export const MPV_END_FILE_REASONS = {
  eof: "eof",
  error: "error",
} as const;

export const MPV_COMMANDS = {
  loadfile: "loadfile",
  replace: "replace",
  seek: "seek",
  absolute: "absolute",
  setProperty: "set_property",
} as const;

export const MPV_PROPERTY_ARGS = {
  volume: "volume",
  pause: "pause",
} as const;

/** mpv boolean properties parse string args like command-line values. */
export const MPV_BOOL = { yes: "yes", no: "no" } as const;

export const PROXY_ORIGIN = "http://127.0.0.1";
export const STREAM_PATH = "/stream/";
export const VOLUME_SCALE = 100;
export const THROTTLE_MS = 200;
/** Spinner display delay: pending -> shown (anti-flash threshold). */
export const SPINNER_DELAY_MS = 250;
/** Safety net: never spin longer than this without a settle signal. */
export const BUFFERING_TIMEOUT_MS = 8000;
/** Two time-pos ticks within this window = playback truly progressing. */
export const TICK_WINDOW_MS = 1000;
/** Seek ack (S1): a reported time-pos within this many seconds of the seek
 *  target counts as mpv acknowledging the seek — anything farther is a stale
 *  pre-seek value and must be dropped. */
export const SEEK_ACK_TOLERANCE_SECS = 1;
/** Seek ack failsafe (S1): stop filtering stale time-pos this long after a
 *  seek so a lost/failed seek command can never freeze the clock forever. */
export const SEEK_ACK_TIMEOUT_MS = 4000;
/** Watchdog poll backfill (mpv #13695): poll cadence + push-staleness threshold. */
export const WATCHDOG_INTERVAL_MS = 1000;
export const WATCHDOG_STALE_MS = 1200;

/**
 * Stall reconciler tuning (pinned-playhead self-heal).
 * - POLL: cadence of the truth query once the playhead looks pinned.
 * - RECONCILE: no playhead progress for this long → start polling; a healthy
 *   stream that is merely quiet never pays a query.
 * - RECOVER: pinned playhead (time-pos frozen AND cacheEnd not growing) held
 *   for this long → one recovery reload. Why 75s: it sits ABOVE mpv's
 *   `--network-timeout` (60s) so mpv's own error path gets the first chance
 *   to fail the stream on its own before the app intervenes.
 * - MAX_ATTEMPTS: recovery reloads per track before the error surfaces.
 */
export const STALL_POLL_INTERVAL_MS = 5_000;
export const STALL_RECONCILE_MS = 10_000;
export const STALL_RECOVER_MS = 75_000;
export const STALL_RECOVERY_MAX_ATTEMPTS = 2;
/** Load grace before the first recovery reload, for a playhead that never
 *  left the stream start (time-pos still ≈ 0 since the load began). While the
 *  playhead never moved, cacheEnd growth is the stream being DOWNLOADED, not
 *  playback: a wedged `loadfile replace` (H1, 2026-09-17 freeze report) keeps
 *  the demuxer fed with the clock frozen forever. Waiting bounds a slow-but-
 *  healthy first load without reloading it early, and still ends in a bounded
 *  recovery + error instead of a silent download. */
export const STALL_LOAD_GRACE_MS = 150_000;
/** Deadline for `file-loaded` after a `loadfile`: a wedged playback chain
 *  never emits it (no error either, pipe alive). Past this the engine
 *  restarts the mpv sidecar — the only proven cure — and loads the track
 *  once more. Well above a healthy slow load; far below "the app is dead". */
export const LOADFILE_DEADLINE_MS = 30_000;
/** Sidecar restarts per load before the failure surfaces (bounded budget). */
export const LOADFILE_RESTART_MAX_ATTEMPTS = 1;
/** Bound for one sidecar-restart IPC call (shutdown/spawn). Why: the Rust
 *  `mpv_shutdown` awaits the child's exit unbounded, and a hung reply would
 *  turn the cure into a second silent wedge — the exact failure class this
 *  deadline exists to end. */
export const LOADFILE_RESTART_TIMEOUT_MS = 10_000;
/** Two observed positions within this delta are the same frozen playhead. */
export const STALL_EPSILON_SECS = 0.05;
/** Below this pinned position a recovery reload restarts from the top — a
 *  near-zero position carries no meaningful resume target. */
export const STALL_MIN_RESUME_SECS = 1;
/** Bound for one property query inside a reconcile round. Why: Tauri invokes
 *  have no AbortSignal (tauri-apps/tauri#8351) — without a bound, a hung IPC
 *  reply would wedge the round (and keep the in-flight guard locked) forever. */
export const STALL_QUERY_TIMEOUT_MS = 2_000;

export type MpvRange = { start: number; end: number };

/** Shared throttle-clock shape for the engine (one literal, no drift). */
export function freshThrottleClocks(): {
  lastTimeUpdate: { last: number };
  lastProgressEmit: { last: number };
} {
  return { lastTimeUpdate: { last: 0 }, lastProgressEmit: { last: 0 } };
}

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

  constructor(emit: (isBuffering: boolean) => void) {
    this.emit = emit;
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
    this.displayTimer = setTimeout(() => {
      this.displayTimer = null;
      this.promote();
    }, SPINNER_DELAY_MS);
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
        this.sustainTimer = setTimeout(() => {
          this.sustainTimer = null;
          this.promote();
        }, SPINNER_DELAY_MS);
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

  cancel(): void {
    this.clearTimers();
    this.lastTickAt = null;
    this.lastTickValue = null;
    this.state = "idle";
    // Why (v4): release() tears the mpv process down — its last
    // paused-for-cache report is dead state and must not suppress the next
    // engine's tick-settle.
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
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      this.deadlineFire();
    }, BUFFERING_TIMEOUT_MS);
  }

  private clearTimers(): void {
    this.clearSustainTimer();
    if (this.displayTimer !== null) {
      clearTimeout(this.displayTimer);
      this.displayTimer = null;
    }
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  private clearSustainTimer(): void {
    if (this.sustainTimer !== null) {
      clearTimeout(this.sustainTimer);
      this.sustainTimer = null;
    }
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
  constructor(
    isPlaying: () => boolean,
    getTimePos: () => Promise<unknown>,
    onTimeUpdate: (time: number) => void,
  ) {
    this.isPlaying = isPlaying;
    this.getTimePos = getTimePos;
    this.onTimeUpdate = onTimeUpdate;
  }
  noteEmit(): void {
    this.lastTickAt = Date.now();
  }
  start(): void {
    if (this.timer !== null || !this.isPlaying()) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => void this.poll(), WATCHDOG_INTERVAL_MS);
  }
  stop(): void {
    // Why: clearing the interval cannot cancel a poll already awaiting the
    // IPC reply — the bump is what invalidates that continuation.
    this.generation += 1;
    clearTimeout(this.timer ?? undefined);
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

  constructor(cb: StallReconcilerCallbacks) {
    this.cb = cb;
  }

  /** Start watching (idempotent). Why it re-anchors even when already
   *  running: wall time spent paused or loading is not pin time — each
   *  (re)start (pause=false, file-loaded) begins a fresh window. */
  start(): void {
    if (!this.cb.isActive()) return;
    this.lastProgressAt = Date.now();
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.round(), STALL_POLL_INTERVAL_MS);
  }

  /** Stop watching (idempotent): no callback can fire after this returns. */
  stop(): void {
    this.generation += 1;
    if (this.timer !== null) {
      clearInterval(this.timer);
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
    if (!this.cb.isActive()) return;
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

/** Highest end among cache ranges; null when no range is known. */
export function maxRangeEnd(ranges: MpvRange[]): number | null {
  let max: number | null = null;
  for (const range of ranges) {
    if (max === null || range.end > max) max = range.end;
  }
  return max;
}

/** Bound one promisified mpv IPC call to `timeoutMs` (default:
 *  STALL_QUERY_TIMEOUT_MS). The wrapped promise always gets a handler
 *  attached, so a late reply/rejection after the timeout fired is never an
 *  unhandled rejection. */
export function withStallQueryTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = STALL_QUERY_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`mpv IPC timeout (no reply within ${String(timeoutMs)}ms)`),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

const WARN_THROTTLE_MS = 30000;
let lastWarnAt = -Infinity;

function warnThrottled(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_THROTTLE_MS) return;
  lastWarnAt = now;
  void captureError({ level: "warn", source: "mpvProtocol", message });
}
export function resetWarnThrottleForTest(): void {
  lastWarnAt = -Infinity;
}

function truncateRaw(raw: unknown): string {
  const text = typeof raw === "string" ? raw : String(raw);
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

export function extractCacheRanges(data: unknown): MpvRange[] {
  if (!isRecord(data) || !Array.isArray(data["seekable-ranges"])) return [];
  const ranges: MpvRange[] = [];
  for (const entry of data["seekable-ranges"]) {
    if (!isRecord(entry)) continue;
    const start = asNumber(entry["start"]);
    const end = asNumber(entry["end"]);
    if (start === null || end === null) continue;
    ranges.push({ start, end });
  }
  return ranges;
}

export function toTimeRanges(ranges: MpvRange[]): TimeRanges {
  return {
    length: ranges.length,
    start: (offset: number) => ranges[offset]?.start ?? 0,
    end: (offset: number) => ranges[offset]?.end ?? 0,
  };
}

export type EndFileErrorKind = "format" | "network";

/**
 * Retryable proxy statuses besides 5xx (R04): 408 request timeout,
 * 429 rate limit, 499 = proxy-synthesized idle-abort of a stalled body.
 */
const PROXY_RETRYABLE_STATUSES: readonly number[] = [408, 429, 499];

/**
 * Classify an end-file error (R05 — proxy status is the PRIMARY source).
 * Why: mpv's `file_error` is only mpv_error_string() output — short strings
 * like "loading failed" / "unrecognized file format" / "something happened"
 * that carry no HTTP detail (R04 audit proved the old regex premise wrong).
 * The local stream proxy reports the real status via `stream-proxy-error`.
 *
 * Priority:
 * - `proxyStatus` present (the current stream's proxy error event):
 *   - 5xx or 408/429/499 → "network" (retryable, never marks broken);
 *   - any other 4xx → "format" (Drive locked/quota: storm-guard semantics);
 *   - values outside 4xx/5xx are not proxy error statuses → fall through.
 * - no usable proxy status → weak fallback on mpv's raw string:
 *   - null/empty → "format" (100% parity with the pre-existing behavior);
 *   - HTTP 4xx / forbidden / not found → "format";
 *   - transport keywords (connection/reset/timeout/network/...) → "network";
 *   - anything else → "format" (safe default).
 */
export function classifyEndFileError(
  raw: string | null | undefined,
  proxyStatus?: number | null,
): EndFileErrorKind {
  if (typeof proxyStatus === "number") {
    if (proxyStatus >= 500 && proxyStatus < 600) return "network";
    if (PROXY_RETRYABLE_STATUSES.includes(proxyStatus)) return "network";
    if (proxyStatus >= 400 && proxyStatus < 500) return "format";
  }
  if (raw === null || raw === undefined || raw.trim() === "") return "format";
  if (/(http error 4\d\d|forbidden|not found)/i.test(raw)) return "format";
  if (
    /(connection|refus|reset|timed? ?out|timeout|network|unreachable|no route|broken pipe|i\/o error)/i.test(
      raw,
    )
  ) {
    return "network";
  }
  return "format";
}

/**
 * State/effect callbacks the engine class implements for each decoded event.
 * mpvProtocol owns PARSING + dispatch decisions; the class owns state
 * mutation and AudioEventMap emission.
 */
export type MpvEventCallbacks = {
  onTimeUpdate: (time: number) => void;
  onDuration: (duration: number) => void;
  onPauseChange: (paused: boolean) => void;
  onBuffering: (isBuffering: boolean) => void;
  onCacheState: (ranges: MpvRange[]) => void;
  onFileLoaded: () => void;
  onEndFile: (outcome: "eof" | "error", mpvError?: string | null) => void;
  onEngineClosed: (cause: string) => void;
  onMalformed: (detail: string) => void;
};

/** Parse one `mpv-property` payload and route it to the matching callback. */
export function dispatchPropertyEvent(
  payload: unknown,
  cb: MpvEventCallbacks,
): void {
  if (!isRecord(payload) || typeof payload["name"] !== "string") {
    cb.onMalformed("mpv-property payload malformed (skipped)");
    return;
  }
  const data = payload["data"];
  switch (payload["name"]) {
    case MPV_PROPERTIES.timePos: {
      const time = asNumber(data);
      if (time !== null) cb.onTimeUpdate(time);
      else warnThrottled(`time-pos nil-drop: ${truncateRaw(data)}`);
      return;
    }
    case MPV_PROPERTIES.duration: {
      const dur = asNumber(data);
      if (dur !== null) cb.onDuration(dur);
      return;
    }
    case MPV_PROPERTIES.pause: {
      const paused = asBoolean(data);
      if (paused !== null) cb.onPauseChange(paused);
      return;
    }
    case MPV_PROPERTIES.pausedForCache: {
      const buffering = asBoolean(data);
      if (buffering !== null) cb.onBuffering(buffering);
      return;
    }
    case MPV_PROPERTIES.cacheState: {
      cb.onCacheState(extractCacheRanges(data));
      return;
    }
    default:
      return;
  }
}

/** Parse one `mpv-event` payload and route it to the matching callback. */
export function dispatchMpvEvent(
  payload: unknown,
  cb: MpvEventCallbacks,
): void {
  if (!isRecord(payload)) {
    cb.onMalformed("mpv-event payload malformed (skipped)");
    return;
  }
  const event = asString(payload["event"]);
  if (event === null) {
    cb.onMalformed("mpv-event name malformed (skipped)");
    return;
  }
  if (event === MPV_EVENTS.fileLoaded) {
    cb.onFileLoaded();
    return;
  }
  if (event === MPV_EVENTS.ipcClosed) {
    cb.onEngineClosed(asString(payload["reason"]) ?? "unknown");
    return;
  }
  if (event !== MPV_EVENTS.endFile) return;
  const reason = asString(payload["reason"]);
  if (reason === MPV_END_FILE_REASONS.eof) {
    cb.onEndFile("eof");
    return;
  }
  if (reason === MPV_END_FILE_REASONS.error) {
    cb.onEndFile("error", asString(payload["error"]));
  }
}
