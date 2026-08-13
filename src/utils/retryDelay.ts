// Shared retry primitives, dependency-free (built-ins only) so ANY module can
// reuse them — including credential-isolated ones like driveRangeTokenizer
// that must NOT import the Drive API client layer. Home of the exponential
// backoff + jitter math previously local to driveHttp.

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32000;

/**
 * Delay helper (exported for tests). Resolves after `ms` milliseconds via
 * setTimeout; the retry backoff this module exposes lives in backoffDelay.
 */
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Merge a caller-supplied abort signal with a fresh timeout signal so a
// stalled network still fails after timeoutMs. A caller signal must NOT
// disable the timeout (same pattern as apiClient.fetchWithAuth); on runtimes
// lacking AbortSignal.any the timeout alone is used.
export function mergeWithTimeoutSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

/**
 * Retry backoff for the Drive resilience layer: honors a Retry-After header
 * (RFC 9110) when present and parseable — numeric seconds or HTTP-date —
 * capped at MAX_DELAY_MS; otherwise exponential backoff from BASE_DELAY_MS
 * with up to 50% jitter, capped at MAX_DELAY_MS (jitter spreads retries so a
 * burst of 429s does not thunder-herd Drive).
 *
 * `opts` customizes the policy for a call site (the proSync worker passes
 * maxMs 8000 + jitterMaxMs 500 to reproduce its historical constants):
 * - `baseMs` replaces the exponential base (default 1000).
 * - `maxMs` replaces the cap for Retry-After-derived and exponential delays
 *   (default 32000).
 * - `jitterMaxMs`, when provided, switches jitter to the worker formula —
 *   a fixed integer window 0..jitterMaxMs via floor(random * (jitterMaxMs+1)),
 *   applied to the Retry-After-derived delay too (the worker always added
 *   jitter on top of a Retry-After delay). Without it the default
 *   multiplicative jitter (up to 50% of the exponential base) is kept, and
 *   a Retry-After-derived delay is returned un-jittered, as before.
 */
export function backoffDelay(
  attempt: number,
  retryAfter?: string | null,
  opts?: { baseMs?: number; maxMs?: number; jitterMaxMs?: number },
): number {
  const baseMs = opts?.baseMs ?? BASE_DELAY_MS;
  const maxMs = opts?.maxMs ?? MAX_DELAY_MS;
  const jitterMaxMs = opts?.jitterMaxMs;

  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      const ms = Math.min(secs * 1000, maxMs);
      return jitterMaxMs === undefined
        ? ms
        : ms + Math.floor(Math.random() * (jitterMaxMs + 1));
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      const diff = dateMs - Date.now();
      if (diff > 0) {
        const ms = Math.min(diff, maxMs);
        return jitterMaxMs === undefined
          ? ms
          : ms + Math.floor(Math.random() * (jitterMaxMs + 1));
      }
    }
  }
  const exp = Math.min(baseMs * 2 ** attempt, maxMs);
  if (jitterMaxMs !== undefined) {
    return exp + Math.floor(Math.random() * (jitterMaxMs + 1));
  }
  const jitter = Math.random() * exp * 0.5;
  return Math.min(exp + jitter, maxMs);
}
