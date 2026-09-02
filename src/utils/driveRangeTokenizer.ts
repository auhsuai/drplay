// strtok3-compatible random-access tokenizer over Google Drive media via the
// service worker's /drive-stream/ proxy (public/sw.js forwards the Range
// header and injects the Authorization token  -  the main thread never sees a
// credential here). Fetches only aligned 64KB chunks, caches them in an LRU,
// bounds the total bytes fetched per file (BUDGET_CAP) and the app-wide
// concurrent fetch count (CONCURRENCY 3), and classifies failures so the
// metadata caller can fall back to a placeholder.
//
// Refactor layout (behavior unchanged): the chunk-LRU lives in
// ./driveRangeChunkCache and the HTTP fetch machinery (app-wide semaphore,
// in-flight dedup, retry/circuit-breaker state machine) in
// ./driveRangeChunkFetcher; this file keeps the public surface — the
// tokenizer class, the constants, and the re-exports — so every consumer and
// the vitest mock specifier "./driveRangeTokenizer" keeps resolving the
// exact same names as before.
import { AbstractTokenizer } from "strtok3";
import type { IFileInfo, IReadChunkOptions, ITokenizerOptions } from "strtok3";
import { EndOfStreamError } from "strtok3";
import { BudgetExceededError, SizeUnknownError } from "./driveRangeErrors";
import { AlignedChunkCache, MAX_CACHED_CHUNKS } from "./driveRangeChunkCache";
import { RangeChunkFetcher } from "./driveRangeChunkFetcher";

// The circuit-breaker state machine (Fix H) and the typed fetch-error classes
// live in their own modules (same folder); this file re-exports their whole
// public surface so every consumer — and the vitest mock specifier
// "./driveRangeTokenizer" — keeps resolving the exact same names as before.
export {
  DRIVE_COOLDOWN_MS,
  DRIVE_FAILURE_THRESHOLD,
  DRIVE_FAILURE_WINDOW_MS,
  isDriveCircuitOpen,
  recordDriveFailure,
  recordDriveSuccess,
  resetDriveCircuitBreakerForTests,
} from "./driveRangeCircuitBreaker";
export {
  BudgetExceededError,
  RangeFetchNetworkError,
  RangeNotSupportedError,
  SizeUnknownError,
} from "./driveRangeErrors";
export {
  CONCURRENCY,
  MAX_RETRIES,
  REQUEST_TIMEOUT_MS,
} from "./driveRangeChunkFetcher";

export const RANGE_CHUNK = 65_536; // aligned chunk size (64KB)
export const HEAD_BYTES = 131_072; // head region read before parsing (128KB)
export const TAIL_BYTES = 1_048_576; // tail region scanned for moov (1MB)
export const BUDGET_CAP = 20 * 1024 * 1024; // max bytes fetched per file (20MB)

export interface DriveRangeTokenizerOptions extends ITokenizerOptions {
  /** Override the 20MB per-file fetch budget (tests). */
  budgetBytes?: number;
}

function alignedChunkStart(position: number): number {
  return position - (position % RANGE_CHUNK);
}

/**
 * Random-access tokenizer for music-metadata's parseFromTokenizer. All reads
 * are served from an aligned-chunk LRU cache; a miss fetches the covering
 * 64KB-aligned chunk through the SW /drive-stream/ proxy with a Range header.
 * Position-only operations (ignore, setPosition) never touch the network  -
 * this is what lets a moov-at-end M4A be parsed without downloading mdat.
 */
export class DriveRangeTokenizer extends AbstractTokenizer {
  private readonly budgetBytes: number;
  private readonly chunkCache = new AlignedChunkCache();
  private readonly chunkFetcher: RangeChunkFetcher;
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
    this.budgetBytes = options.budgetBytes ?? BUDGET_CAP;
    this.chunkFetcher = new RangeChunkFetcher(
      fileId,
      options.abortSignal,
      (byteCount) => {
        this.loadedBytes += byteCount;
      },
    );
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
    this.assertBudget(fetchLen);
    const data = await this.chunkFetcher.fetch(0, fetchLen - 1);
    // Populate the aligned chunk cache so parse-time reads inside the head
    // region are served without extra requests. Same invariant as
    // prefetchRange below: a trailing PARTIAL chunk may be cached only when
    // it ends at EOF (no bytes exist beyond it); elsewhere it is left
    // uncached so a later read past the prefetched region re-fetches the
    // full chunk instead of being silently truncated at the short entry's
    // edge (possible once headBytes is not a multiple of RANGE_CHUNK, or
    // the server returns a short body mid-file).
    const reachedEof = data.length >= fileSize;
    for (let start = 0; start < data.length; start += RANGE_CHUNK) {
      const slice = data.subarray(start, start + RANGE_CHUNK);
      if (slice.length < RANGE_CHUNK && !reachedEof) continue;
      this.chunkCache.set(start, slice);
    }
    this.chunkCache.evict();
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
    const firstChunk = alignedChunkStart(fetchStart);
    const lastChunk = alignedChunkStart(fetchEnd - 1);
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
    this.assertBudget(fetchSize);
    const data = await this.chunkFetcher.fetch(firstChunk, fetchEnd - 1);
    for (
      let chunkStart = firstChunk;
      chunkStart <= lastChunk;
      chunkStart += RANGE_CHUNK
    ) {
      const chunkEnd = chunkStart + RANGE_CHUNK;
      const fullyCovered = chunkEnd <= fetchEnd;
      const endsAtEof = chunkStart === lastChunk && fetchEnd === fileSize;
      if (!fullyCovered && !endsAtEof) continue;
      const existing = this.chunkCache.peek(chunkStart);
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
    this.chunkCache.evict();
    return data.subarray(fetchStart - firstChunk, fetchEnd - firstChunk);
  }

  private assertBudget(fetchSize: number): void {
    if (this.loadedBytes + fetchSize > this.budgetBytes) {
      throw new BudgetExceededError(this.loadedBytes, this.budgetBytes);
    }
  }

  private async getChunk(
    start: number,
  ): Promise<{ chunkStart: number; data: Uint8Array }> {
    const fileSize = this.fileInfo.size ?? 0;
    const chunkStart = alignedChunkStart(start);
    const cached = this.chunkCache.get(chunkStart);
    if (cached) return { chunkStart, data: cached };

    const chunkEnd = Math.min(fileSize - 1, chunkStart + RANGE_CHUNK - 1);
    if (chunkStart > chunkEnd) {
      return { chunkStart, data: new Uint8Array(0) };
    }

    this.assertBudget(chunkEnd - chunkStart + 1);
    const data = await this.chunkFetcher.fetch(chunkStart, chunkEnd);
    // A joined in-flight fetch (prefetchRange/prefetchHead) can cover more
    // than this chunk — cache only the chunk's own extent so cache entries
    // keep their exact-chunk shape (a short EOF body stays short, as before).
    const chunkData = data.subarray(
      0,
      Math.min(data.length, chunkEnd - chunkStart + 1),
    );
    this.chunkCache.set(chunkStart, chunkData);
    this.chunkCache.evict();
    return { chunkStart, data: chunkData };
  }
}
