// Shared retry primitives, dependency-free (built-ins only) so ANY module can
// reuse them — including credential-isolated ones like driveRangeTokenizer
// that must NOT import the Drive API client layer. Home of the exponential
// backoff + jitter math previously local to driveHttp.

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32000;
const MS_PER_SECOND = 1000;
const DEFAULT_JITTER_RATIO = 0.5;
const MIN_ATTEMPT = 0;

/**
 * Delay helper (exported for tests). Resolves after `ms` milliseconds via
 * setTimeout; the retry backoff this module exposes lives in backoffDelay.
 * An optional caller `signal` makes a long sleep (Retry-After up to 32s)
 * cancellable mid-wait: an already-aborted signal rejects at once, otherwise
 * the abort event clears the timer and rejects with `signal.reason`.
 * Omitting it keeps the historical resolve-after-ms behavior.
 */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const rejectWithReason = (): void => {
      // AbortSignal.reason is intentionally `any` per DOM (MDN): the contract
      // is to reject with the caller's own reason verbatim, so the rule's
      // Error-only preference is waived here on purpose.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal?.reason);
    };
    if (signal?.aborted === true) {
      rejectWithReason();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectWithReason();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

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
 * capped at MAX_DELAY_MS; otherwise exponential backoff from BASE_DELAY_MS,
 * capped at MAX_DELAY_MS. Every path adds jitter and re-caps at maxMs
 * (min(base + random(0, jitter), max)): a burst of 429s with the same
 * Retry-After must not thunder-herd Drive, and the result must never exceed
 * the cap the caller was promised.
 *
 * `opts` customizes the policy for a call site (the proSync worker passes
 * maxMs 8000 + jitterMaxMs 500 to reproduce its historical constants):
 * - `baseMs` replaces the exponential base (default 1000).
 * - `maxMs` replaces the cap for Retry-After-derived and exponential delays
 *   (default 32000).
 * - `jitterMaxMs`, when provided, switches jitter to the worker formula —
 *   a fixed integer window 0..jitterMaxMs via floor(random * (jitterMaxMs+1)).
 *   Without it the default multiplicative jitter (up to 50% of the delay)
 *   is used. A zero delay (Retry-After: 0) stays exactly 0 on the default
 *   path: the server asked for an immediate retry, and inventing a floor
 *   would disobey it (tight-loop protection belongs to the caller's retry
 *   budget, not to this pure delay function).
 */

// Default-path jitter: up to +50% of the delay, re-capped at maxMs.
function applyDefaultJitter(ms: number, maxMs: number): number {
  return Math.min(ms + Math.random() * ms * DEFAULT_JITTER_RATIO, maxMs);
}

// Worker-path jitter: fixed integer window 0..jitterMaxMs, re-capped at
// maxMs so the delay can never overflow the promised cap.
function applyWorkerJitter(
  ms: number,
  maxMs: number,
  jitterMaxMs: number,
): number {
  return Math.min(ms + Math.floor(Math.random() * (jitterMaxMs + 1)), maxMs);
}
export function backoffDelay(
  attempt: number,
  retryAfter?: string | null,
  opts?: { baseMs?: number; maxMs?: number; jitterMaxMs?: number },
): number {
  const baseMs = opts?.baseMs ?? BASE_DELAY_MS;
  const maxMs = opts?.maxMs ?? MAX_DELAY_MS;
  const jitterMaxMs = opts?.jitterMaxMs;
  // A negative attempt would shrink the delay below the base (2 ** -1 = 0.5).
  const safeAttempt = Math.max(MIN_ATTEMPT, attempt);

  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      const ms = Math.min(secs * MS_PER_SECOND, maxMs);
      return jitterMaxMs === undefined
        ? applyDefaultJitter(ms, maxMs)
        : applyWorkerJitter(ms, maxMs, jitterMaxMs);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      const diff = dateMs - Date.now();
      if (diff > 0) {
        const ms = Math.min(diff, maxMs);
        return jitterMaxMs === undefined
          ? applyDefaultJitter(ms, maxMs)
          : applyWorkerJitter(ms, maxMs, jitterMaxMs);
      }
    }
  }
  const exp = Math.min(baseMs * 2 ** safeAttempt, maxMs);
  if (jitterMaxMs !== undefined) {
    return applyWorkerJitter(exp, maxMs, jitterMaxMs);
  }
  return applyDefaultJitter(exp, maxMs);
}
