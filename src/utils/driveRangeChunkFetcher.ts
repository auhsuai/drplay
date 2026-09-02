// HTTP fetch machinery for the DriveRangeTokenizer (refactor: extracted
// verbatim from driveRangeTokenizer.ts — the app-wide CONCURRENCY semaphore,
// the per-tokenizer in-flight chunk dedup, and the retry/circuit-breaker
// state machine over the SW /drive-stream/ proxy). The log source stays
// "driveRangeTokenizer" so existing error-log entries and test assertions
// keep matching; driveRangeTokenizer re-exports the public constants so
// consumer imports keep resolving the exact same names as before.
import { createSemaphore, sleep } from "./asyncLimit";
import {
  isDriveCircuitOpen,
  recordDriveFailure,
  recordDriveSuccess,
} from "./driveRangeCircuitBreaker";
import {
  RangeFetchNetworkError,
  RangeNotSupportedError,
} from "./driveRangeErrors";
import { captureError } from "./errorLog";
import { backoffDelay, mergeWithTimeoutSignal } from "./retryDelay";
import { DRIVE_STREAM_PREFIX } from "./streamPrefetcher";

export const CONCURRENCY = 3; // max app-wide concurrent range fetches
// Per-request timeout. Google Drive media endpoints show a known 30±5s
// first-byte delay under load (rclone forum threads 22681/8320) — the old
// 30s timeout aborted requests exactly AT that boundary, failing when Drive
// was about to deliver. 45s clears the delay range with margin: a slow
// success beats a fast timeout + placeholder (metadata fetch storm fix).
export const REQUEST_TIMEOUT_MS = 45_000;
export const MAX_RETRIES = 2; // extra attempts for 5xx/429 (total 3 tries)
const TIMEOUT_RETRIES = 1; // extra attempt for timeouts (total 2 tries)
const TOKENIZER_MODULE = "driveRangeTokenizer";

// ---- App-wide fetch throttle: at most CONCURRENCY range fetches in flight.
const rangeFetchSemaphore = createSemaphore(CONCURRENCY);

