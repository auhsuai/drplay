import {
  classifyWorkerError,
  logWorkerError,
  WorkerAbortError,
} from "./workerError";
import { authHeaders } from "../utils/authHeaders";

const SYNC_FETCH_TIMEOUT_MS = 30000;
// Transient HTTP errors (429 rate-limit, 5xx server errors, and 403 whose
// JSON error body reports a Drive rate-limit reason) are retried with bounded
// exponential backoff (base * 2^attempt + jitter), honoring the Retry-After
// header (capped at MAX_RETRY_DELAY_MS) — max 3 attempts, never retried
// forever (AGENTS.md Luật 4).
const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_RETRY_BASE_DELAY_MS = 1000;
// Upper bound for a Retry-After-derived delay so a misbehaving server cannot
// stall a sync indefinitely.
const MAX_RETRY_DELAY_MS = 8000;
// Random extra delay (0..500ms) added to every retry so concurrent syncs do
// not retry in lockstep (thundering herd).
const RETRY_JITTER_MAX_MS = 500;
// Google Drive reports rate limiting as 403 with these `error.errors[].reason`
// values (usage limits): https://developers.google.com/drive/api/guides/handle-errors
const DRIVE_RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

// Resolves after `ms`, used as the exponential backoff between transient
// retries. setTimeout is available in the worker scope.
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Transient HTTP statuses worth retrying: 429 (rate limit) and 5xx server
// errors, per Google API guidance. Other statuses (2xx, 4xx) are not retried.
// A 403 is only transient when its JSON body identifies a Drive rate limit
// (see isDriveRateLimitResponse).
export function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

// True when a Drive error body reports a rate-limit reason (usage limits).
// Any parse failure means we cannot confirm a rate limit, so callers treat
// the response as non-transient (fail as before) instead of guessing.
function isDriveRateLimitBody(bodyText: string): boolean {
  try {
    // Drive's error body is untrusted JSON, so the array members are typed
    // with null/undefined explicitly — the defensive checks below are real.
    const parsed = JSON.parse(bodyText) as {
      error?: {
        errors?: Array<{ reason?: unknown } | null | undefined>;
      };
    };
    const errors = parsed.error?.errors;
    return (
      Array.isArray(errors) &&
      errors.some((e) => {
        if (e === undefined || e === null) return false;
        const reason = e.reason;
        return (
          typeof reason === "string" && DRIVE_RATE_LIMIT_REASONS.has(reason)
        );
      })
    );
  } catch {
    return false;
  }
}

// Decides whether a 403 is a retryable Drive rate limit. The body is read once
// via a clone so the response passed back to the call site keeps its body
// intact. Body/parse failures fall back to "not a rate limit": a 403 we cannot
// identify is returned as-is, matching the pre-upgrade behavior.
async function isDriveRateLimitResponse(
  ctx: string,
  res: Response,
): Promise<boolean> {
  try {
    const bodyText = await res.clone().text();
    return isDriveRateLimitBody(bodyText);
  } catch (err) {
    logWorkerError(
      "proSync/" + ctx,
      { status: res.status, kind: "rate-limit-body" },
      err,
      "warn",
    );
    return false;
  }
}

// Retry-After as <delay-seconds> (RFC 9110). The HTTP-date form and malformed
// values fall back to the regular exponential backoff.
function parseRetryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get("Retry-After");
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

// fetch() wrapper that applies the shared timeout and classifies transport
// failures (network / timeout / abort). HTTP status is still the caller's job.
// Transient statuses (429 / 5xx, plus 403 whose body reports a Drive rate
// limit) are retried with bounded exponential backoff + jitter, honoring the
// Retry-After header (capped at MAX_RETRY_DELAY_MS), max 3 attempts; 401 is
// returned untouched so the call site's token-refresh flow
// (refreshTokenAndRetry) keeps working, and aborted/timeout fetches are never
// retried.
export async function fetchDrive(
  ctx: string,
  token: string,
  url: URL,
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const kind = classifyWorkerError(err);
      if (kind === "abort") {
        logWorkerError("proSync/" + ctx, { kind }, err, "warn");
        throw new WorkerAbortError(`aborted during ${ctx}`);
      }
      if (kind === "timeout") {
        logWorkerError(
          "proSync/" + ctx,
          { kind, timeoutMs: SYNC_FETCH_TIMEOUT_MS },
          err,
          "error",
        );
      } else {
        logWorkerError("proSync/" + ctx, { kind }, err, "error");
      }
      throw err;
    }

    if (res.ok || attempt >= MAX_TRANSIENT_RETRIES) {
      return res;
    }

    // 429/5xx are transient by status alone; a 403 is transient only when its
    // JSON body identifies a Drive rate limit (rateLimitExceeded /
    // userRateLimitExceeded). Other 403s (permissions…) are not retried.
    const transient =
      isTransientStatus(res.status) ||
      (res.status === 403 && (await isDriveRateLimitResponse(ctx, res)));
    if (!transient) {
      return res;
    }

    const backoffMs = TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** attempt;
    const retryAfterMs = parseRetryAfterSeconds(res);
    const cappedRetryAfterMs =
      retryAfterMs === null
        ? null
        : Math.min(retryAfterMs * 1000, MAX_RETRY_DELAY_MS);
    const jitterMs = Math.floor(Math.random() * (RETRY_JITTER_MAX_MS + 1));
    const delayMs = (cappedRetryAfterMs ?? backoffMs) + jitterMs;
    logWorkerError(
      "proSync/" + ctx,
      {
        kind:
          res.status === 429 || res.status === 403 ? "rate-limit" : "server",
        status: res.status,
        attempt: attempt + 1,
        delayMs,
        ...(cappedRetryAfterMs !== null
          ? { retryAfterMs: cappedRetryAfterMs }
          : {}),
        jitterMs,
      },
      new Error(
        `transient HTTP ${String(res.status)}, retrying in ${String(delayMs)}ms`,
      ),
      "warn",
    );
    await delay(delayMs);
    attempt += 1;
  }
}

// Parse a Drive JSON response, surfacing malformed bodies as a logged failure
// instead of an unhandled rejection that aborts the whole sync.
export async function parseDriveJson<T = Record<string, unknown>>(
  ctx: string,
  res: Response,
): Promise<T> {
  try {
    const data: unknown = await res.json();
    return data as T;
  } catch (err) {
    logWorkerError(
      "proSync/" + ctx,
      { status: res.status, kind: "parse" },
      err,
      "error",
    );
    throw err;
  }
}
