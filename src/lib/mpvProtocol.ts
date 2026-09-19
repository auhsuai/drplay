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
/** Bound for the `stream_proxy_start` invoke (D8): the Rust side only binds
 *  localhost and mints a process-lifetime token — a healthy start is
 *  near-instant, so this is a conservative ceiling against a hung IPC reply
 *  holding the playback attempt open forever (not a measured budget). */
export const PROXY_START_TIMEOUT_MS = 10_000;

export type MpvRange = { start: number; end: number };

/** Shared throttle-clock shape for the engine (one literal, no drift). */
export function freshThrottleClocks(): {
  lastTimeUpdate: { last: number };
  lastProgressEmit: { last: number };
} {
  return { lastTimeUpdate: { last: 0 }, lastProgressEmit: { last: 0 } };
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

export function warnThrottled(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_THROTTLE_MS) return;
  lastWarnAt = now;
  void captureError({ level: "warn", source: "mpvProtocol", message });
}
export function resetWarnThrottleForTest(): void {
  lastWarnAt = -Infinity;
}

export function truncateRaw(raw: unknown): string {
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
