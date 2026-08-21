// strtok3-compatible random-access tokenizer over Google Drive media via the
// service worker's /drive-stream/ proxy (public/sw.js forwards the Range
// header and injects the Authorization token  -  the main thread never sees a
// credential here). Fetches only aligned 64KB chunks, caches them in an LRU,
// bounds the total bytes fetched per file (BUDGET_CAP) and the app-wide
// concurrent fetch count (CONCURRENCY 3), and classifies failures so the
// metadata caller can fall back to a placeholder.
import { AbstractTokenizer } from "strtok3";
import type { IFileInfo, IReadChunkOptions, ITokenizerOptions } from "strtok3";
import { EndOfStreamError } from "strtok3";
import { createSemaphore, sleep } from "./asyncLimit";
import { captureError } from "./errorLog";
import { backoffDelay, mergeWithTimeoutSignal } from "./retryDelay";
import { DRIVE_STREAM_PREFIX } from "./streamPrefetcher";

export const RANGE_CHUNK = 65_536; // aligned chunk size (64KB)
export const HEAD_BYTES = 131_072; // head region read before parsing (128KB)
export const TAIL_BYTES = 1_048_576; // tail region scanned for moov (1MB)
export const BUDGET_CAP = 20 * 1024 * 1024; // max bytes fetched per file (20MB)
export const CONCURRENCY = 3; // max app-wide concurrent range fetches
// Per-request timeout. Google Drive media endpoints show a known 30±5s
// first-byte delay under load (rclone forum threads 22681/8320) — the old
// 30s timeout aborted requests exactly AT that boundary, failing when Drive
// was about to deliver. 45s clears the delay range with margin: a slow
// success beats a fast timeout + placeholder (metadata fetch storm fix).
export const REQUEST_TIMEOUT_MS = 45_000;
export const MAX_RETRIES = 2; // extra attempts for 5xx/429 (total 3 tries)
const TIMEOUT_RETRIES = 1; // extra attempt for timeouts (total 2 tries)
const MAX_CACHED_CHUNKS = 128; // LRU bound (~8MB at 64KB chunks)
const TOKENIZER_MODULE = "driveRangeTokenizer";

// ---- Drive throttle circuit breaker (Fix H).
// When Drive starts throttling an account (429s / timeouts under load), every
// retry and every cover POST keeps hammering it — the metadata pipeline's
// 30s timeout + retry (Fix B) actually SUSTAINED the auto-next loop. The
// breaker trips after DRIVE_FAILURE_THRESHOLD failures inside a sliding
// DRIVE_FAILURE_WINDOW_MS window, then fails fast for DRIVE_COOLDOWN_MS so the
// account can recover. State is module-level (shared app-wide, like
// rangeFetchSemaphore) because the throttle is per-account, not per-file.
export const DRIVE_FAILURE_THRESHOLD = 3;
export const DRIVE_FAILURE_WINDOW_MS = 30_000;
export const DRIVE_COOLDOWN_MS = 60_000;
const driveFailureTimes: number[] = [];
let driveCircuitOpenedAt: number | null = null;

function pruneDriveFailures(now: number): void {
  while (
    driveFailureTimes.length > 0 &&
    now - (driveFailureTimes[0] ?? 0) > DRIVE_FAILURE_WINDOW_MS
  ) {
    driveFailureTimes.shift();
  }
}

/** Records one failed range fetch (timeout / network / 5xx / 429). */
export function recordDriveFailure(): void {
  const now = Date.now();
  pruneDriveFailures(now);
  driveFailureTimes.push(now);
  if (
    driveCircuitOpenedAt === null &&
    driveFailureTimes.length >= DRIVE_FAILURE_THRESHOLD
  ) {
    driveCircuitOpenedAt = now;
    void captureError({
      level: "warn",
      source: TOKENIZER_MODULE,
      message: `drive-throttle-circuit-opened (failures=${String(driveFailureTimes.length)} in ${String(DRIVE_FAILURE_WINDOW_MS)}ms)`,
    });
  }
}

