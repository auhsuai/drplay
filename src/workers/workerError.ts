// Shared error classification + safe logging for web workers.
//
// Centralises how the proSync worker turns unknown throwables into a
// small, typed set of failure kinds (network | timeout | abort | parse |
// unknown) and how they log without leaking secrets (auth tokens, file ids,
// local proxy links).
//
// NOTE: workers run in a separate global scope where initLogger() (called in
// main.tsx) is never invoked, so the global console is NOT monkeypatched with
// the sanitizer. We therefore redact inline here using the canonical
// `sanitizeString` from src/utils/errorLog.ts as a single source of truth.

import { captureError, sanitizeString } from "../utils/errorLog";

export type WorkerErrorKind =
  "network" | "timeout" | "abort" | "parse" | "unknown";

// Typed abort so callers can distinguish "user/worker cancelled" from a real
// failure and stop the sync loop cleanly instead of treating it as unknown.
export class WorkerAbortError extends Error {
  constructor(message = "Operation aborted") {
    super(message);
    this.name = "WorkerAbortError";
  }
}

// Thin, throw-safe wrapper around errorLog.ts's canonical sanitizer. If
// sanitizeString ever throws (it shouldn't), we fall back to the raw value so
// the worker still emits the log instead of dropping it or crashing on log.
function safeSanitize(value: string): string {
  try {
    return sanitizeString(value);
  } catch {
    return value;
  }
}

// Field names that almost always carry a secret regardless of value shape.
const SENSITIVE_KEYS =
  /token|secret|password|passwd|authorization|access[_-]?token|api[_-]?key|cookie|bearer/i;

// Stringify a context value for the log line. null/undefined are filtered out
// by the caller; objects are JSON-serialized; functions never carry data in a
// context object, so a marker replaces their source (String(fn)).
function stringifyContextValue(v: unknown): string {
  switch (typeof v) {
    case "object":
      // Template interpolation below turns an exotic-toJSON `undefined`
      // return into "undefined" — identical to the old inline behavior.
      return JSON.stringify(v);
    case "string":
      return v;
    case "symbol":
      return v.toString();
    case "function":
      return "[function]";
    default:
      return String(v);
  }
}

function formatContext(context: Record<string, unknown>): string {
  const parts = Object.entries(context)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (SENSITIVE_KEYS.test(k)) return `${k}=[REDACTED]`;
      return `${k}=${stringifyContextValue(v)}`;
    });
  return parts.join(" ");
}

// Classify a thrown value from any external call (fetch / Dexie / JSON parse).
// `network` and `timeout` need to be separated so callers can decide whether a
// retry makes sense, and `abort` must not be treated as a hard failure.
export function classifyWorkerError(err: unknown): WorkerErrorKind {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return "timeout";
    if (err.name === "AbortError") return "abort";
    if (err instanceof SyntaxError) return "parse";
    if (err instanceof TypeError) {
      // `fetch` rejects with a TypeError carrying "Failed to fetch" on network
      // failures (DNS, CORS, offline). Anything else is left as unknown.
      if (
        /failed to fetch|networkerror|network request failed/i.test(err.message)
      ) {
        return "network";
      }
    }
  }
  return "unknown";
}

function timestamp(): string {
  return new Date().toISOString();
}

// Logs an error with module + input context and a timestamp. Never receives the
// raw token — callers must pass only safe context fields (fileId, status, ...).
export function logWorkerError(
  module: string,
  context: Record<string, unknown>,
  err: unknown,
  level: "warn" | "error" = "error",
): void {
  const kind = classifyWorkerError(err);
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = safeSanitize(rawMessage);
  // Context values (e.g. a token passed by mistake) must also be scrubbed so
  // secrets never reach the logs through the structured fields.
  const ctxStr = safeSanitize(formatContext(context));
  const line = `[${timestamp()}] [${module}] ${kind}: ${message}${ctxStr ? " | " + ctxStr : ""}`;
  // Final line goes through the canonical 2026 sanitizer from errorLog.ts as a
  // single source of truth for link/id/token redaction. safeSanitize guarantees
  // we never throw while logging and never silently drop the message if the
  // sanitizer itself fails.
  const safeLine = safeSanitize(line);
  try {
    // Fire-and-forget: captureError never rejects; logging must never throw.
    void captureError({ level, source: module, message: safeLine });
  } catch {
    /* logging must never throw */
  }
}
