import { captureError } from "./errorLog";
import {
  DRIVE_MODULE,
  classifyDriveError,
  mergeWithTimeoutSignal,
} from "./driveApi";
import type { DriveFileItem } from "./driveApi";
import { UPLOAD_TIMEOUT_MS, initiateResumableUpload } from "./resumableSession";
import {
  IdempotentConflictError,
  CHUNKED_SESSION_MAX_ATTEMPTS,
  SessionExpiredError,
  UploadError,
  abortedUploadError,
  surfaceSessionUploadError,
  uploadAttemptsExhaustedError,
} from "./uploadTransportErrors";
import { queryResumableStatus } from "./resumableStatus";
import { uploadChunksInSession } from "./chunkedUploadLoop";

export { nextChunkLevel } from "./chunkedUploadLoop";

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

// The five session-restart warn logs share one message shape — only the label
// (expired vs restarted vs update-failed) and an optional subject prefix
// ("query-status: ") differ.
function restartLogMessage(
  label: string,
  attempt: number,
  detail: string,
): string {
  return `${label} (attempt=${String(attempt + 1)}/${String(CHUNKED_SESSION_MAX_ATTEMPTS)}): ${detail}`;
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
      message: restartLogMessage(
        err instanceof SessionExpiredError
          ? "upload-session-expired"
          : "upload-session-restarted",
        attempt,
        `query-status: ${classifyDriveError(err)}`,
      ),
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
      message: restartLogMessage(
        expired ? "upload-session-expired" : "upload-session-restarted",
        attempt,
        classifyDriveError(err),
      ),
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
          message: restartLogMessage(
            "upload-session-restarted",
            attempt,
            classifyDriveError(err),
          ),
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
        message: restartLogMessage(
          "upload-session-update-failed",
          attempt,
          classifyDriveError(err),
        ),
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
          message: restartLogMessage(
            expired ? "upload-session-expired" : "upload-session-restarted",
            attempt,
            classifyDriveError(err),
          ),
        });
        continue;
      }
      break;
    }
  }
  throw uploadAttemptsExhaustedError();
}
