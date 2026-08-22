import { fetchWithAuth } from "./apiClient";
import {
  backoffDelay,
  mergeWithTimeoutSignal,
  readDriveErrorBody,
  shouldRetryDriveResponse,
  sleep,
} from "./driveApi";
import type { DriveFileItem } from "./driveApi";
import { authHeaders } from "./driveFiles";
import {
  QUERY_STATUS_TIMEOUT_MS,
  parseUploadResponseJson,
  resolveConflictOrNull,
  resumeOffsetFromRange,
} from "./resumableSession";
import {
  SessionExpiredError,
  UPLOAD_CHUNK_MAX_RETRIES,
  abortedUploadError,
  mapResumableSessionError,
} from "./uploadTransportErrors";

// Query the status of an existing resumable session (developers.google.com/
// workspace/drive/api/guides/manage-uploads, "Resume an interrupted upload"):
// an empty PUT with Content-Range */<total> asks Drive how much it still holds.
// 200/201 → the upload already completed; 308 + Range → resume at lastByte+1
// on the SAME session; 404 (and any other 4xx — "Handle media upload errors":
// any 4xx during a resumable upload means the session expired) → the session
// is dead. 5xx/429 are retried with backoff like a chunk PUT; an exhausted
// retry is transient — the caller falls back to a fresh session rather than
// failing the upload. Throws SessionExpiredError for dead sessions, UploadError
// for fatal auth/quota, and raw transient errors after retries are exhausted.
type ResumableStatusResult =
  | { status: "done"; file: DriveFileItem }
  | { status: "resume"; offset: number };

export async function queryResumableStatus(
  uploadUri: string,
  token: string,
  totalSize: number,
  callerSignal: AbortSignal | null | undefined,
  clientGeneratedId?: string,
): Promise<ResumableStatusResult> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      // Fresh timeout signal PER attempt (pattern: putChunkWithRetry in
      // uploadFileResumableChunked.ts). ONE signal created at call time would
      // fire at its wall-clock deadline and STAY aborted, killing every later
      // retry of a status query whose total duration (requests + backoff)
      // exceeds QUERY_STATUS_TIMEOUT_MS. Per-attempt signals bound only the
      // current request — and a fresh one after each backoff sleep, so the
      // bound excludes sleep time. The caller's abort still cancels
      // everything via the merge.
      const mergedSignal = mergeWithTimeoutSignal(
        callerSignal,
        QUERY_STATUS_TIMEOUT_MS,
      );
      response = await fetchWithAuth(uploadUri, {
        method: "PUT",
        headers: {
          ...authHeaders(token),
          // The current position is unknown — the wildcard range tells Drive
          // to report how much it received (docs: Content-Range */<total>).
          "Content-Range": `*/${String(totalSize)}`,
        },
        signal: mergedSignal,
        // The PUT is empty — no need for the 120s chunk bound.
        timeoutMs: QUERY_STATUS_TIMEOUT_MS,
      });
    } catch (err) {
      if (callerSignal?.aborted) throw abortedUploadError();
      throw err; // transient — the caller falls back to a fresh session
    }
    if (response.status >= 200 && response.status < 300) {
      // The whole file was received before the interruption — the upload is
      // already DONE; return the file Drive created instead of re-uploading.
      return {
        status: "done",
        file: await parseUploadResponseJson(
          response,
          "query-status-parse-failed",
          "query-status response was not valid JSON",
        ),
      };
    }
    if (response.status === 308) {
      return {
        status: "resume",
        offset: resumeOffsetFromRange(response.headers.get("Range"), totalSize),
      };
    }
    if (response.status === 404) throw new SessionExpiredError();
    if (response.status === 409) {
      // Retry of an idempotent upload whose first attempt completed
      // server-side: the file already exists — resolve DONE with the real
      // file instead of creating a duplicate (same rule as the chunk PUT).
      // Fresh per-attempt merge: the conflict GET is itself bounded
      // per-attempt by driveFetch.
      const file = await resolveConflictOrNull(
        token,
        clientGeneratedId,
        mergeWithTimeoutSignal(callerSignal, QUERY_STATUS_TIMEOUT_MS),
      );
      if (file !== null) return { status: "done", file };
    }
    // 5xx/429 and 403 rate-limits are transient — retried with backoff exactly
    // like a chunk PUT (same retry bound, backoffDelay honors Retry-After; the
    // retryable-status decision is shared via shouldRetryDriveResponse).
    if (
      await shouldRetryDriveResponse(
        response,
        attempt,
        UPLOAD_CHUNK_MAX_RETRIES,
      )
    ) {
      if (attempt < UPLOAD_CHUNK_MAX_RETRIES) {
        // Mirror driveFetch's caller-abort guard (driveHttp.ts) and this
        // function's own catch path above: never sleep into a cancelled
        // caller's backoff — a long Retry-After can park the status query for
        // up to MAX_DELAY_MS just to fire one doomed attempt afterwards (the
        // merged signal would reject it instantly). Exit now through the same
        // aborted-upload error the catch path throws.
        if (!(callerSignal?.aborted ?? false)) {
          await sleep(
            backoffDelay(attempt, response.headers.get("Retry-After")),
          );
          continue;
        }
        throw abortedUploadError();
      }
      // Exhausted — transient, NOT fatal (no UploadError): the caller must
      // still be able to upload, so it falls back to a fresh session from 0.
      throw new Error(
        `query-status retries exhausted (status=${String(response.status)})`,
      );
    }
    // Any other 4xx means the session is dead (Google: any 4xx during a
    // resumable upload must restart from a new session URI). auth and quota
    // are NOT wrapped — a fresh session cannot fix them (same rule as chunk PUTs).
    throw mapResumableSessionError(
      response.status,
      await readDriveErrorBody(response),
    );
  }
}
