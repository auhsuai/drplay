import { fetchWithAuth } from "./apiClient";
import {
  DRIVE_RATE_LIMIT_REASONS,
  isTransientDriveStatus,
  type DriveErrorBody,
} from "./driveTypes";
import { backoffDelay, mergeWithTimeoutSignal, sleep } from "./retryDelay";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// 403 is retryable ONLY when its body reports a Drive usage-limit reason
// (DRIVE_RATE_LIMIT_REASONS in driveTypes — same set as the proSync worker).
// Other 403s (permissions…) are never retried.
const MAX_RETRIES = 4;
const DEFAULT_TIMEOUT_MS = 20000;

// Retry primitives (sleep / mergeWithTimeoutSignal / backoffDelay) now live in
// the dependency-free ./retryDelay module — credential-isolated modules like
// driveRangeTokenizer import from there directly. Re-exported here so existing
// "./driveApi" consumers keep the exact same surface.
export { backoffDelay, mergeWithTimeoutSignal, sleep };

/**
 * Derive a short, safe classification tag from an error's name and message.
 * We never log the error object or its stack — those can leak file ids, user
 * data, or (in theory) auth material into logs. Callers use this for observability.
 */
export function classifyDriveError(err: unknown): string {
  // Name check first (same pattern as apiClient.classifyRequestError): a
  // caller abort rejects with DOMException("aborted", "AbortError") — its
  // message carries no "aborterror" text — and AbortSignal.timeout()
  // rejects with name "TimeoutError" (only some engines put "timeout" in
  // the message), so both would otherwise land in "unknown".
  if (
    (err instanceof DOMException || err instanceof Error) &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  )
    return "timeout";
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

// Retryable-by-status predicate for the resumable-upload loops and
// shouldRetryDriveResponse's default (429 + any 5xx, Google handle-errors
// guidance); the main-thread driveFetch keeps a NARROWER historical
// whitelist (isDriveFetchRetryableStatus) — unifying the two would change
// driveFetch's retry math for 501/505+, so both are preserved and the shared
// helper takes the predicate as a parameter. The predicate itself lives in
// driveTypes as isTransientDriveStatus; re-exported under the historical name
// so existing "./driveApi" consumers keep the exact same surface.
export { isTransientDriveStatus as isRetryableDriveStatus };

const isDriveFetchRetryableStatus = (status: number): boolean =>
  RETRYABLE_STATUS.has(status);

/**
 * Shared retryable-status decision for the three Drive retry loops (driveFetch,
 * queryResumableStatus, putChunkWithRetry): true when the response's status
 * warrants ANOTHER attempt — 429/5xx by status alone, or a 403 whose body
 * reports a Drive rate-limit reason. The 403 body is read via a clone ONLY
 * while retries remain (attempt < maxRetries), so the final attempt never
 * consumes the response body. Does NOT enforce the retry budget for the status
 * match itself — each loop applies its own budget and exhausted behavior
 * (driveFetch returns the final response; the upload loops throw).
 */
export async function shouldRetryDriveResponse(
  response: Response,
  attempt: number,
  maxRetries: number,
  statusRetryable: (status: number) => boolean = isTransientDriveStatus,
): Promise<boolean> {
  if (statusRetryable(response.status)) return true;
  if (response.status === 403 && attempt < maxRetries) {
    return isRateLimit403Response(response);
  }
  return false;
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

      // 429/5xx are retryable by status alone; a 403 only when its body reports
      // a Drive rate limit (the body is read via a clone only while retries
      // remain — the response returned to the caller keeps its body). The
      // decision is shared with the upload loops via shouldRetryDriveResponse
      // but keeps this module's narrower whitelist (isDriveFetchRetryableStatus).
      if (
        attempt < MAX_RETRIES &&
        (await shouldRetryDriveResponse(
          res,
          attempt,
          MAX_RETRIES,
          isDriveFetchRetryableStatus,
        ))
      ) {
        // Mirror driveRangeTokenizer's caller-abort guard (and this catch
        // path below): never sleep into a cancelled caller's backoff — a
        // long Retry-After can park this loop for up to MAX_DELAY_MS just
        // to fire one doomed attempt afterwards. The AbortError thrown here
        // lands in the catch block, which rethrows it because
        // options.signal.aborted is true (same exit as a mid-fetch abort).
        if (!(options.signal?.aborted ?? false)) {
          await sleep(backoffDelay(attempt, res.headers.get("Retry-After")));
          continue;
        }
        throw new DOMException("aborted", "AbortError");
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
