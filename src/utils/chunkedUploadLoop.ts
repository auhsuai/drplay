import { fetchWithAuth } from "./apiClient";
import { captureError } from "./errorLog";
import {
  DRIVE_MODULE,
  backoffDelay,
  classifyDriveError,
  mergeWithTimeoutSignal,
  readDriveErrorBody,
  shouldRetryDriveResponse,
  sleep,
} from "./driveApi";
import type { DriveFileItem } from "./driveApi";
import { authHeaders } from "./driveFiles";
import {
  UPLOAD_CHUNK_LEVELS,
  UPLOAD_MIME_TYPE,
  UPLOAD_TIMEOUT_MS,
  parseUploadResponseJson,
  resolveConflictOrNull,
  resumeOffsetFromRange,
  uploadChunkTimeoutMs,
} from "./resumableSession";
import {
  SessionExpiredError,
  UploadError,
  UPLOAD_CHUNK_MAX_RETRIES,
  abortedUploadError,
  mapResumableSessionError,
} from "./uploadTransportErrors";
import type { ChunkedUploadOptions } from "./uploadFileResumableChunked";

// PUT one chunk with bounded retries for 5xx/429 and 403 rate-limits
// (backoffDelay: exponential + jitter, honors Retry-After). Exhausted retries
// throw UploadError('network'); a network rejection (fetch threw) propagates
// raw as transient. Resolves with the final response and the wall-clock
// duration of the attempt that produced it (backoff sleeps excluded) so the
// caller can adapt the chunk size to the measured throughput.
async function putChunkWithRetry(
  uploadUri: string,
  token: string,
  chunk: Uint8Array,
  start: number,
  end: number,
  totalSize: number,
  callerSignal: AbortSignal | null | undefined,
): Promise<{ response: Response; elapsedMs: number }> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    let elapsedMs = 0;
    try {
      // Per-chunk timeout bound: proportional to the chunk size (8 MiB → 128 s,
      // 2 MiB → 32 s, floor 30 s) so a slow link that stepped its chunk down
      // gets a bound that still fits its throughput.
      const chunkTimeoutMs = uploadChunkTimeoutMs(chunk.byteLength);
      // Fresh timeout signal PER attempt (pattern: driveFetch/driveHttp.ts).
      // A single whole-upload signal would fire ONCE at its wall-clock
      // deadline and stay aborted, killing every later request of an upload
      // longer than the bound (the multi-GB slow-link case this file exists
      // for). Per-request signals bound only the current request — and a
      // fresh one after each backoff sleep, so the bound excludes sleep time.
      // The caller's abort still cancels everything via the merge.
      const signal = mergeWithTimeoutSignal(callerSignal, chunkTimeoutMs);
      const startedAt = performance.now();
      response = await fetchWithAuth(uploadUri, {
        method: "PUT",
        headers: {
          ...authHeaders(token),
          "Content-Type": UPLOAD_MIME_TYPE,
          "Content-Range": `bytes ${String(start)}-${String(end)}/${String(totalSize)}`,
        },
        body: chunk,
        signal,
        // fetchWithAuth's per-request timeout stays in sync with the merged
        // per-attempt signal (same bound) so neither fires first.
        timeoutMs: chunkTimeoutMs,
      });
      elapsedMs = performance.now() - startedAt;
    } catch (err) {
      if (callerSignal?.aborted) throw abortedUploadError();
      throw err;
    }
    // 429/5xx are retryable by status alone; a 403 only when its body reports
    // a Drive rate limit (shared decision with the other Drive retry loops via
    // shouldRetryDriveResponse). The body is read via a clone only while
    // retries remain, so the response keeps its body for mapUploadHttpError.
    if (
      !(await shouldRetryDriveResponse(
        response,
        attempt,
        UPLOAD_CHUNK_MAX_RETRIES,
      ))
    ) {
      return { response, elapsedMs };
    }
    // Exhausted budget: TRANSIENT, not an UploadError — mirror
    // queryResumableStatus's own exhaustion (resumableStatus.ts throws a
    // plain "query-status retries exhausted" Error): a plain Error here
    // reaches the session-restart layer (query-status → continue at the
    // confirmed offset / fresh session), exactly like a raw network reset.
    // An UploadError would hit both outer `instanceof UploadError` catches
    // and kill the whole multi-GB file after 3 server hiccups.
    if (attempt >= UPLOAD_CHUNK_MAX_RETRIES) {
      throw new Error(
        `chunk PUT retries exhausted (status=${String(response.status)})`,
      );
    }
    // Mirror resumableStatus's caller-abort guard (and this function's own
    // catch path above): never sleep into a cancelled caller's backoff —
    // a long Retry-After can park the chunk upload for up to MAX_DELAY_MS
    // just to fire one doomed attempt afterwards (the merged signal would
    // reject it instantly). Exit now through the same aborted-upload error
    // the catch path throws.
    if (callerSignal?.aborted ?? false) throw abortedUploadError();
    await sleep(backoffDelay(attempt, response.headers.get("Retry-After")));
  }
}

