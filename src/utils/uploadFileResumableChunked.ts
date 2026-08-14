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
  initiateResumableUpload,
  parseUploadResponseJson,
  resolveConflictOrNull,
  resumeOffsetFromRange,
  uploadChunkTimeoutMs,
} from "./resumableSession";
import { queryResumableStatus } from "./resumableStatus";
import {
  IdempotentConflictError,
  CHUNKED_SESSION_MAX_ATTEMPTS,
  SessionExpiredError,
  UploadError,
  UPLOAD_CHUNK_MAX_RETRIES,
  abortedUploadError,
  mapResumableSessionError,
  surfaceSessionUploadError,
  uploadAttemptsExhaustedError,
} from "./uploadTransportErrors";

export interface ChunkedUploadOptions {
  name: string;
  parentId: string;
  totalSize: number;
  // Returns the bytes at `offset` — at most `sizeHint` bytes (shorter only
  // for the final chunk), null at end of file. Called again after a 308
  // resume at the server-reported offset — must support arbitrary offsets.
  // sizeHint is the adaptive chunk level (UPLOAD_CHUNK_LEVELS) the uploader
  // currently sends: the reader may return fewer bytes than the disk stream
  // read, keeping the rest for the next call.
  readChunk: (offset: number, sizeHint?: number) => Promise<Uint8Array | null>;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal | undefined;
  // Pre-generated file id (see UploadFileOptions): set ONCE per logical upload
  // so session restarts inside this function stay bound to the same id.
  clientGeneratedId?: string | undefined;
  // A session URI persisted by an earlier run (slice 5.2): attempt 0 runs
  // query-status on it instead of initiating a fresh session — a surviving
  // session resumes at the server-confirmed byte, a dead one (404) restarts.
  initialUploadUri?: string | undefined;
  // Called after EVERY successful initiate with the new session URI so the
  // caller can persist it (best-effort resume metadata). NOT called on a
  // resume path that skips initiate. A throwing callback is caught and logged
  // here — persisting must never break the upload.
  onSessionUpdate?: (uploadUri: string) => void;
}

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
      await shouldRetryDriveResponse(
        response,
        attempt,
        UPLOAD_CHUNK_MAX_RETRIES,
      )
    ) {
      if (attempt < UPLOAD_CHUNK_MAX_RETRIES) {
        await sleep(backoffDelay(attempt, response.headers.get("Retry-After")));
        continue;
      }
      throw new UploadError(
        `upload failed (status=${String(response.status)})`,
        "network",
      );
    }
    return { response, elapsedMs };
  }
}

// A chunk's projected duration may use at most this share of its own timeout
// before the level steps down — 60% leaves headroom for slowdown/jitter inside
// the next chunk without burning the whole bound.
const CHUNK_TIMEOUT_BUDGET_FRACTION = 0.6;

// Adaptive chunk sizing: measure the throughput of a finished chunk PUT and
// return the level index for the NEXT chunk (UPLOAD_CHUNK_LEVELS). Steps DOWN
// (8 MiB → 2 MiB → 512 KiB) while the current level is projected to outlast
// its timeout budget; never steps up mid-upload — a recovering network keeps
// its smaller chunk (simpler, and a wrong up-step would re-fail the very
// chunk that caused the step-down). `chunkBytes` is the size actually sent
// (the first chunk is always 8 MiB, so its measurement reflects the true
// link speed even when the next level differs).
export function nextChunkLevel(
  levelIndex: number,
  chunkBytes: number,
  elapsedMs: number,
): number {
  const bytesPerMs = chunkBytes / Math.max(elapsedMs, 1);
  let idx = levelIndex;
  while (idx < UPLOAD_CHUNK_LEVELS.length - 1) {
    const level = UPLOAD_CHUNK_LEVELS[idx];
    if (level === undefined) break;
    const projectedMs = level / bytesPerMs;
    if (
      projectedMs <=
      CHUNK_TIMEOUT_BUDGET_FRACTION * uploadChunkTimeoutMs(level)
    )
      break;
    idx++;
  }
  return idx;
}

