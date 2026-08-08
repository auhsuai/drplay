import { captureError } from "./errorLog";
import { DRIVE_MODULE, driveFetch, readDriveErrorBody } from "./driveApi";
import type { DriveFileItem } from "./driveApi";
import {
  IdempotentConflictError,
  UploadError,
  mapUploadHttpError,
} from "./uploadTransportErrors";

// Resumable upload (developers.google.com/drive/api/guides/manage-uploads):
// initiate via POST ?uploadType=resumable, then PUT the whole body once.
const RESUMABLE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
export const UPLOAD_MIME_TYPE = "application/octet-stream";
const UPLOAD_METADATA_CONTENT_TYPE = "application/json; charset=UTF-8";
// Slow uploads need a longer bound than the 20s metadata default; 120s covers
// a 50MB file on a slow connection.
export const UPLOAD_TIMEOUT_MS = 120_000;
// The query-status PUT carries no bytes, so a much shorter bound is enough —
// a stalled status request must not sit for the full 120s chunk bound.
export const QUERY_STATUS_TIMEOUT_MS = 20_000;

// Idempotent retry (developers.google.com/workspace/drive/api/guides/manage-uploads,
// "Use a pre-generated ID to upload files"): a pre-generated id lets a retry
// after an indeterminate server error or timeout re-run safely — if the file
// was already created, Drive answers the retry with 409 Conflict and NO
// duplicate file is created.
const DRIVE_FILES_BASE_URL = "https://www.googleapis.com/drive/v3/files";
const GENERATE_IDS_URL = `${DRIVE_FILES_BASE_URL}/generateIds`;
const GENERATE_IDS_COUNT = 1;
// The 409 body carries no file id — fetch the file that already owns the
// pre-generated id so the retry resolves as DONE with the real file.
const FILE_GET_FIELDS = "id,name,mimeType,size,modifiedTime";

// A missing Range header on 308 means no bytes were received — resend from 0.
export const RANGE_HEADER_PATTERN = /^bytes=(\d+)-(\d+)$/;

// Generate ONE pre-generated file id (driveFetch retries transient failures
// internally). The id is bound into the initiate metadata, so a retried
// session that hits an already-created file gets a 409 instead of a duplicate.
// Throws on any failure — callers decide the fallback (uploadManager degrades
// to a non-idempotent upload rather than blocking).
export async function generateClientId(
  token: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await driveFetch(
    `${GENERATE_IDS_URL}?count=${String(GENERATE_IDS_COUNT)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) {
    throw mapUploadHttpError(
      response.status,
      await readDriveErrorBody(response),
    );
  }
  const data: unknown = await response.json();
  const ids =
    typeof data === "object" && data !== null
      ? (data as { ids?: unknown }).ids
      : undefined;
  if (!Array.isArray(ids) || typeof ids[0] !== "string" || ids[0] === "") {
    throw new UploadError("generateIds returned no file id", "invalid");
  }
  return ids[0];
}

// Narrow a files.get body to the minimal DriveFileItem shape the upload path
// needs (id/name/mimeType required — the GET fields param requests all three —
// size/modifiedTime optional). Never `as any` casts.
export function asDriveFileItem(data: unknown): DriveFileItem | null {
  if (typeof data !== "object" || data === null) return null;
  const rec = data as Record<string, unknown>;
  if (
    typeof rec.id !== "string" ||
    typeof rec.name !== "string" ||
    typeof rec.mimeType !== "string"
  )
    return null;
  const item: DriveFileItem = {
    id: rec.id,
    name: rec.name,
    mimeType: rec.mimeType,
  };
  if (typeof rec.size === "string") item.size = rec.size;
  if (typeof rec.modifiedTime === "string")
    item.modifiedTime = rec.modifiedTime;
  return item;
}

// A 409 on an idempotent retry means the file already exists — resolve the
// upload as DONE by fetching the real file instead of failing.
export async function resolveIdempotentConflict(
  token: string,
  fileId: string,
  signal: AbortSignal,
): Promise<DriveFileItem> {
  // Not an error: this is the retry-success path of an idempotent upload.
  await captureError({
    level: "info",
    source: DRIVE_MODULE,
    message: "idempotent-conflict-resolved",
  });
  const url = `${DRIVE_FILES_BASE_URL}/${encodeURIComponent(fileId)}?fields=${FILE_GET_FIELDS}`;
  const response = await driveFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) {
    throw mapUploadHttpError(
      response.status,
      await readDriveErrorBody(response),
    );
  }
  const item = asDriveFileItem(await response.json());
  if (item === null) {
    throw new UploadError(
      "conflict file fetch returned invalid JSON",
      "invalid",
    );
  }
  return item;
}

// Step 1: initiate a resumable session. POST is idempotent (metadata only) so it reuses driveFetch's retry/backoff — unlike the PUT step. With a pre-generated id the session is bound to that id: a retried session for an already-created file answers 409 here or at the PUT step.
export async function initiateResumableUpload(
  token: string,
  name: string,
  parentId: string,
  byteLength: number,
  signal: AbortSignal,
  generatedId?: string,
): Promise<string> {
  const response = await driveFetch(RESUMABLE_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": UPLOAD_METADATA_CONTENT_TYPE,
      "X-Upload-Content-Type": UPLOAD_MIME_TYPE,
      "X-Upload-Content-Length": String(byteLength),
    },
    body: JSON.stringify(
      generatedId
        ? { name, parents: [parentId], id: generatedId }
        : { name, parents: [parentId] },
    ),
    signal,
  });

  if (!response.ok) {
    if (response.status === 409 && generatedId) {
      // The file already exists from a previous (response-lost) attempt of the
      // same idempotent upload — resolve DONE with the real file.
      throw new IdempotentConflictError(
        await resolveIdempotentConflict(token, generatedId, signal),
      );
    }
    throw mapUploadHttpError(
      response.status,
      await readDriveErrorBody(response),
    );
  }
  const location = response.headers.get("Location");
  if (!location) {
    throw new UploadError(
      "resumable session returned no Location header",
      "invalid",
    );
  }
  return location;
}