/**
 * Records one successful range fetch. A success only prunes stale failures
 * — it never closes an open circuit early (a success cannot even happen
 * while the circuit is open, because no fetch runs during the cooldown).
 */
export function recordDriveSuccess(): void {
  pruneDriveFailures(Date.now());
}

/**
 * True when the breaker is open: the circuit stays open for the full
 * DRIVE_COOLDOWN_MS after it tripped, then closes and resets the failure
 * history so the account gets a fresh chance.
 */
export function isDriveCircuitOpen(): boolean {
  const now = Date.now();
  if (driveCircuitOpenedAt !== null) {
    if (now - driveCircuitOpenedAt < DRIVE_COOLDOWN_MS) return true;
    driveCircuitOpenedAt = null;
    driveFailureTimes.length = 0;
  } else {
    pruneDriveFailures(now);
  }
  return false;
}

/** Test-only: drops all breaker state (module-level, shared across tests). */
export function resetDriveCircuitBreakerForTests(): void {
  driveFailureTimes.length = 0;
  driveCircuitOpenedAt = null;
}

export class SizeUnknownError extends Error {
  constructor(message = "File size is unknown; metadata fetch is skipped") {
    super(message);
    this.name = "SizeUnknownError";
  }
}

export class RangeNotSupportedError extends Error {
  constructor(status: number) {
    super(`Server did not honor the Range request (status ${String(status)})`);
    this.name = "RangeNotSupportedError";
  }
}

export class BudgetExceededError extends Error {
  constructor(loadedBytes: number, capBytes: number) {
    super(
      `Range fetch budget exceeded (loaded ${String(loadedBytes)} bytes, cap ${String(capBytes)} bytes)`,
    );
    this.name = "BudgetExceededError";
  }
}

export class RangeFetchNetworkError extends Error {
  readonly kind: "network" | "timeout";
  constructor(kind: "network" | "timeout", message: string) {
    super(message);
    this.name = "RangeFetchNetworkError";
    this.kind = kind;
  }
}

export interface DriveRangeTokenizerOptions extends ITokenizerOptions {
  /** Override the 20MB per-file fetch budget (tests). */
  budgetBytes?: number;
}

// ---- App-wide fetch throttle: at most CONCURRENCY range fetches in flight.
const rangeFetchSemaphore = createSemaphore(CONCURRENCY);

function classifyFetchError(err: unknown): "network" | "timeout" {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError")
      return "timeout";
  }
  return "network";
}

/**
 * Random-access tokenizer for music-metadata's parseFromTokenizer. All reads
 * are served from an aligned-chunk LRU cache; a miss fetches the covering
 * 64KB-aligned chunk through the SW /drive-stream/ proxy with a Range header.
 * Position-only operations (ignore, setPosition) never touch the network  -
 * this is what lets a moov-at-end M4A be parsed without downloading mdat.
 */
export class DriveRangeTokenizer extends AbstractTokenizer {
  private readonly fileId: string;
  private readonly budgetBytes: number;
  private readonly callerSignal: AbortSignal | undefined;
  private readonly chunkCache = new Map<number, Uint8Array>();
  // In-flight chunk fetches keyed by aligned chunkStart: a read racing an
  // already-running fetch of the same chunk joins it instead of issuing a
  // second request (which would double-charge the per-file fetch budget).
  private readonly inflightChunks = new Map<number, Promise<Uint8Array>>();
  private loadedBytes = 0;
  override fileInfo: IFileInfo = { size: 0 };

  constructor(
    fileId: string,
    size: number,
    options: DriveRangeTokenizerOptions = {},
  ) {
    super(options);
    if (!Number.isFinite(size) || size <= 0) {
      throw new SizeUnknownError();
    }
    this.fileId = fileId;
    this.budgetBytes = options.budgetBytes ?? BUDGET_CAP;
    this.callerSignal = options.abortSignal;
    this.fileInfo = { size };
  }

