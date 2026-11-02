// Typed fetch-error classes for the DriveRangeTokenizer (refactor: extracted
// verbatim from driveRangeTokenizer.ts — same messages, same names, re-exported
// by the tokenizer facade so consumer imports keep resolving unchanged).
//
// Every failure carries a discriminated `kind` so a caller (fetchPipeline) can
// tell a transient network problem from a global throttle, a deliberate
// cancellation or a deterministic protocol failure WITHOUT parsing messages.
// The taxonomy is closed on purpose: adding a kind is a deliberate decision
// that must also decide its retry/cooldown semantics.
export type RangeFailureKind =
  | "timeout" // request/body exceeded REQUEST_TIMEOUT_MS
  | "network" // fetch rejected, body stream broke, 5xx exhausted
  | "rate_limited" // 429 or a Drive rate-limit 403 (bounded retries spent)
  | "http_error" // deterministic 4xx (permission/not-found/…) — never retried
  | "circuit_open" // app-wide throttle breaker rejected without fetching
  | "aborted" // caller cancellation (unmount/navigation) — not a failure
  | "parse_error" // budget/parse failure (deterministic for this file)
  | "unsupported"; // server ignored Range / format not parseable

/** Kinds a RangeChunkFetcher can raise (parse_error stays pipeline-side). */
export type RangeFetchFailureKind = Extract<
  RangeFailureKind,
  "timeout" | "network" | "rate_limited" | "circuit_open" | "aborted"
>;

// Google Drive reports usage limits as 403 with one of these
// `error.errors[].reason` values (developers.google.com/drive/api/guides/handle-errors).
// This is the CLASSIFICATION set, a deliberate superset of driveTypes'
// DRIVE_RATE_LIMIT_REASONS retry set: quotaExceeded is a throttle signal for
// diagnostics/breaker purposes, but retrying a daily quota is futile, so the
// API client's retry detector keeps its narrower set.
export const RATE_LIMIT_ERROR_REASONS: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
]);

export class SizeUnknownError extends Error {
  constructor(message = "File size is unknown; metadata fetch is skipped") {
    super(message);
    this.name = "SizeUnknownError";
  }
}

export class RangeNotSupportedError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Server did not honor the Range request (status ${String(status)})`);
    this.name = "RangeNotSupportedError";
    this.status = status;
  }

  /**
   * 416 (range not satisfiable) means the BYTES were rejected; anything else
   * in the 4xx family is an HTTP-level refusal. Both are deterministic (no
   * retry, placeholder pinned), but the log/diagnostics keep them apart.
   */
  get kind(): "http_error" | "unsupported" {
    return this.status >= 400 && this.status !== 416
      ? "http_error"
      : "unsupported";
  }
}

export class BudgetExceededError extends Error {
  readonly kind = "parse_error" as const;
  constructor(loadedBytes: number, capBytes: number) {
    super(
      `Range fetch budget exceeded (loaded ${String(loadedBytes)} bytes, cap ${String(capBytes)} bytes)`,
    );
    this.name = "BudgetExceededError";
  }
}

export class RangeFetchNetworkError extends Error {
  readonly kind: RangeFetchFailureKind;
  /** Upstream HTTP status when the failure came from a response. */
  readonly status: number | undefined;
  constructor(kind: RangeFetchFailureKind, message: string, status?: number) {
    super(message);
    this.name = "RangeFetchNetworkError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Extracts the first Google API `error.errors[].reason` string (falling back
 * to the legacy top-level `error.reason`) from a parsed 403/429 JSON body.
 * Returns null for anything unexpected — a body that cannot be interpreted
 * must never be guessed into a throttle classification.
 */
export function extractGoogleApiReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const reasons = (error as { errors?: unknown }).errors;
  if (Array.isArray(reasons)) {
    for (const entry of reasons) {
      if (typeof entry !== "object" || entry === null) continue;
      const reason = (entry as { reason?: unknown }).reason;
      if (typeof reason === "string" && reason.length > 0) return reason;
    }
  }
  const legacy = (error as { reason?: unknown }).reason;
  return typeof legacy === "string" && legacy.length > 0 ? legacy : null;
}

/** True when a Google error reason denotes account/usage throttling. */
export function isRateLimitReason(reason: string | null): boolean {
  return reason !== null && RATE_LIMIT_ERROR_REASONS.has(reason);
}

/**
 * Classifies an upstream HTTP failure into the taxonomy above. 429 and a
 * rate-limit 403 are the only GLOBAL throttle signals; 5xx is a transient
 * server/network condition (retried, but it must not open the global
 * breaker); any other status is a deterministic HTTP failure.
 */
export function classifyDriveHttpStatus(
  status: number,
  reason: string | null,
): "rate_limited" | "network" | "http_error" {
  if (status === 429) return "rate_limited";
  if (status === 403 && isRateLimitReason(reason)) return "rate_limited";
  if (status >= 500) return "network";
  return "http_error";
}
