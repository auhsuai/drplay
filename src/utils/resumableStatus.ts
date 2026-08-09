import { fetchWithAuth } from "./apiClient";
import { captureError } from "./errorLog";
import {
  backoffDelay,
  DRIVE_MODULE,
  classifyDriveError,
  readDriveErrorBody,
  shouldRetryDriveResponse,
  sleep,
} from "./driveApi";
import type { DriveFileItem } from "./driveApi";
import { authHeaders } from "./driveFiles";
import {
  QUERY_STATUS_TIMEOUT_MS,
  RANGE_HEADER_PATTERN,
  asDriveFileItem,
  resolveIdempotentConflict,
} from "./resumableSession";
import {
  SESSION_DEAD_STATUS_MAX,
  SESSION_DEAD_STATUS_MIN,
  SessionExpiredError,
  UploadError,
  UPLOAD_CHUNK_MAX_RETRIES,
  abortedUploadError,
  mapUploadHttpError,
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
  mergedSignal: AbortSignal,
  callerSignal: AbortSignal | null | undefined,
  clientGeneratedId?: string,
): Promise<ResumableStatusResult> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
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
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        await captureError({
          level: "error",
          source: DRIVE_MODULE,
          message: `query-status-parse-failed (status=${String(response.status)}): ${classifyDriveError(err)}`,
        });
        throw new UploadError(
          "query-status response was not valid JSON",
          "invalid",
        );
      }
      const file = asDriveFileItem(body);
      if (file === null) {
        await captureError({
          level: "error",
          source: DRIVE_MODULE,
          message: `query-status-parse-failed (status=${String(response.status)})`,
        });
        throw new UploadError(
          "query-status response was not valid JSON",
          "invalid",
        );
      }
      return { status: "done", file };
    }
    if (response.status === 308) {
      const range = response.headers.get("Range");
      const match = range ? RANGE_HEADER_PATTERN.exec(range) : null;
      // "bytes=0-<lastByte>" → next byte = lastByte + 1; no/malformed Range →
      // nothing received, continue from 0 on the SAME session (Drive docs).
      const offset = match ? Number(match[2]) + 1 : 0;
      if (offset >= totalSize) {
        // 308 claiming the whole file without a 200/201 is a server anomaly —
        // resuming would send an out-of-range chunk (same rule as the chunk loop).
        throw new UploadError(
          "resumable server reported a complete range without completing the upload",
          "invalid",
        );
      }
      return { status: "resume", offset };
    }
    if (response.status === 404) throw new SessionExpiredError();
    if (response.status === 409 && clientGeneratedId) {
      // Retry of an idempotent upload whose first attempt completed
      // server-side: the file already exists — resolve DONE with the real
      // file instead of creating a duplicate (same rule as the chunk PUT).
      return {
        status: "done",
        file: await resolveIdempotentConflict(
          token,
          clientGeneratedId,
          mergedSignal,
        ),
      };
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
        await sleep(backoffDelay(attempt, response.headers.get("Retry-After")));
        continue;
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
    const uploadError = mapUploadHttpError(
      response.status,
      await readDriveErrorBody(response),
    );
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