  override supportsRandomAccess(): boolean {
    return true;
  }

  setPosition(position: number): void {
    this.position = position;
  }

  override async readBuffer(
    uint8Array: Uint8Array,
    options?: IReadChunkOptions,
  ): Promise<number> {
    if (options?.position !== undefined) {
      this.position = options.position;
    }
    const bytesRead = await this.peekBuffer(uint8Array, options);
    this.position += bytesRead;
    return bytesRead;
  }

  override async peekBuffer(
    uint8Array: Uint8Array,
    options?: IReadChunkOptions,
  ): Promise<number> {
    const norm = this.normalizeOptions(uint8Array, options);
    const fileSize = this.fileInfo.size ?? 0;
    const start = norm.position;
    const bytesAvailable = Math.max(0, fileSize - start);
    const bytes2read = Math.min(bytesAvailable, norm.length);
    if (!norm.mayBeLess && bytes2read < norm.length) {
      throw new EndOfStreamError();
    }
    if (bytes2read <= 0) return 0;
    // A requested range can span two aligned chunks (e.g. 100 bytes starting
    // 64 bytes before the next boundary) — loop chunk by chunk. Each chunk is
    // indexed chunk-relative (`cursor - chunkStart`), never file-absolute.
    let remaining = bytes2read;
    let cursor = start;
    let written = 0;
    while (remaining > 0) {
      const { chunkStart, data } = await this.getChunk(cursor);
      const localStart = cursor - chunkStart;
      const available = Math.max(0, data.length - localStart);
      if (available <= 0) break; // server returned a short chunk — stop at EOF
      const chunkBytes = Math.min(available, remaining);
      uint8Array.set(
        data.subarray(localStart, localStart + chunkBytes),
        written,
      );
      written += chunkBytes;
      cursor += chunkBytes;
      remaining -= chunkBytes;
    }
    return written;
  }

  /**
   * Read an absolute [start, end) range without moving the tokenizer position.
   * Reads may be shorter than requested at EOF; the caller decides.
   */
  async readRange(start: number, endExclusive: number): Promise<Uint8Array> {
    const len = Math.max(
      0,
      Math.min(endExclusive, this.fileInfo.size ?? 0) - start,
    );
    const out = new Uint8Array(len);
    if (len === 0) return out;
    const bytesRead = await this.peekBuffer(out, {
      position: start,
      length: len,
      mayBeLess: true,
    });
    return out.subarray(0, bytesRead);
  }

  /**
   * Fetch the file head [0, headBytes) in ONE range request and seed the chunk
   * cache from it. Every metadata load reads the head before parsing; splitting
   * it into two 64KB chunks doubled the requests each load must survive — for
   * large files with slow first-byte latency every extra request is a fresh
   * timeout risk (the range-fetch-timeout storm seen on >200MB files).
   */
  async prefetchHead(headBytes: number): Promise<Uint8Array> {
    const fileSize = this.fileInfo.size ?? 0;
    const fetchLen = Math.max(0, Math.min(headBytes, fileSize));
    if (fetchLen <= 0) return new Uint8Array(0);
    if (this.loadedBytes + fetchLen > this.budgetBytes) {
      throw new BudgetExceededError(this.loadedBytes, this.budgetBytes);
    }
    const data = await this.fetchChunk(0, fetchLen - 1);
    // Populate the aligned chunk cache so parse-time reads inside the head
    // region are served without extra requests. A trailing partial chunk is
    // safe: the prefetched region always ends at min(headBytes, fileSize), so
    // any later read lands either inside it or in a fully-fetched chunk beyond.
    for (let start = 0; start < data.length; start += RANGE_CHUNK) {
      this.chunkCache.set(start, data.subarray(start, start + RANGE_CHUNK));
    }
    this.evictOldestChunks();
    return data.subarray(0, fetchLen);
  }

