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
import { DRIVE_STREAM_PREFIX } from "./streamPrefetcher";

export const RANGE_CHUNK = 65_536; // aligned chunk size (64KB)
export const HEAD_BYTES = 131_072; // head region read before parsing (128KB)
export const TAIL_BYTES = 1_048_576; // tail region scanned for moov (1MB)
export const BUDGET_CAP = 20 * 1024 * 1024; // max bytes fetched per file (20MB)
export const CONCURRENCY = 3; // max app-wide concurrent range fetches
export const REQUEST_TIMEOUT_MS = 30_000; // per-request timeout
export const MAX_RETRIES = 2; // extra attempts for 5xx/429 (total 3 tries)
const RETRY_BACKOFF_MS = 250;
const MAX_CACHED_CHUNKS = 128; // LRU bound (~8MB at 64KB chunks)
const TOKENIZER_MODULE = "driveRangeTokenizer";

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

function buildRequestSignal(callerSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (callerSignal && typeof AbortSignal.any === "function") {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  return timeoutSignal;
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

  private async getChunk(
    start: number,
  ): Promise<{ chunkStart: number; data: Uint8Array }> {
    const fileSize = this.fileInfo.size ?? 0;
    const chunkStart = start - (start % RANGE_CHUNK);
    const cached = this.chunkCache.get(chunkStart);
    if (cached) return { chunkStart, data: cached };

    const chunkEnd = Math.min(fileSize - 1, chunkStart + RANGE_CHUNK - 1);
    if (chunkStart > chunkEnd) {
      return { chunkStart, data: new Uint8Array(0) };
    }

    const fetchSize = chunkEnd - chunkStart + 1;
    if (this.loadedBytes + fetchSize > this.budgetBytes) {
      throw new BudgetExceededError(this.loadedBytes, this.budgetBytes);
    }

    const data = await this.fetchChunk(chunkStart, chunkEnd);
    this.loadedBytes += data.length;
    this.chunkCache.set(chunkStart, data);
    while (this.chunkCache.size > MAX_CACHED_CHUNKS) {
      const oldest = this.chunkCache.keys().next().value;
      if (oldest === undefined) break;
      this.chunkCache.delete(oldest);
    }
    return { chunkStart, data };
  }

  private async fetchChunk(
    chunkStart: number,
    chunkEnd: number,
  ): Promise<Uint8Array> {
    return rangeFetchSemaphore.run(() =>
      this.fetchChunkWithRetry(chunkStart, chunkEnd),
    );
  }

  private async fetchChunkWithRetry(
    chunkStart: number,
    chunkEnd: number,
  ): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${DRIVE_STREAM_PREFIX}${this.fileId}`, {
          headers: {
            Range: `bytes=${String(chunkStart)}-${String(chunkEnd)}`,
          },
          cache: "no-store",
          signal: buildRequestSignal(this.callerSignal),
        });
      } catch (err: unknown) {
        const kind = classifyFetchError(err);
        if (kind === "timeout") {
          void captureError({
            level: "warn",
            source: TOKENIZER_MODULE,
            message: `range-fetch-timeout (fileId=${this.fileId}, bytes=${String(chunkStart)}-${String(chunkEnd)})`,
          });
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
        const body = await response.arrayBuffer();
        return new Uint8Array(body);
      }
      if (
        attempt < MAX_RETRIES &&
        (response.status === 429 || response.status >= 500)
      ) {
        await sleep(RETRY_BACKOFF_MS * 2 ** (attempt + 1));
        continue;
      }
      throw new RangeNotSupportedError(response.status);
    }
  }
}