// A chunk's projected duration may use at most this share of its own timeout
// before the level steps down — 60% leaves headroom for slowdown/jitter inside
// the next chunk without burning the whole bound.
const CHUNK_TIMEOUT_BUDGET_FRACTION = 0.6;

// Adaptive chunk sizing: measure the throughput of a finished chunk PUT and
// return the level index for the NEXT chunk (UPLOAD_CHUNK_LEVELS). A slow
// measurement steps DOWN exactly ONE level (8 MiB → 2 MiB → 512 KiB) — the
// next chunk is measured at ITS OWN size, so a medium link lands and holds on
// 2 MiB instead of jumping straight to the floor (Google manage-uploads:
// "keep the chunk size as large as possible so that the upload is
// efficient"). Never steps up mid-upload — a recovering network keeps its
// smaller chunk (simpler, and a wrong up-step would re-fail the very chunk
// that caused the step-down). `chunkBytes` is the size actually sent (the
// first chunk is always 8 MiB, so its measurement reflects the true link
// speed even when the next level differs).
export function nextChunkLevel(
  levelIndex: number,
  chunkBytes: number,
  elapsedMs: number,
): number {
  // At the floor (512 KiB) there is no smaller level to step to.
  if (levelIndex >= UPLOAD_CHUNK_LEVELS.length - 1) return levelIndex;
  const level = UPLOAD_CHUNK_LEVELS[levelIndex];
  if (level === undefined) return levelIndex;
  const bytesPerMs = chunkBytes / Math.max(elapsedMs, 1);
  // Project the CURRENT level (the chunk just sent) against its own timeout
  // budget. Projecting the NEXT level instead would skip it entirely — its
  // timeout scales linearly with size, so a measurement that fails 8 MiB
  // would also fail 2 MiB and the middle level would never be used.
  const projectedMs = level / bytesPerMs;
  if (
    projectedMs >
    CHUNK_TIMEOUT_BUDGET_FRACTION * uploadChunkTimeoutMs(level)
  ) {
    return levelIndex + 1;
  }
  return levelIndex;
}

// Read the next chunk at the caller-validated boundary: a read failure logs
// (warn) and throws UploadError('invalid') unless the caller aborted; a null/
// empty read before the announced totalSize is a caller bug (EOF early);
// overshooting totalSize (the file grew after the initial stat) is truncated
// to the remaining bytes — the final chunk may be any size (256 KiB multiple
// rule only applies to non-final chunks; no log: this is the SUCCESS path,
// it fires on every growing-file upload).
async function readValidatedChunk(
  opts: ChunkedUploadOptions,
  offset: number,
  sizeHint: number | undefined,
): Promise<Uint8Array> {
  const { totalSize, readChunk, signal } = opts;
  let chunk: Uint8Array | null;
  try {
    chunk = await readChunk(offset, sizeHint);
  } catch (err) {
    if (signal?.aborted) throw abortedUploadError();
    await captureError({
      level: "warn",
      source: DRIVE_MODULE,
      message: `upload-chunk-read-failed (offset=${String(offset)}): ${classifyDriveError(err)}`,
    });
    throw new UploadError("failed to read upload data", "invalid");
  }
  if (chunk === null || chunk.byteLength === 0) {
    throw new UploadError("upload data ended before total size", "invalid");
  }
  if (offset + chunk.byteLength > totalSize) {
    if (offset >= totalSize) {
      // Only reachable through a server anomaly (a 308 full-range is
      // rejected above) — sending anything here would get the session rejected by Google.
      throw new UploadError("upload chunk exceeds total size", "invalid");
    }
    chunk = chunk.slice(0, totalSize - offset);
  }
  return chunk;
}