  /**
   * Fetch an arbitrary [start, endExclusive) region in ONE range request and
   * seed the aligned chunk cache from it — the same single-request win
   * prefetchHead gives the head, applied to regions the parser reads next
   * (ID3v2 tag bodies past the head, the m4a tail). Without it every read
   * outside the head fell into getChunk's 64KB-per-request loop (a 600KB tag
   * cost ~9 requests, a 1MB m4a tail scan 16), and with the app-wide
   * CONCURRENCY-3 semaphore those requests queued for minutes on big folders.
   *
   * The fetch is extended DOWN to the covering 64KB boundary so every seeded
   * chunk starts at its aligned index (a cache entry must never start
   * mid-chunk — peekBuffer indexes chunk-relative). A trailing partial chunk
   * is cached only when it ends at EOF (no bytes exist beyond it); elsewhere
   * it is left uncached so a later read past the region refetches instead of
   * silently truncating. Throws BudgetExceededError when the region would
   * exceed the per-file budget (same contract as prefetchHead); the caller
   * falls back to chunked reads on any failure.
   */
  async prefetchRange(
    start: number,
    endExclusive: number,
  ): Promise<Uint8Array> {
    const fileSize = this.fileInfo.size ?? 0;
    const fetchStart = Math.max(0, Math.min(start, fileSize));
    const fetchEnd = Math.min(Math.max(fetchStart, endExclusive), fileSize);
    const fetchLen = Math.max(0, fetchEnd - fetchStart);
    if (fetchLen <= 0) return new Uint8Array(0);
    const firstChunk = fetchStart - (fetchStart % RANGE_CHUNK);
    const lastChunk = fetchEnd - 1 - ((fetchEnd - 1) % RANGE_CHUNK);
    const chunkCount = (lastChunk - firstChunk) / RANGE_CHUNK + 1;
    // The LRU holds MAX_CACHED_CHUNKS chunks; seeding more than it can keep
    // is self-defeating: every evicted chunk is re-fetched by the parse,
    // double-spending the fetch budget (a 25MB tag prefetch + re-fetch of
    // the evicted 8MB+ thrashed past the raised budget into a placeholder).
    // Skip when the seed cannot survive; the caller's chunked reads then
    // behave exactly as before this method existed (a silent no-op, not an
    // error — like the EOF clamp above).
    if (this.chunkCache.size + chunkCount > MAX_CACHED_CHUNKS) {
      return new Uint8Array(0);
    }
    const fetchSize = fetchEnd - firstChunk;
    if (this.loadedBytes + fetchSize > this.budgetBytes) {
      throw new BudgetExceededError(this.loadedBytes, this.budgetBytes);
    }
    const data = await this.fetchChunk(firstChunk, fetchEnd - 1);
    for (
      let chunkStart = firstChunk;
      chunkStart <= lastChunk;
      chunkStart += RANGE_CHUNK
    ) {
      const chunkEnd = chunkStart + RANGE_CHUNK;
      const fullyCovered = chunkEnd <= fetchEnd;
      const endsAtEof = chunkStart === lastChunk && fetchEnd === fileSize;
      if (!fullyCovered && !endsAtEof) continue;
      const existing = this.chunkCache.get(chunkStart);
      const sliceStart = Math.max(firstChunk, chunkStart);
      const sliceEnd = Math.min(fetchEnd, chunkEnd);
      const slice = data.subarray(
        sliceStart - firstChunk,
        sliceEnd - firstChunk,
      );
      if (!existing || slice.length > existing.length) {
        this.chunkCache.set(chunkStart, slice);
      }
    }
    this.evictOldestChunks();
    return data.subarray(fetchStart - firstChunk, fetchEnd - firstChunk);
  }