// Upload one session's worth of chunks. Throws UploadError for fatal errors
// (auth/quota/invalid/aborted), SessionExpiredError for a 4xx/404 (session
// died — the 4xx variant carries the mapped UploadError), and raw transient
// errors — the non-UploadError cases restart the session. startOffset lets a
// query-status resume continue at the server-confirmed byte instead of 0.
async function uploadChunksInSession(
  uploadUri: string,
  token: string,
  opts: ChunkedUploadOptions,
  startOffset = 0,
): Promise<DriveFileItem> {
  const { totalSize, readChunk, onProgress, signal } = opts;
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
    let chunk: Uint8Array | null;
    try {
      chunk = await readChunk(offset, UPLOAD_CHUNK_LEVELS[levelIndex]);
    } catch (err) {
      if (signal?.aborted) throw abortedUploadError();
      await captureError({
        level: "warn",
        source: DRIVE_MODULE,
        message: `upload-chunk-read-failed (offset=${String(offset)}): ${classifyDriveError(err)}`,
      });
      throw new UploadError("failed to read upload data", "invalid");
    }
    // null/empty before the announced totalSize is a caller bug (EOF early);
    // overshooting the totalSize would make Google reject the session.
    if (chunk === null || chunk.byteLength === 0) {
      throw new UploadError("upload data ended before total size", "invalid");
    }
    if (offset + chunk.byteLength > totalSize) {
      if (offset >= totalSize) {
        // Only reachable through a server anomaly (a 308 full-range is
        // rejected above) — sending anything here would get the session rejected by Google.
        throw new UploadError("upload chunk exceeds total size", "invalid");
      }
      // The file grew after the initial stat so readChunk streams past
      // totalSize. Truncate to the remaining bytes — the final chunk may be
      // any size (256 KiB multiple rule only applies to non-final chunks).
      // No log: this is the SUCCESS path (fires on every growing-file upload).
      chunk = chunk.slice(0, totalSize - offset);
    }

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

// Slice 3: a previous attempt left a resumable session behind — query its
// status before initiating a NEW one. Returns the file when the upload
// already completed or the resumed session ran to the end; null when the
// session is dead/transient (or the status query failed) and the caller must
// restart from a fresh session URI — never block the upload. Fatal
// UploadError/abort propagate; a wrapped 4xx on the LAST attempt is surfaced
// via surfaceSessionUploadError, and exhausted attempts throw the same
// "upload failed after N attempts" error the caller would.
async function resumePreviousSessionOrNull(
  uploadUri: string,
  token: string,
  opts: ChunkedUploadOptions,
  attempt: number,
): Promise<DriveFileItem | null> {
  let resumeOffset: number | null = null;
  try {
    const status = await queryResumableStatus(
      uploadUri,
      token,
      opts.totalSize,
      // Per-attempt merges happen INSIDE queryResumableStatus (fresh
      // QUERY_STATUS_TIMEOUT_MS signal per request, refreshed after each
      // backoff sleep so the bound excludes sleep time) — only the caller's
      // abort flows down. A signal merged here would be shared by every
      // attempt of the query loop, firing once and staying aborted (the same
      // bug the per-request chunk signals fixed).
      opts.signal,
      opts.clientGeneratedId,
    );
    if (status.status === "done") return status.file;
    resumeOffset = status.offset;
  } catch (err) {
    if (opts.signal?.aborted) throw abortedUploadError();
    // auth/quota are fatal — a fresh session cannot fix them.
    if (err instanceof UploadError) throw err;
    // Dead session or transient query failure — restart with a fresh
    // session (bounded by CHUNKED_SESSION_MAX_ATTEMPTS in the caller).
    await captureError({
      level: "warn",
      source: DRIVE_MODULE,
      message: `${err instanceof SessionExpiredError ? "upload-session-expired" : "upload-session-restarted"} (attempt=${String(attempt + 1)}/${String(CHUNKED_SESSION_MAX_ATTEMPTS)}): query-status: ${classifyDriveError(err)}`,
    });
  }
  if (resumeOffset === null) return null;
  // The session survived the interruption — continue it at the byte the
  // server confirmed instead of re-uploading from 0.
  try {
    return await uploadChunksInSession(uploadUri, token, opts, resumeOffset);
  } catch (err) {
    if (opts.signal?.aborted) throw abortedUploadError();
    if (err instanceof UploadError) throw err;
    surfaceSessionUploadError(err, attempt);
    // The resumed session died too and no attempt is left — fail (a fresh
    // initiate in the caller would exceed CHUNKED_SESSION_MAX_ATTEMPTS).
    if (attempt + 1 >= CHUNKED_SESSION_MAX_ATTEMPTS) {
      throw uploadAttemptsExhaustedError();
    }
    const expired = err instanceof SessionExpiredError;
    await captureError({
      level: "warn",
      source: DRIVE_MODULE,
      message: `${expired ? "upload-session-expired" : "upload-session-restarted"} (attempt=${String(attempt + 1)}/${String(CHUNKED_SESSION_MAX_ATTEMPTS)}): ${classifyDriveError(err)}`,
    });
    return null;
  }
}

// Upload file bytes via the chunked resumable protocol: memory stays bounded
// at chunk size regardless of totalSize (fixes the multi-GB RAM spike of
// whole-file uploads). Bytes come from the injected readChunk.
export async function uploadFileResumableChunked(
  token: string,
  opts: ChunkedUploadOptions,
): Promise<DriveFileItem> {
  if (opts.signal?.aborted) throw abortedUploadError();
  if (!(opts.totalSize > 0)) {
    // Google's resumable docs define no Content-Range format for empty files (same rule as uploadFileResumable).
    throw new UploadError("cannot upload an empty file", "invalid");
  }
  // NOTE: no whole-upload timeout signal. ONE AbortSignal.timeout at upload
  // start would fire at its wall-clock deadline and STAY aborted — every
  // later request (later chunks, query-status, initiate) would reject
  // instantly, killing any upload whose TOTAL duration exceeds
  // UPLOAD_TIMEOUT_MS (the multi-GB slow-link case this file exists for).
  // Each request bounds itself per-request instead: chunk PUTs and
  // query-status via their own merges (UPLOAD_TIMEOUT_MS /
  // QUERY_STATUS_TIMEOUT_MS), initiate + conflict-GET via driveFetch's
  // per-attempt bound — only the caller's abort signal flows down.
  // The session URI lives across iterations so a restart can first ask Drive
  // how much of the session survived (Slice 3) instead of paying for a fresh
  // session URI and re-sending bytes Drive already holds. Slice 5.2: a URI
  // persisted by an earlier run seeds attempt 0 — the resume query runs
  // BEFORE the first initiate.
  let uploadUri: string | null = opts.initialUploadUri ?? null;
  for (let attempt = 0; attempt < CHUNKED_SESSION_MAX_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) throw abortedUploadError();

    // Slice 3: a previous attempt left a session behind — query its status
    // before initiating a NEW one. 200/201 → already done; 308 + Range →
    // resume the SAME session at the server-confirmed byte; dead (404/4xx) or
    // transient (5xx/429 retries exhausted, network) → fall through to a
    // fresh initiate below — never block the upload. The condition is
    // `uploadUri !== null` (NOT `attempt > 0`) so attempt 0 with a persisted
    // initialUploadUri goes through the same resume path.
    if (uploadUri !== null) {
      const resumed = await resumePreviousSessionOrNull(
        uploadUri,
        token,
        opts,
        attempt,
      );
      if (resumed !== null) return resumed;
    }

    try {
      uploadUri = await initiateResumableUpload(
        token,
        opts.name,
        opts.parentId,
        opts.totalSize,
        // Fresh per-call merge; the POST itself is bounded per-attempt by
        // driveFetch (20s default) — this only carries the caller's abort.
        mergeWithTimeoutSignal(opts.signal, UPLOAD_TIMEOUT_MS),
        opts.clientGeneratedId,
      );
    } catch (err) {
      if (err instanceof IdempotentConflictError) return err.file;
      if (opts.signal?.aborted) throw abortedUploadError();
      if (err instanceof UploadError) throw err;
      // Initiate exhausted its own retries with a transient failure — try a fresh session (bounded by CHUNKED_SESSION_MAX_ATTEMPTS).
      if (attempt + 1 < CHUNKED_SESSION_MAX_ATTEMPTS) {
        await captureError({
          level: "warn",
          source: DRIVE_MODULE,
          message: `upload-session-restarted (attempt=${String(attempt + 1)}/${String(CHUNKED_SESSION_MAX_ATTEMPTS)}): ${classifyDriveError(err)}`,
        });
        continue;
      }
      break;
    }
    // Slice 5.2: hand the live session URI to the caller so it can persist
    // resume metadata. Best-effort — a throwing callback is caught and logged,
    // never allowed to break the upload.
    try {
      opts.onSessionUpdate?.(uploadUri);
    } catch (err) {
      await captureError({
        level: "warn",
        source: DRIVE_MODULE,
        message: `upload-session-update-failed (attempt=${String(attempt + 1)}/${String(CHUNKED_SESSION_MAX_ATTEMPTS)}): ${classifyDriveError(err)}`,
      });
    }
    try {
      return await uploadChunksInSession(uploadUri, token, opts);
    } catch (err) {
      if (opts.signal?.aborted) throw abortedUploadError();
      if (err instanceof UploadError) throw err;
      surfaceSessionUploadError(err, attempt);
      // Session expired (404/4xx) or transient network/timeout — restart the whole upload from a fresh session URI, bounded by CHUNKED_SESSION_MAX_ATTEMPTS.
      if (attempt + 1 < CHUNKED_SESSION_MAX_ATTEMPTS) {
        const expired = err instanceof SessionExpiredError;
        await captureError({
          level: "warn",
          source: DRIVE_MODULE,
          message: `${expired ? "upload-session-expired" : "upload-session-restarted"} (attempt=${String(attempt + 1)}/${String(CHUNKED_SESSION_MAX_ATTEMPTS)}): ${classifyDriveError(err)}`,
        });
        continue;
      }
      break;
    }
  }
  throw uploadAttemptsExhaustedError();
}
