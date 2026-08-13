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
 */
export function backoffDelay(
  attempt: number,
  retryAfter?: string | null,
): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, MAX_DELAY_MS);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      const diff = dateMs - Date.now();
      if (diff > 0) return Math.min(diff, MAX_DELAY_MS);
    }
  }
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = Math.random() * exp * 0.5;
  return Math.min(exp + jitter, MAX_DELAY_MS);
}