  private async getChunk(
    start: number,
  ): Promise<{ chunkStart: number; data: Uint8Array }> {
    const fileSize = this.fileInfo.size ?? 0;
    const chunkStart = start - (start % RANGE_CHUNK);
    const cached = this.chunkCache.get(chunkStart);
    if (cached) {
      // Map preserves insertion order, so delete+set on a hit "moves to the
      // end": the first key is now the least-recently-used one, making the
      // eviction below a true LRU (hot chunks survive repeated seeking).
      this.chunkCache.delete(chunkStart);
      this.chunkCache.set(chunkStart, cached);
      return { chunkStart, data: cached };
    }

    const chunkEnd = Math.min(fileSize - 1, chunkStart + RANGE_CHUNK - 1);
    if (chunkStart > chunkEnd) {
      return { chunkStart, data: new Uint8Array(0) };
    }

    const fetchSize = chunkEnd - chunkStart + 1;
    if (this.loadedBytes + fetchSize > this.budgetBytes) {
      throw new BudgetExceededError(this.loadedBytes, this.budgetBytes);
    }

    const data = await this.fetchChunk(chunkStart, chunkEnd);
    // A joined in-flight fetch (prefetchRange/prefetchHead) can cover more
    // than this chunk — cache only the chunk's own extent so cache entries
    // keep their exact-chunk shape (a short EOF body stays short, as before).
    const chunkData = data.subarray(
      0,
      Math.min(data.length, chunkEnd - chunkStart + 1),
    );
    this.chunkCache.set(chunkStart, chunkData);
    this.evictOldestChunks();
    return { chunkStart, data: chunkData };
  }

  private evictOldestChunks(): void {
    while (this.chunkCache.size > MAX_CACHED_CHUNKS) {
      const oldest = this.chunkCache.keys().next().value;
      if (oldest === undefined) break;
      this.chunkCache.delete(oldest);
    }
  }

  private async fetchChunk(
    chunkStart: number,
    chunkEnd: number,
  ): Promise<Uint8Array> {
    const inFlight = this.inflightChunks.get(chunkStart);
    if (inFlight) {
      const data = await inFlight;
      // Join only when the in-flight fetch covers this request. A prefetchRange
      // whose first chunk ends mid-chunk resolves short here — it has settled
      // and left the map, so fetch the full extent ourselves (never serve
      // short data for a chunk read).
      if (data.length >= chunkEnd - chunkStart + 1) return data;
      return this.fetchChunk(chunkStart, chunkEnd);
    }
    const promise = rangeFetchSemaphore.run(async () => {
      const data = await this.fetchChunkWithRetry(chunkStart, chunkEnd);
      // Charge the budget exactly once per real fetch — joiners never reach
      // this line, so concurrent readers of one chunk cannot double-charge.
      this.loadedBytes += data.length;
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
    void captureError({
      level: "warn",
      source: TOKENIZER_MODULE,
      message: `range-fetch-circuit-open (fileId=${this.fileId}, bytes=${String(chunkStart)}-${String(chunkEnd)})`,
    });
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
            void captureError({
              level: "warn",
              source: TOKENIZER_MODULE,
              message: `range-fetch-timeout (fileId=${this.fileId}, bytes=${String(chunkStart)}-${String(chunkEnd)})`,
            });
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
          throw new RangeFetchNetworkError(
            "timeout",
            `Range fetch timed out after ${String(REQUEST_TIMEOUT_MS)}ms`,
          );
        }
        void captureError({
          level: "warn",
          source: TOKENIZER_MODULE,
          message: `range-fetch-network-failed (fileId=${this.fileId}, bytes=${String(chunkStart)}-${String(chunkEnd)}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        throw new RangeFetchNetworkError(
          "network",
          err instanceof Error ? err.message : String(err),
        );
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
          recordDriveFailure();
          void captureError({
            level: "warn",
            source: TOKENIZER_MODULE,
            message: `range-fetch-body-failed (fileId=${this.fileId}, bytes=${String(chunkStart)}-${String(chunkEnd)}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          throw new RangeFetchNetworkError(
            "network",
            err instanceof Error ? err.message : String(err),
          );
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
          await sleep(
            backoffDelay(attempt, response.headers.get("Retry-After")),
          );
          continue;
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
