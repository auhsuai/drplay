// HTTP fetch machinery for the DriveRangeTokenizer (refactor: extracted
// verbatim from driveRangeTokenizer.ts — the app-wide CONCURRENCY semaphore,
// the per-tokenizer in-flight chunk dedup, and the retry/circuit-breaker
// state machine over the SW /drive-stream/ proxy). The log source stays
// "driveRangeTokenizer" so existing error-log entries and test assertions
// keep matching; driveRangeTokenizer re-exports the public constants so
// consumer imports keep resolving the exact same names as before.
//
// Phase A contract (pinned by driveRangeChunkFetcher.test.ts):
// - ONE logical range operation ⇒ exactly ONE breaker outcome. The retry loop
//   below is internal: attempts are not charged, only the final outcome is.
// - Errors are classified through the discriminated taxonomy in
//   driveRangeErrors (timeout / network / rate_limited / http_error /
//   circuit_open / aborted). A circuit rejection is never reported as a
//   timeout, and a caller cancellation is never a failure at all.
// - Only 429 / confirmed Drive rate-limit 403 feed the breaker as "throttle".
//   Timeouts and network errors are "transient" — they never open it.
// - Half-open: the admission gate grants exactly one probe (see
//   driveRangeCircuitBreaker); this class asks once per logical operation.
//
// Timeout scope (explicit): REQUEST_TIMEOUT_MS starts when the request is
// dispatched and covers the upstream request INCLUDING the response-body read.
// It does NOT cover the queue wait in the app-wide semaphore — that wait is
// cancelled by the caller's signal (see asyncLimit).
//
// Metadata purpose marker: every request carries `X-DrPlay-Purpose: metadata`
// so the service worker can bypass its audio byte cache (`drplay-bytes`).
import { createSemaphore } from "./asyncLimit";
import {
  extractGoogleApiReason,
  isRateLimitReason,
  RangeFetchNetworkError,
  RangeNotSupportedError,
} from "./driveRangeErrors";
import type { DriveFailureSignal } from "./driveRangeCircuitBreaker";
import {
  admitDriveCircuitOperation,
  recordDriveFailure,
  recordDriveSuccess,
  releaseDriveCircuitProbe,
} from "./driveRangeCircuitBreaker";
import { captureError } from "./errorLog";
import { backoffDelay, mergeWithTimeoutSignal, sleep } from "./retryDelay";
import { DRIVE_STREAM_PREFIX } from "./streamPrefetcher";

export const CONCURRENCY = 3; // max app-wide concurrent range fetches
// Per-request timeout. Google Drive media endpoints show a known 30±5s
// first-byte delay under load (rclone forum threads 22681/8320) — the old
// 30s timeout aborted requests exactly AT that boundary, failing when Drive
// was about to deliver. 45s clears the delay range with margin: a slow
// success beats a fast timeout + placeholder (metadata fetch storm fix).
// Scope: request + body (see the header comment).
export const REQUEST_TIMEOUT_MS = 45_000;
export const MAX_RETRIES = 2; // extra attempts for 5xx/429 (total 3 tries)
const TIMEOUT_RETRIES = 1; // extra attempt for timeouts (total 2 tries)
const TOKENIZER_MODULE = "driveRangeTokenizer";
/** Marks metadata ranges for the service worker (bypasses drplay-bytes). */
export const METADATA_PURPOSE_HEADER = "X-DrPlay-Purpose";
export const METADATA_PURPOSE_VALUE = "metadata";

// ---- App-wide fetch throttle: at most CONCURRENCY range fetches in flight.
const rangeFetchSemaphore = createSemaphore(CONCURRENCY);

