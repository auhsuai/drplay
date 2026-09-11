/**
 * mpv/Tauri IPC protocol constants + payload narrowing helpers shared by the
 * MpvAudioController (plan 2026-09-11-mpv-engine, Task 3 file split — the
 * engine class stays in mpvAudio.ts). The string values are the Rust
 * contract fixed by Tasks 1+2 (src-tauri/src/mpv/mod.rs, stream_proxy/mod.rs):
 * commands `mpv_spawn` / `mpv_command` / `mpv_shutdown` / `stream_proxy_start`,
 * events `mpv-property` {name,data} + `mpv-event` {event,reason}.
 */

export const TAURI_COMMANDS = {
  mpvSpawn: "mpv_spawn",
  mpvCommand: "mpv_command",
  mpvShutdown: "mpv_shutdown",
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

export type MpvRange = { start: number; end: number };

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
