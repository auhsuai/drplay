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
import {
  RANGE_HEADER_PATTERN,
  UPLOAD_MIME_TYPE,
  UPLOAD_TIMEOUT_MS,
  initiateResumableUpload,
  resolveIdempotentConflict,
} from "./resumableSession";
import { queryResumableStatus } from "./resumableStatus";
import {
  IdempotentConflictError,
  MAX_UPLOAD_ATTEMPTS,
  SESSION_DEAD_STATUS_MAX,
  SESSION_DEAD_STATUS_MIN,
  SessionExpiredError,
  UploadError,
  UPLOAD_CHUNK_MAX_RETRIES,
  abortedUploadError,
  mapUploadHttpError,
  surfaceSessionUploadError,
  uploadAttemptsExhaustedError,
} from "./uploadTransportErrors";

export interface ChunkedUploadOptions {
  name: string;
  parentId: string;
  totalSize: number;
  // Returns the bytes at `offset` (may be shorter than the chunk size for the
  // final chunk), null at end of file. Called again after a 308 resume at the
  // server-reported offset — must support arbitrary offsets.
  readChunk: (offset: number) => Promise<Uint8Array | null>;
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
// raw as transient.
async function putChunkWithRetry(
  uploadUri: string,
  token: string,
  chunk: Uint8Array,
  start: number,
  end: number,
  totalSize: number,
  mergedSignal: AbortSignal,
  callerSignal: AbortSignal | null | undefined,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchWithAuth(uploadUri, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": UPLOAD_MIME_TYPE,
          "Content-Range": `bytes ${String(start)}-${String(end)}/${String(totalSize)}`,
        },
        body: chunk,
        signal: mergedSignal,
        // fetchWithAuth's 15s internal default would kill a slow chunk PUT before the session's 120s bound — keep both in sync.
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
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
    return response;
  }
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
  mergedSignal: AbortSignal,
  startOffset = 0,
): Promise<DriveFileItem> {
  const { totalSize, readChunk, onProgress, signal } = opts;
  let offset = startOffset;
  for (;;) {
    if (signal?.aborted) throw abortedUploadError();
    let chunk: Uint8Array | null;
    try {
      chunk = await readChunk(offset);
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
    const response = await putChunkWithRetry(
      uploadUri,
      token,
      chunk,
      offset,
      end,
      totalSize,
      mergedSignal,
      signal,
    );
    onProgress?.(Math.min(1, (offset + chunk.byteLength) / totalSize));

    if (response.status >= 200 && response.status < 300) {
      try {
        return (await response.json()) as DriveFileItem;
      } catch (err) {
        await captureError({
          level: "error",
          source: DRIVE_MODULE,
          message: `upload-parse-response-failed (status=${String(response.status)}): ${classifyDriveError(err)}`,
        });
        throw new UploadError("upload response was not valid JSON", "invalid");
      }
    }
    if (response.status === 308) {
      const range = response.headers.get("Range");
      const match = range ? RANGE_HEADER_PATTERN.exec(range) : null;
      // "bytes=0-<lastByte>" → next offset = lastByte + 1; no/malformed Range → nothing received, resend from the start (Drive docs).
      offset = match ? Number(match[2]) + 1 : 0;
      if (offset >= totalSize) {
        // 308 claiming the whole file is received without a 200/201 is a
        // server anomaly — continuing would send an out-of-range chunk.
        throw new UploadError(
          "resumable server reported a complete range without completing the upload",
          "invalid",
        );
      }
      continue;
    }
    if (response.status === 404) throw new SessionExpiredError();
    if (response.status === 409 && opts.clientGeneratedId) {
      // Retry of an idempotent upload whose first attempt completed
      // server-side: the file already exists — resolve DONE with the real
      // file instead of creating a duplicate.
      return resolveIdempotentConflict(
        token,
        opts.clientGeneratedId,
        mergedSignal,
      );
    }
    const uploadError = mapUploadHttpError(
      response.status,
      await readDriveErrorBody(response),
    );
    // Google: any 4xx (including 403) during a resumable upload means the
    // session expired and must be restarted from a new session URI. auth and
    // quota are NOT wrapped (a fresh session cannot fix them), nor are the
    // internal 'invalid' errors (data ended early, bad JSON…) — those are
    // client-side and restarting would be futile.
    if (
      uploadError.kind === "invalid" &&
      response.status >= SESSION_DEAD_STATUS_MIN &&
      response.status < SESSION_DEAD_STATUS_MAX
    ) {
      throw new SessionExpiredError(uploadError);
    }
    throw uploadError;
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
  mergedSignal: AbortSignal,
  attempt: number,
): Promise<DriveFileItem | null> {
  let resumeOffset: number | null = null;
  try {
    const status = await queryResumableStatus(
      uploadUri,
      token,
      opts.totalSize,
      mergedSignal,
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
    // session (bounded by MAX_UPLOAD_ATTEMPTS in the caller).
    await captureError({
      level: "warn",
      source: DRIVE_MODULE,
      message: `${err instanceof SessionExpiredError ? "upload-session-expired" : "upload-session-restarted"} (attempt=${String(attempt + 1)}/${String(MAX_UPLOAD_ATTEMPTS)}): query-status: ${classifyDriveError(err)}`,
    });
  }
  if (resumeOffset === null) return null;
  // The session survived the interruption — continue it at the byte the
  // server confirmed instead of re-uploading from 0.
  try {
    return await uploadChunksInSession(
      uploadUri,
      token,
      opts,
      mergedSignal,
      resumeOffset,
    );
  } catch (err) {
    if (opts.signal?.aborted) throw abortedUploadError();
    if (err instanceof UploadError) throw err;
    surfaceSessionUploadError(err, attempt);
    // The resumed session died too and no attempt is left — fail (a fresh
    // initiate in the caller would exceed MAX_UPLOAD_ATTEMPTS).
    if (attempt + 1 >= MAX_UPLOAD_ATTEMPTS) {
      throw uploadAttemptsExhaustedError();
    }
    const expired = err instanceof SessionExpiredError;
    await captureError({
      level: "warn",
      source: DRIVE_MODULE,
      message: `${expired ? "upload-session-expired" : "upload-session-restarted"} (attempt=${String(attempt + 1)}/${String(MAX_UPLOAD_ATTEMPTS)}): ${classifyDriveError(err)}`,
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
  const mergedSignal = mergeWithTimeoutSignal(opts.signal, UPLOAD_TIMEOUT_MS);
  // The session URI lives across iterations so a restart can first ask Drive
  // how much of the session survived (Slice 3) instead of paying for a fresh
  // session URI and re-sending bytes Drive already holds. Slice 5.2: a URI
  // persisted by an earlier run seeds attempt 0 — the resume query runs
  // BEFORE the first initiate.
  let uploadUri: string | null = opts.initialUploadUri ?? null;
  for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt++) {
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
        mergedSignal,
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
        mergedSignal,
        opts.clientGeneratedId,
      );
    } catch (err) {
      if (err instanceof IdempotentConflictError) return err.file;
      if (opts.signal?.aborted) throw abortedUploadError();
      if (err instanceof UploadError) throw err;
      // Initiate exhausted its own retries with a transient failure — try a fresh session (bounded by MAX_UPLOAD_ATTEMPTS).
      if (attempt + 1 < MAX_UPLOAD_ATTEMPTS) {
        await captureError({
          level: "warn",
          source: DRIVE_MODULE,
          message: `upload-session-restarted (attempt=${String(attempt + 1)}/${String(MAX_UPLOAD_ATTEMPTS)}): ${classifyDriveError(err)}`,
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
        message: `upload-session-update-failed (attempt=${String(attempt + 1)}/${String(MAX_UPLOAD_ATTEMPTS)}): ${classifyDriveError(err)}`,
      });
    }
    try {
      return await uploadChunksInSession(uploadUri, token, opts, mergedSignal);
    } catch (err) {
      if (opts.signal?.aborted) throw abortedUploadError();
      if (err instanceof UploadError) throw err;
      surfaceSessionUploadError(err, attempt);
      // Session expired (404/4xx) or transient network/timeout — restart the whole upload from a fresh session URI, bounded by MAX_UPLOAD_ATTEMPTS.
      if (attempt + 1 < MAX_UPLOAD_ATTEMPTS) {
        const expired = err instanceof SessionExpiredError;
        await captureError({
          level: "warn",
          source: DRIVE_MODULE,
          message: `${expired ? "upload-session-expired" : "upload-session-restarted"} (attempt=${String(attempt + 1)}/${String(MAX_UPLOAD_ATTEMPTS)}): ${classifyDriveError(err)}`,
        });
        continue;
      }
      break;
    }
  }
  throw uploadAttemptsExhaustedError();
}