// ---- Phase C diagnostics: aggregate counters only (no per-request logging).
// Holds no ids, no tokens and no metadata content, so it is safe to surface
// in an error report. Includes timing TOTALS (queue wait / TTFB / transfer) so
// a report can show WHERE the time went without a log line per request.
export interface DriveRangeStats {
  /** Logical range operations started (one outcome each). */
  operations: number;
  /** Upstream HTTP requests actually issued (attempts, retries included). */
  requests: number;
  /** Retries performed (requests - operations). */
  retries: number;
  /** Bytes successfully delivered. */
  bytes: number;
  timeouts: number;
  networkErrors: number;
  rateLimited: number;
  httpErrors: number;
  aborted: number;
  /** Operations rejected by the breaker without touching the network. */
  breakerRejected: number;
  /** Cumulative ms spent waiting for a semaphore slot. */
  queueWaitMs: number;
  /** Cumulative ms from request dispatch to response headers. */
  ttfbMs: number;
  /** Cumulative ms from response headers to the body being fully read. */
  transferMs: number;
}

export const driveRangeStats: DriveRangeStats = {
  operations: 0,
  requests: 0,
  retries: 0,
  bytes: 0,
  timeouts: 0,
  networkErrors: 0,
  rateLimited: 0,
  httpErrors: 0,
  aborted: 0,
  breakerRejected: 0,
  queueWaitMs: 0,
  ttfbMs: 0,
  transferMs: 0,
};

