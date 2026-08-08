import { fetchWithAuth } from "./apiClient";
import type { DriveErrorBody } from "./driveTypes";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// 403 is retryable ONLY when its body reports a Drive usage-limit reason
// (official docs: "403 error: rateLimitExceeded" / "userRateLimitExceeded" —
// developers.google.com/workspace/drive/api/guides/handle-errors; same set as
// the proSync worker precedent). Other 403s (permissions…) are never retried.
const DRIVE_RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32000;
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Delay helper (exported for tests). Exposes the retry backoff this module
 * uses, honoring Retry-After when present, otherwise exponential backoff with
 * jitter, capped at MAX_DELAY_MS.
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
 * Derive a short, safe classification tag from an error's message ONLY.
 * We never log the error object or its stack — those can leak file ids, user
 * data, or (in theory) auth material into logs. Callers use this for observability.
 */
export function classifyDriveError(err: unknown): string {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown-error";
  const m = msg.toLowerCase();
  if (m.includes("timeout") || m.includes("aborterror")) return "timeout";
  if (
    m.includes("network") ||
    m.includes("failed to fetch") ||
    m.includes("unreachable")
  )
    return "network";
  const statusMatch = m.match(/\((\d{3})\)/);
  if (statusMatch) return `http-${statusMatch[1] ?? "000"}`;
  return "unknown";
}

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

/**
 * The Drive API resilience layer: fetch through fetchWithAuth with retry.
 * 429/5xx are retried with exponential backoff + jitter; a 403 is retried
 * only when the body reports a Drive rate-limit reason. A caller abort is
 * NEVER retried (re-firing an aborted request only wastes network). Retries
 * are bounded (MAX_RETRIES) — callers get a final response or rejection, not
 * an infinite hang.
 * @param url Full Drive endpoint URL.
 * @param options Fetch options; `signal` is merged with a per-attempt timeout.
 * @param timeoutMs Per-attempt timeout (default 20s).
 * @returns The final Response — retried or non-retryable; a 4xx (except
 * rate-limit 403) is returned as-is, never retried.
 */
export async function driveFetch(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  // Infinite loop: every iteration ends in `return res`, `throw err`, or a
  // `continue` gated by attempt < MAX_RETRIES — the loop can never exit
  // normally (TS needs the non-terminating form to accept the shape).
  for (let attempt = 0; ; attempt++) {
    try {
      // Fresh timeout signal per attempt (an aborted signal cannot be reused).
      // A caller-supplied signal must NOT disable the timeout — merge both so
      // a stalled network still fails after timeoutMs.
      const signal = mergeWithTimeoutSignal(options.signal, timeoutMs);
      const res = await fetchWithAuth(url, { ...options, signal, timeoutMs });

      if (attempt < MAX_RETRIES) {
        // 429/5xx are retryable by status alone; a 403 only when its body
        // reports a Drive rate limit. The body is read via a clone so the
        // response returned to the caller keeps its body; the clone is only
        // taken on attempts that could still retry (never for 2xx/5xx).
        const rateLimit403 =
          res.status === 403 && (await isRateLimit403Response(res));
        if (RETRYABLE_STATUS.has(res.status) || rateLimit403) {
          await sleep(backoffDelay(attempt, res.headers.get("Retry-After")));
          continue;
        }
      }
      return res;
    } catch (err) {
      // User-initiated cancel (unmount / navigation / folder switch) must NOT
      // be retried: re-firing an aborted request only wastes network and
      // prolongs spinners. A timeout fired on OUR merged signal (caller signal
      // NOT aborted) is still retryable — a stalled network is transient.
      if (options.signal?.aborted === true) {
        throw err;
      }
      // Network failure or timeout (AbortError) — transient, retry with backoff.
      if (attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw err;
    }
  }
}

export async function readDriveErrorBody(
  response: Response,
): Promise<DriveErrorBody | null> {
  try {
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null) return null;
    return data;
  } catch {
    return null;
  }
}

// 403 rate-limit detection: Drive reports usage limits with the official
// reasons rateLimitExceeded / userRateLimitExceeded (handle-errors docs + the
// proSync worker precedent). The real API sends the reason inside
// error.errors[].reason, not error.reason — checking the array first, then
// falling back to the legacy top-level reason. Everything else on 403
// (permissions…) is NOT a rate limit and must not be retried.
function isRateLimitError(
  status: number,
  errBody: DriveErrorBody | null,
): boolean {
  if (status !== 403) return false;
  const reasons = errBody?.error?.errors;
  if (Array.isArray(reasons)) {
    for (const r of reasons) {
      if (
        typeof r.reason === "string" &&
        DRIVE_RATE_LIMIT_REASONS.has(r.reason)
      )
        return true;
    }
  }
  const legacy = errBody?.error?.reason;
  return typeof legacy === "string" && DRIVE_RATE_LIMIT_REASONS.has(legacy);
}

// Read a 403 body via a clone so the response handed back to the caller keeps
// its body intact (same clone pattern as the worker's isDriveRateLimitResponse).
// A clone/parse failure means we cannot confirm a rate limit → treat the 403
// as non-retryable (fail as before) instead of guessing.
export async function isRateLimit403Response(
  response: Response,
): Promise<boolean> {
  let cloned: Response;
  try {
    cloned = response.clone();
  } catch {
    return false;
  }
  return isRateLimitError(response.status, await readDriveErrorBody(cloned));
}