// Upload one session's worth of chunks. Throws UploadError for fatal errors
// (auth/quota/invalid/aborted), SessionExpiredError for a 4xx/404 (session
// died — the 4xx variant carries the mapped UploadError), and raw transient
// errors — the non-UploadError cases restart the session. startOffset lets a
// query-status resume continue at the server-confirmed byte instead of 0.
export async function uploadChunksInSession(
  uploadUri: string,
  token: string,
  opts: ChunkedUploadOptions,
  startOffset = 0,
): Promise<DriveFileItem> {
  const { totalSize, onProgress, signal } = opts;
  let offset = startOffset;
  // Adaptive chunk level (UPLOAD_CHUNK_LEVELS index): starts at the largest
  // (8 MiB) so fast links keep the historical behavior, then steps DOWN when
  // the measured throughput projects the next chunk beyond its timeout budget
  // (see nextChunkLevel). Per-upload local state — two concurrent uploads
  // each keep their own level, never a module-global. A resumed session
  // starts measuring fresh at 8 MiB (1 upload = 1 level sequence).
  let levelIndex = 0;
  for (;;) {
    if (signal?.aborted) throw abortedUploadError();
    const chunk = await readValidatedChunk(
      opts,
      offset,
      UPLOAD_CHUNK_LEVELS[levelIndex],
    );

    const end = offset + chunk.byteLength - 1;
    const { response, elapsedMs } = await putChunkWithRetry(
      uploadUri,
      token,
      chunk,
      offset,
      end,
      totalSize,
      signal,
    );
    // Adapt BEFORE handling the response: the level applies to the NEXT read
    // whether this chunk was fully received, partially (308), or done (2xx).
    levelIndex = nextChunkLevel(levelIndex, chunk.byteLength, elapsedMs);
    onProgress?.(Math.min(1, (offset + chunk.byteLength) / totalSize));

    if (response.status >= 200 && response.status < 300) {
      return await parseUploadResponseJson(
        response,
        "upload-parse-response-failed",
        "upload response was not valid JSON",
      );
    }
    if (response.status === 308) {
      offset = resumeOffsetFromRange(response.headers.get("Range"), totalSize);
      continue;
    }
    if (response.status === 404) throw new SessionExpiredError();
    if (response.status === 409) {
      // Retry of an idempotent upload whose first attempt completed
      // server-side: the file already exists — resolve DONE with the real
      // file instead of creating a duplicate. Fresh per-call merge (never a
      // shared whole-upload signal); the conflict GET is itself bounded
      // per-attempt by driveFetch.
      const file = await resolveConflictOrNull(
        token,
        opts.clientGeneratedId,
        mergeWithTimeoutSignal(signal, UPLOAD_TIMEOUT_MS),
      );
      if (file !== null) return file;
    }
    // Google: any 4xx (including 403) during a resumable upload means the
    // session expired and must be restarted from a new session URI. auth and
    // quota are NOT wrapped (a fresh session cannot fix them), nor are the
    // internal 'invalid' errors (data ended early, bad JSON…) — those are
    // client-side and restarting would be futile.
    throw mapResumableSessionError(
      response.status,
      await readDriveErrorBody(response),
    );
  }
}