function classifyFetchError(err: unknown): "network" | "timeout" {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError")
      return "timeout";
  }
  return "network";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The exact error every caller-abort exit path throws (the timeout branch's
// shape), so the three abort sites stay textually identical.
function callerAbortTimeoutError(): RangeFetchNetworkError {
  return new RangeFetchNetworkError(
    "timeout",
    `Range fetch timed out after ${String(REQUEST_TIMEOUT_MS)}ms`,
  );
}

function warnTokenizer(message: string): void {
  void captureError({ level: "warn", source: TOKENIZER_MODULE, message });
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
    const promise = rangeFetchSemaphore.run(async () => {
      const data = await this.fetchChunkWithRetry(chunkStart, chunkEnd);
      // Charge the budget exactly once per real fetch — joiners never reach
      // this line, so concurrent readers of one chunk cannot double-charge.
      this.onBytesFetched(data.length);
      return data;
    });
    this.inflightChunks.set(chunkStart, promise);
    try {
      return await promise;
    } finally {
      // Remove only our own entry: a fallback re-registration may have
      // replaced it while this fetch was settling.
      if (this.inflightChunks.get(chunkStart) === promise) {
        this.inflightChunks.delete(chunkStart);
      }
    }
  }

  private throwCircuitOpen(chunkStart: number, chunkEnd: number): never {
    warnTokenizer(
      `range-fetch-circuit-open (fileId=${this.fileId}, bytes=${String(chunkStart)}-${String(chunkEnd)})`,
    );
    throw new RangeFetchNetworkError("timeout", "drive-throttle-circuit-open");
  }

  private async fetchChunkWithRetry(
    chunkStart: number,
    chunkEnd: number,
  ): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt += 1) {
      // Fix H: when the app-wide Drive circuit is open (>= threshold failures
      // in the window), fail fast INSTEAD of fetching — no request, no retry,
      // so a throttled account gets time to recover. The metadata caller
      // treats RangeFetchNetworkError as transient (no placeholder pinning).
      if (isDriveCircuitOpen()) {
        this.throwCircuitOpen(chunkStart, chunkEnd);
      }
      let response: Response;
      try {
        response = await fetch(`${DRIVE_STREAM_PREFIX}${this.fileId}`, {
          headers: {
            Range: `bytes=${String(chunkStart)}-${String(chunkEnd)}`,
          },
          cache: "no-store",
          signal: mergeWithTimeoutSignal(this.callerSignal, REQUEST_TIMEOUT_MS),
        });
      } catch (err: unknown) {
        // Caller-abort (unmount/navigation) is deliberate cancellation, not
        // a transient Drive failure: it must not feed the app-wide circuit
        // breaker (a few quick cancels would otherwise pin the whole app to
        // a placeholder for the cooldown) and it is not a timeout either.
        // Only the internal AbortSignal.timeout() fires AbortError with the
        // caller signal still un-aborted — that one is a real timeout.
        const callerAborted = this.callerSignal?.aborted === true;
        if (!callerAborted) {
          recordDriveFailure();
        }
        const kind = classifyFetchError(err);
        if (kind === "timeout") {
          if (!callerAborted) {
            warnTokenizer(
              `range-fetch-timeout (fileId=${this.fileId}, bytes=${String(chunkStart)}-${String(chunkEnd)})`,
            );
          }
          // Timeouts are usually first-byte latency spikes on large Drive
          // files, so a bounded retry can rescue them. Never retry when the
          // CALLER aborted — that is deliberate cancellation, not a
          // transient failure (an aborted signal makes every retry reject
          // instantly anyway). Retries also stop when the circuit just
          // opened — the failure count is the throttle signal.
          if (
            attempt < TIMEOUT_RETRIES &&
            !(this.callerSignal?.aborted ?? false) &&
            !isDriveCircuitOpen()
          ) {
            await sleep(backoffDelay(attempt));
            continue;
          }
          throw callerAbortTimeoutError();
        }
        warnTokenizer(
          `range-fetch-network-failed (fileId=${this.fileId}, bytes=${String(chunkStart)}-${String(chunkEnd)}): ${errorMessage(err)}`,
        );
        throw new RangeFetchNetworkError("network", errorMessage(err));
      }
      if (response.status === 206) {
        recordDriveSuccess();
        let body: ArrayBuffer;
        try {
          body = await response.arrayBuffer();
        } catch (err: unknown) {
          // Body-stream read failure after the headers arrived (connection
          // reset mid-body on a weak link) is a transient network failure —
          // record it for the circuit breaker and surface it as
          // RangeFetchNetworkError so the metadata caller treats it as
          // transient (never pins the v:9 placeholder).
          // A CALLER abort mid-body (unmount/navigation while the body is
          // still downloading) is deliberate cancellation, not a Drive
          // failure: mirror the fetch-reject catch above (commit bd1abdb) —
          // no recordDriveFailure, no warn, and exit through the same
          // RangeFetchNetworkError("timeout") shape every other abort path
          // uses.
          const callerAborted = this.callerSignal?.aborted === true;
          if (callerAborted) {
            throw callerAbortTimeoutError();
          }
          recordDriveFailure();
          warnTokenizer(
            `range-fetch-body-failed (fileId=${this.fileId}, bytes=${String(chunkStart)}-${String(chunkEnd)}): ${errorMessage(err)}`,
          );
          throw new RangeFetchNetworkError("network", errorMessage(err));
        }
        return new Uint8Array(body);
      }
      if (response.status === 429 || response.status >= 500) {
        // Every 429/5xx attempt feeds the breaker — including the final
        // exhausted one (the old guard skipped it, undercounting 2/3).
        recordDriveFailure();
        if (attempt < MAX_RETRIES) {
          // 429/5xx are the throttle signal itself — once they trip the
          // circuit, do not keep retrying into the cooldown.
          if (isDriveCircuitOpen()) {
            this.throwCircuitOpen(chunkStart, chunkEnd);
          }
          // Mirror the timeout branch's caller-abort handling: never sleep
          // into a cancelled caller's backoff (a Retry-After can park this
          // loop for up to MAX_DELAY_MS) just to fire one doomed attempt
          // afterwards — exit now through the same RangeFetchNetworkError
          // path that branch throws when the CALLER aborted.
          if (!(this.callerSignal?.aborted ?? false)) {
            await sleep(
              backoffDelay(attempt, response.headers.get("Retry-After")),
            );
            continue;
          }
          throw callerAbortTimeoutError();
        }
        // A retry budget exhausted on 429/5xx is still a TRANSIENT throttle
        // failure (RFC 9110 §15.5.5: 429/503 signal a temporary condition).
        // The old RangeNotSupportedError here made fetchPipeline cache the
        // placeholder permanently after a throttle storm; RangeFetchNetworkError
        // keeps the next mount re-fetching instead of pinning v:9.
        throw new RangeFetchNetworkError(
          "network",
          `Drive range fetch throttled (status ${String(response.status)}) after ${String(MAX_RETRIES)} retries`,
        );
      }
      throw new RangeNotSupportedError(response.status);
    }
  }
}
