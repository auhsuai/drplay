// Shared error classification + safe logging for web workers.
//
// Centralises how the scanner/proSync workers turn unknown throwables into a
// small, typed set of failure kinds (network | timeout | abort | parse |
// unknown) and how they log without leaking secrets (auth tokens, file ids,
// local proxy links).
//
// NOTE: src/utils/logger.ts already ships a console-level sanitizer, but it is
// not exported, and workers run in a separate global scope where initLogger()
// is never called. We therefore keep a minimal, self-contained sanitizer here
// so worker logs are safe by construction.

export type WorkerErrorKind = 'network' | 'timeout' | 'abort' | 'parse' | 'unknown';

// Typed abort so callers can distinguish "user/worker cancelled" from a real
// failure and stop the sync loop cleanly instead of treating it as unknown.
export class WorkerAbortError extends Error {
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'WorkerAbortError';
  }
}

// Keep in sync with src/utils/logger.ts patterns. Duplicated on purpose: the
// logger's sanitizer is not exported and workers cannot rely on it.
const SENSITIVE_PATTERNS: RegExp[] = [
  /http:\/\/127\.0\.0\.1:\d+\/[^\s"']*/g,
  /https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[^\s"']*/g,
  /([?&])id=[a-zA-Z0-9_-]+/g,
  /([?&])access_token=[a-zA-Z0-9._-]+/g,
  /Bearer\s+[a-zA-Z0-9._-]+/g,
];

function sanitize(value: string): string {
  let out = value;
  for (const pattern of SENSITIVE_PATTERNS) {
    // `g` flag advances lastIndex; reset so repeated calls never miss a match.
    pattern.lastIndex = 0;
    out = out.replace(pattern, (_match, group1?: string) => {
      if (group1 === '?' || group1 === '&') {
        return out.includes('access_token')
          ? `${group1}access_token=[REDACTED]`
          : `${group1}id=[REDACTED_ID]`;
      }
      return '[REDACTED]';
    });
  }
  return out;
}

// Field names that almost always carry a secret regardless of value shape.
const SENSITIVE_KEYS = /token|secret|password|passwd|authorization|access[_-]?token|api[_-]?key|cookie|bearer/i;

function formatContext(context: Record<string, unknown>): string {
  const parts = Object.entries(context)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (SENSITIVE_KEYS.test(k)) return `${k}=[REDACTED]`;
      return `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`;
    });
  return parts.join(' ');
}

// Classify a thrown value from any external call (fetch / Dexie / JSON parse).
// `network` and `timeout` need to be separated so callers can decide whether a
// retry makes sense, and `abort` must not be treated as a hard failure.
export function classifyWorkerError(err: unknown): WorkerErrorKind {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return 'timeout';
    if (err.name === 'AbortError') return 'abort';
    if (err instanceof SyntaxError) return 'parse';
    if (err instanceof TypeError) {
      // `fetch` rejects with a TypeError carrying "Failed to fetch" on network
      // failures (DNS, CORS, offline). Anything else is left as unknown.
      if (/failed to fetch|networkerror|network request failed/i.test(err.message)) {
        return 'network';
      }
    }
  }
  return 'unknown';
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
  level: 'warn' | 'error' = 'error',
): void {
  const kind = classifyWorkerError(err);
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = sanitize(rawMessage);
  // Context values (e.g. a token passed by mistake) must also be scrubbed so
  // secrets never reach the logs through the structured fields.
  const ctxStr = sanitize(formatContext(context));
  const line = `[${timestamp()}] [${module}] ${kind}: ${message}${ctxStr ? ' | ' + ctxStr : ''}`;
  if (level === 'warn') console.warn(line);
  else console.error(line);
}
