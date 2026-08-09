import { fetchWithAuth } from "./apiClient";
import { captureError } from "./errorLog";
import {
  DRIVE_MODULE,
  classifyDriveError,
  mergeWithTimeoutSignal,
  readDriveErrorBody,
} from "./driveApi";
import type { DriveFileItem } from "./driveApi";
import { authHeaders } from "./driveFiles";
import {
  UPLOAD_MIME_TYPE,
  UPLOAD_TIMEOUT_MS,
  initiateResumableUpload,
  resolveIdempotentConflict,
} from "./resumableSession";
import {
  IdempotentConflictError,
  UploadError,
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
    throw mapUploadHttpError(
      response.status,
      await readDriveErrorBody(response),
    );
  }
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

// Options for idempotent uploads (pre-generated file id, set ONCE per logical
// upload by the caller — retry attempts must reuse the SAME id, or Drive
// would create a duplicate instead of answering 409).
export interface UploadFileOptions {
  clientGeneratedId?: string | undefined;
}

// Upload file bytes via the resumable protocol (POST initiate → PUT bytes) —
// exactly ONE attempt. Transient network/timeout failures wrap into
// UploadError('network') so uploadManager.uploadWithRetry — the single retry
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
    throw new UploadError("upload aborted by caller", "aborted");
  }

  const data =
    bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
  const byteLength = data.byteLength;
  if (byteLength === 0) {
    // Google's resumable docs define no Content-Range format for empty files (verified 2026-08-02); reject rather than risk a malformed upload.
    throw new UploadError("cannot upload an empty file", "invalid");
  }

  const clientGeneratedId = options?.clientGeneratedId;
  const mergedSignal = mergeWithTimeoutSignal(signal, UPLOAD_TIMEOUT_MS);
  try {
    const uploadUri = await initiateResumableUpload(
      token,
      name,
      parentId,
      byteLength,
      mergedSignal,
      clientGeneratedId,
    );
    return await putResumableBytes(
      uploadUri,
      token,
      data,
      mergedSignal,
      clientGeneratedId,
    );
  } catch (err) {
    if (err instanceof IdempotentConflictError) {
      return err.file;
    }
    if (signal?.aborted) {
      throw new UploadError("upload aborted by caller", "aborted");
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
