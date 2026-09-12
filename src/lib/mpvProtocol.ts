/**
 * mpv/Tauri IPC protocol constants + payload narrowing helpers shared by the
 * MpvAudioController (plan 2026-09-11-mpv-engine, Task 3 file split — the
 * engine class stays in mpvAudio.ts). The string values are the Rust
 * contract fixed by Tasks 1+2 (src-tauri/src/mpv/mod.rs, stream_proxy/mod.rs):
 * commands `mpv_spawn` / `mpv_command` / `mpv_shutdown` / `stream_proxy_start`,
 * events `mpv-property` {name,data} + `mpv-event` {event,reason}.
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
/** Watchdog poll backfill (mpv #13695): poll cadence + push-staleness threshold. */
export const WATCHDOG_INTERVAL_MS = 1000;
export const WATCHDOG_STALE_MS = 1200;

export type MpvRange = { start: number; end: number };

/** Shared throttle-clock shape for the engine (one literal, no drift). */
export function freshThrottleClocks(): {
  lastTimeUpdate: { last: number };
  lastProgressEmit: { last: number };
} {
  return { lastTimeUpdate: { last: 0 }, lastProgressEmit: { last: 0 } };
}

/**
 * Display-delay buffering tracker (Spotify/YT-Music spinner pattern).
 * Three states: idle -> pending (request armed, SPINNER_DELAY_MS timer
 * running) -> shown (spinner visible).
 * - request(): an optimistic operation started (new playTrack / seek).
 *   From shown it keeps the spinner on and re-arms the net (dedupe: no
 *   re-emit, pending would force a duplicate true when promoted).
 * - settle(): playback confirmed — the 2nd time-pos tick within
 *   TICK_WINDOW_MS (mpv stalls keep time-pos frozen, so a changed tick
 *   means real progress) or the pause=false event. pending -> idle is
 *   SILENT (never showed, no emit — anti-flash); shown emits false once.
 * - reportMpvBuffering(): mpv's genuine paused-for-cache signal. true
 *   sustained for SPINNER_DELAY_MS promotes pending/idle to shown
 *   immediately (skips the remaining display delay); while shown it
 *   re-arms the net. false cancels the sustain timer and settles a
 *   shown spinner (a false while pending is just mpv's observe report —
 *   ignored, otherwise it would kill the spinner before the first tick).
 * - Safety net (BUFFERING_TIMEOUT_MS from the last request/report): shown
 *   auto-settles; a stuck pending force-promotes (defensive branch).
 * Emits ONLY on idle->shown / shown->idle transitions.
 * cancel() resets silently for release() — no emit on a torn-down engine.
 */
export class BufferingTracker {
  private state: "idle" | "pending" | "shown" = "idle";
  private displayTimer: ReturnType<typeof setTimeout> | null = null;
  private sustainTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickAt: number | null = null;
  private readonly emit: (isBuffering: boolean) => void;

  constructor(emit: (isBuffering: boolean) => void) {
    this.emit = emit;
  }

  request(): void {
    this.clearTimers();
    this.lastTickAt = null;
    if (this.state === "shown") {
      this.rearmDeadline();
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
    if (this.state === "shown") this.emit(false);
    this.state = "idle";
  }

  reportMpvBuffering(isBuffering: boolean): void {
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

  onTimeTick(): void {
    if (this.state === "idle") return;
    const now = Date.now();
    if (this.lastTickAt !== null && now - this.lastTickAt <= TICK_WINDOW_MS) {
      this.settle();
      return;
    }
    this.lastTickAt = now;
  }

  onPlayEvent(): void {
    if (this.state !== "idle") this.settle();
  }

  /** True while the spinner is visible — the engine clock must freeze then. */
  isShown(): boolean {
    return this.state === "shown";
  }

  cancel(): void {
    this.clearTimers();
    this.lastTickAt = null;
    this.state = "idle";
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
    try {
      const raw = await this.getTimePos();
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
  onEndFile: (outcome: "eof" | "error") => void;
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
  if (event !== MPV_EVENTS.endFile) return;
  const reason = asString(payload["reason"]);
  if (reason === MPV_END_FILE_REASONS.eof) {
    cb.onEndFile("eof");
    return;
  }
  if (reason === MPV_END_FILE_REASONS.error) {
    cb.onEndFile("error");
  }
}
