import { fetchWithAuth } from "./apiClient";
import { captureError } from "./errorLog";
import {
  DRIVE_MODULE,
  classifyDriveError,
  mergeWithTimeoutSignal,
  readDriveErrorBody,
  shouldRetryDriveResponse,
} from "./driveApi";
import type { DriveFileItem } from "./driveApi";
import { authHeaders } from "./driveFiles";
import { MAX_UPLOAD_ATTEMPTS } from "./upload/errors";
import {
  UPLOAD_MIME_TYPE,
  UPLOAD_TIMEOUT_MS,
  initiateResumableUpload,
  parseUploadResponseJson,
  resolveIdempotentConflict,
} from "./resumableSession";
import {
  IdempotentConflictError,
  UploadError,
  abortedUploadError,
  mapUploadHttpError,
} from "./uploadTransportErrors";

// Step 2: PUT the whole body once. fetchWithAuth (NOT driveFetch) — it must never auto-retry, and it gives us the 401 token-refresh for free.
async function putResumableBytes(
  uploadUri: string,
  token: string,
  data: Uint8Array,
  signal: AbortSignal,
  clientGeneratedId?: string,
): Promise<DriveFileItem> {
  const byteLength = data.byteLength;
  const response = await fetchWithAuth(uploadUri, {
    method: "PUT",
    headers: {
      ...authHeaders(token),
      "Content-Type": UPLOAD_MIME_TYPE,
      "Content-Range": `bytes 0-${String(byteLength - 1)}/${String(byteLength)}`,
    },
    body: data,
    signal,
    // fetchWithAuth's 15s internal default would kill a slow upload PUT well before the session's 120s bound — keep both in sync.
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });

  if (!response.ok) {
    if (response.status === 409 && clientGeneratedId) {
      // Retry of an idempotent upload whose first attempt completed
      // server-side: the file already exists — resolve DONE with the real
      // file instead of creating a duplicate.
      return resolveIdempotentConflict(token, clientGeneratedId, signal);
    }
    // Transient HTTP (429/5xx/rate-limit-403): surface as kind 'network' with
    // the concrete status + Retry-After so the manager's single retry layer
    // (uploadWithRetry, budget MAX_UPLOAD_ATTEMPTS) can retry with backoff —
    // mirroring the chunked path's per-chunk retry. attempt=0/maxRetries-1
    // only gates the 403 body read (a quota 403 must stay non-retryable); the
    // retry BUDGET itself is enforced by the manager, not here.
    if (await shouldRetryDriveResponse(response, 0, MAX_UPLOAD_ATTEMPTS - 1)) {
      // mapUploadHttpError logs the concrete status + sanitized reason in
      // both branches, so a retried 429 stays visible in the log.
      const mapped = mapUploadHttpError(
        response.status,
        await readDriveErrorBody(response),
      );
      throw new UploadError(
        mapped.message,
        "network",
        response.status,
        response.headers.get("Retry-After") ?? undefined,
      );
    }
    throw mapUploadHttpError(
      response.status,
      await readDriveErrorBody(response),
    );
  }
  return await parseUploadResponseJson(
    response,
    "upload-parse-response-failed",
    "upload response was not valid JSON",
  );
}

// Options for idempotent uploads (pre-generated file id, set ONCE per logical
// upload by the caller — retry attempts must reuse the SAME id, or Drive
// would create a duplicate instead of answering 409).
export interface UploadFileOptions {
  clientGeneratedId?: string | undefined;
}

// Upload file bytes via the resumable protocol (POST initiate → PUT bytes) —
// exactly ONE attempt. Transient failures — network/timeout rejections AND
// 429/5xx/rate-limit-403 HTTP answers — wrap into UploadError('network',
// status, Retry-After) so uploadManager.uploadWithRetry — the single retry
// layer for the bytes path (3 attempts + backoff) — can classify and retry.
// Retrying here too would stack two retry layers on the same call and multiply
// upload sessions. Non-retryable HTTP errors map to UploadError kinds; aborts win.
export async function uploadFileResumable(
  token: string,
  bytes: Blob | Uint8Array,
  name: string,
  parentId: string,
  signal?: AbortSignal,
  options?: UploadFileOptions,
): Promise<DriveFileItem> {
  if (signal?.aborted) {
    throw abortedUploadError();
  }

  const data =
    bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
  const byteLength = data.byteLength;
  if (byteLength === 0) {
    // Google's resumable docs define no Content-Range format for empty files (verified 2026-08-02); reject rather than risk a malformed upload.
    throw new UploadError("cannot upload an empty file", "invalid");
  }

  const clientGeneratedId = options?.clientGeneratedId;
  // NOTE: no whole-upload timeout signal (pattern: uploadFileResumableChunked.ts).
  // ONE AbortSignal.timeout created before the initiate would fire at its
  // wall-clock deadline and STAY aborted — killing the body PUT of any upload
  // whose TOTAL duration (initiate + PUT) exceeds UPLOAD_TIMEOUT_MS, even when
  // each individual request is fast enough on its own. Each request bounds
  // itself per-request instead: fresh merges below (the initiate is additionally
  // bounded per-attempt by driveFetch's 20s default) — only the caller's abort
  // signal is shared across both.
  try {
    const uploadUri = await initiateResumableUpload(
      token,
      name,
      parentId,
      byteLength,
      // Fresh per-request merge; the POST itself is bounded per-attempt by
      // driveFetch (20s default) — this only carries the caller's abort.
      mergeWithTimeoutSignal(signal, UPLOAD_TIMEOUT_MS),
      clientGeneratedId,
    );
    return await putResumableBytes(
      uploadUri,
      token,
      data,
      // Fresh per-request merge — the PUT's 120s bound starts when the PUT
      // starts, not when the upload started (a whole-upload signal would fire
      // at its fixed deadline and stay aborted, killing the PUT mid-flight).
      mergeWithTimeoutSignal(signal, UPLOAD_TIMEOUT_MS),
      clientGeneratedId,
    );
  } catch (err) {
    if (err instanceof IdempotentConflictError) {
      return err.file;
    }
    if (signal?.aborted) {
      throw abortedUploadError();
    }
    if (err instanceof UploadError) {
      throw err;
    }
    // Transient network/timeout — wrap so the manager's single retry layer can
    // classify it; a raw TypeError would NOT match `kind === 'network'` and
    // would bypass the retry entirely.
    await captureError({
      level: "warn",
      source: DRIVE_MODULE,
      message: `upload-transient-failure: ${classifyDriveError(err)}`,
    });
    throw new UploadError("upload failed", "network");
  }
}