/** Test-only: zeroes the aggregate counters (module-level, like the breaker). */
export function resetDriveRangeStatsForTests(): void {
  for (const key of Object.keys(driveRangeStats) as Array<
    keyof DriveRangeStats
  >) {
    driveRangeStats[key] = 0;
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Structured, one-line failure detail composed from the aggregate counters
 * (Phase C): kind, status, range, retries, bytes and timings. Never includes
 * a token, auth header or metadata content.
 */
function failureDetail(parts: {
  kind: string;
  status?: number;
  attempt: number;
  queueWaitMs: number;
  ttfbMs: number;
  transferMs: number;
  aborted: boolean;
}): string {
  const total = parts.queueWaitMs + parts.ttfbMs + parts.transferMs;
  return [
    `kind=${parts.kind}`,
    parts.status !== undefined ? `status=${String(parts.status)}` : null,
    `attempts=${String(parts.attempt + 1)}`,
    `queueWaitMs=${String(Math.round(parts.queueWaitMs))}`,
    `ttfbMs=${String(Math.round(parts.ttfbMs))}`,
    `transferMs=${String(Math.round(parts.transferMs))}`,
    `totalMs=${String(Math.round(total))}`,
    `aborted=${String(parts.aborted)}`,
  ]
    .filter((p): p is string => p !== null)
    .join(", ");
}

function isTimeoutLike(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reads a Drive 403 body's `error.errors[].reason` via a clone so the
 * response handed back to the caller keeps its body intact. Any clone/parse
 * failure returns null — an unreadable body is NEVER guessed into a throttle
 * classification (it stays a deterministic http_error, as before).
 */
async function readRateLimitReason(response: Response): Promise<string | null> {
  try {
    const cloned = response.clone();
    const body: unknown = await cloned.json();
    return extractGoogleApiReason(body);
  } catch {
    return null;
  }
}

/**
 * Owns one tokenizer's fetch plumbing: in-flight chunk fetches keyed by
 * aligned chunkStart — a read racing an already-running fetch of the same
 * chunk joins it instead of issuing a second request (which would
 * double-charge the per-file fetch budget) — and charges the budget via
 * onBytesFetched exactly once per real fetch.
 */
export class RangeChunkFetcher {
  private readonly fileId: string;
  private readonly callerSignal: AbortSignal | undefined;
  private readonly onBytesFetched: (byteCount: number) => void;
  private readonly inflightChunks = new Map<number, Promise<Uint8Array>>();

  constructor(
    fileId: string,
    callerSignal: AbortSignal | undefined,
    onBytesFetched: (byteCount: number) => void,
  ) {
    this.fileId = fileId;
    this.callerSignal = callerSignal;
    this.onBytesFetched = onBytesFetched;
  }

  async fetch(chunkStart: number, chunkEnd: number): Promise<Uint8Array> {
    const inFlight = this.inflightChunks.get(chunkStart);
    if (inFlight) {
      const data = await inFlight;
      // Join only when the in-flight fetch covers this request. A prefetchRange
      // whose first chunk ends mid-chunk resolves short here — it has settled
      // and left the map, so fetch the full extent ourselves (never serve
      // short data for a chunk read).
      if (data.length >= chunkEnd - chunkStart + 1) return data;
      return this.fetch(chunkStart, chunkEnd);
    }
    // A cancelled caller must not occupy a slot: the semaphore drops a queued
    // waiter on abort instead of letting it drain a slot for a doomed request.
    // Queue wait is measured OUTSIDE the per-request timeout (see the module
    // header): it is reported in diagnostics only, never charged to TTFB.
    const enqueuedAt = nowMs();
    const promise = rangeFetchSemaphore.run(async () => {
      const queueWaitMs = nowMs() - enqueuedAt;
      driveRangeStats.queueWaitMs += queueWaitMs;
      const data = await this.fetchChunkWithRetry(
        chunkStart,
        chunkEnd,
        queueWaitMs,
      );
      // Charge the budget exactly once per real fetch — joiners never reach
      // this line, so concurrent readers of one chunk cannot double-charge.
      this.onBytesFetched(data.length);
      driveRangeStats.bytes += data.length;
      return data;
    }, this.callerSignal);
    this.inflightChunks.set(chunkStart, promise);
    try {
      return await promise;
    } catch (err: unknown) {
      // The semaphore rejects with the caller's RAW signal reason when the
      // abort lands while queued. Normalize it to the typed `aborted` error
      // so every cancellation path has ONE shape (and so a raw DOMException
      // never leaks into fetchPipeline's classification).
      if (
        this.callerSignal?.aborted === true &&
        !(err instanceof RangeFetchNetworkError)
      ) {
        driveRangeStats.aborted += 1;
        throw new RangeFetchNetworkError(
          "aborted",
          "Range fetch aborted by caller",
        );
      }
      throw err;
    } finally {
      // Remove only our own entry: a fallback re-registration may have
      // replaced it while this fetch was settling.
      if (this.inflightChunks.get(chunkStart) === promise) {
        this.inflightChunks.delete(chunkStart);
      }
    }
  }

  private throwCircuitOpen(chunkStart: number, chunkEnd: number): never {
    driveRangeStats.breakerRejected += 1;
    void captureError({
      level: "warn",
      source: TOKENIZER_MODULE,
      message: `range-fetch-circuit-open (fileId=${this.fileId}, bytes=${String(chunkStart)}-${String(chunkEnd)})`,
    });
    // Own kind — NEVER reported as a timeout: the caller must be able to tell
    // "Drive throttled the account" from "this file is slow".
    throw new RangeFetchNetworkError(
      "circuit_open",
      "drive-throttle-circuit-open",
    );
  }

  /**
   * Final breaker bookkeeping for one logical operation.
   * `signal === null` means "no breaker evidence" (cancellation, or a
   * deterministic 4xx): nothing is charged, and a half-open probe is handed
   * back so the next operation can claim it.
   */
  private chargeOutcome(signal: DriveFailureSignal | null): void {
    if (signal === null) {
      releaseDriveCircuitProbe();
      return;
    }
    recordDriveFailure(signal);
  }

  private async fetchChunkWithRetry(
    chunkStart: number,
    chunkEnd: number,
    queueWaitMs: number,
  ): Promise<Uint8Array> {
    driveRangeStats.operations += 1;
    // ONE admission check per logical operation (see the breaker contract).
    const admission = admitDriveCircuitOperation();
    if (admission === "rejected") {
      this.throwCircuitOpen(chunkStart, chunkEnd);
    }
    let requestsThisOp = 0;
    const bytesLabel = `${String(chunkStart)}-${String(chunkEnd)}`;
    for (let attempt = 0; ; attempt += 1) {
      requestsThisOp += 1;
      driveRangeStats.requests += 1;
      if (requestsThisOp > 1) driveRangeStats.retries += 1;
      const dispatchedAt = nowMs();
      let response: Response;
      try {
        response = await fetch(`${DRIVE_STREAM_PREFIX}${this.fileId}`, {
          headers: {
            Range: `bytes=${bytesLabel}`,
            [METADATA_PURPOSE_HEADER]: METADATA_PURPOSE_VALUE,
          },
          cache: "no-store",
          signal: mergeWithTimeoutSignal(this.callerSignal, REQUEST_TIMEOUT_MS),
        });
      } catch (err: unknown) {
        const ttfbMs = nowMs() - dispatchedAt;
        driveRangeStats.ttfbMs += ttfbMs;
        // Caller-abort (unmount/navigation) is deliberate cancellation, not
        // a transient Drive failure: it must not feed the app-wide circuit
        // breaker and it is not a timeout either. Only the internal
        // AbortSignal.timeout() fires AbortError with the caller signal still
        // un-aborted — that one is a real timeout.
        if (this.callerSignal?.aborted === true) {
          driveRangeStats.aborted += 1;
          this.chargeOutcome(null);
          throw new RangeFetchNetworkError(
            "aborted",
            "Range fetch aborted by caller",
          );
        }
        if (isTimeoutLike(err)) {
          driveRangeStats.timeouts += 1;
          void captureError({
            level: "warn",
            source: TOKENIZER_MODULE,
            message: `range-fetch-timeout (fileId=${this.fileId}, bytes=${bytesLabel}, ${failureDetail({ kind: "timeout", attempt, queueWaitMs, ttfbMs, transferMs: 0, aborted: false })})`,
          });
          // Timeouts are usually first-byte latency spikes on large Drive
          // files, so a bounded retry can rescue them.
          if (attempt < TIMEOUT_RETRIES) {
            // The sleep is signal-cancellable: an abort mid-backoff rejects
            // at once and is then reported as a cancellation, not a timeout.
            try {
              await sleep(backoffDelay(attempt), this.callerSignal);
            } catch {
              driveRangeStats.aborted += 1;
              this.chargeOutcome(null);
              throw new RangeFetchNetworkError(
                "aborted",
                "Range fetch aborted by caller",
              );
            }
            continue;
          }
          // ONE outcome for the whole logical op (both attempts included).
          this.chargeOutcome("transient");
          throw new RangeFetchNetworkError(
            "timeout",
            `Range fetch timed out after ${String(REQUEST_TIMEOUT_MS)}ms`,
          );
        }
        driveRangeStats.networkErrors += 1;
        void captureError({
          level: "warn",
          source: TOKENIZER_MODULE,
          message: `range-fetch-network-failed (fileId=${this.fileId}, bytes=${bytesLabel}, ${failureDetail({ kind: "network", attempt, queueWaitMs, ttfbMs, transferMs: 0, aborted: false })}): ${errorMessage(err)}`,
        });
        this.chargeOutcome("transient");
        throw new RangeFetchNetworkError("network", errorMessage(err));
      }
      const ttfbMs = nowMs() - dispatchedAt;
      driveRangeStats.ttfbMs += ttfbMs;
      if (response.status === 206) {
        let body: ArrayBuffer;
        const bodyStartedAt = nowMs();
        try {
          body = await response.arrayBuffer();
        } catch (err: unknown) {
          const transferMs = nowMs() - bodyStartedAt;
          driveRangeStats.transferMs += transferMs;
          // Body-stream read failure after the headers arrived (connection
          // reset mid-body on a weak link) is a transient network failure.
          // A CALLER abort mid-body is deliberate cancellation: no breaker
          // evidence, same "aborted" exit shape as every other cancel path.
          if (this.callerSignal?.aborted === true) {
            driveRangeStats.aborted += 1;
            this.chargeOutcome(null);
            throw new RangeFetchNetworkError(
              "aborted",
              "Range fetch aborted by caller",
            );
          }
          driveRangeStats.networkErrors += 1;
          void captureError({
            level: "warn",
            source: TOKENIZER_MODULE,
            message: `range-fetch-body-failed (fileId=${this.fileId}, bytes=${bytesLabel}, ${failureDetail({ kind: "network", status: response.status, attempt, queueWaitMs, ttfbMs, transferMs, aborted: false })}): ${errorMessage(err)}`,
          });
          this.chargeOutcome("transient");
          throw new RangeFetchNetworkError("network", errorMessage(err));
        }
        driveRangeStats.transferMs += nowMs() - bodyStartedAt;
        // Success AFTER the body landed: one outcome per logical operation.
        recordDriveSuccess();
        return new Uint8Array(body);
      }
      // Google handle-errors: a 403 whose body reports a Drive usage-limit
      // reason (userRateLimitExceeded / rateLimitExceeded / quotaExceeded) is
      // the same throttle condition as a 429. Any other 403 (permissions…) is
      // NOT throttling and keeps falling through to the deterministic
      // RangeNotSupportedError below: no retry, no breaker feed.
      const rateLimitReason =
        response.status === 403 ? await readRateLimitReason(response) : null;
      const throttled =
        response.status === 429 || isRateLimitReason(rateLimitReason);
      if (throttled || response.status >= 500) {
        if (throttled) driveRangeStats.rateLimited += 1;
        else driveRangeStats.networkErrors += 1;
        if (attempt < MAX_RETRIES) {
          // Mirror the timeout branch's caller-abort handling: the backoff
          // sleep is signal-cancellable (a Retry-After can park this loop for
          // up to 32s), so an abort mid-sleep exits immediately as a cancel.
          try {
            await sleep(
              backoffDelay(attempt, response.headers.get("Retry-After")),
              this.callerSignal,
            );
          } catch {
            driveRangeStats.aborted += 1;
            this.chargeOutcome(null);
            throw new RangeFetchNetworkError(
              "aborted",
              "Range fetch aborted by caller",
            );
          }
          continue;
        }
        // Retry budget exhausted: ONE diagnostic line + ONE breaker outcome
        // for the logical op (never one log per internal attempt).
        if (throttled) {
          void captureError({
            level: "warn",
            source: TOKENIZER_MODULE,
            message: `range-fetch-throttled (fileId=${this.fileId}, bytes=${bytesLabel}, ${failureDetail({ kind: "rate_limited", status: response.status, attempt, queueWaitMs, ttfbMs, transferMs: 0, aborted: false })}${rateLimitReason ? `, reason=${rateLimitReason}` : ""})`,
          });
          this.chargeOutcome("throttle");
          throw new RangeFetchNetworkError(
            "rate_limited",
            `Drive range fetch throttled (status ${String(response.status)}${rateLimitReason ? `, reason ${rateLimitReason}` : ""}) after ${String(MAX_RETRIES)} retries`,
            response.status,
          );
        }
        this.chargeOutcome("transient");
        throw new RangeFetchNetworkError(
          "network",
          `Drive range fetch failed (status ${String(response.status)}) after ${String(MAX_RETRIES)} retries`,
          response.status,
        );
      }
      driveRangeStats.httpErrors += 1;
      void captureError({
        level: "warn",
        source: TOKENIZER_MODULE,
        message: `range-fetch-http-error (fileId=${this.fileId}, bytes=${bytesLabel}, ${failureDetail({ kind: "http_error", status: response.status, attempt, queueWaitMs, ttfbMs, transferMs: 0, aborted: false })})`,
      });
      // A deterministic 4xx is NOT throttle evidence, but it IS the end of
      // this logical operation: release a half-open probe so the next op can
      // probe (otherwise the probe flag would stay set forever and the
      // circuit would reject traffic after a successful recovery).
      this.chargeOutcome(null);
      throw new RangeNotSupportedError(response.status);
    }
  }
}
