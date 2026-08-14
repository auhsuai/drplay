import { captureError } from "./errorLog";
import {
  DRIVE_MODULE,
  classifyDriveError,
  driveFetch,
  readDriveErrorBody,
} from "./driveApi";
import type { DriveFileItem } from "./driveApi";
import { authHeaders, DRIVE_FILES_URL } from "./driveFiles";
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

// Adaptive chunked uploads (see nextChunkLevel in uploadFileResumableChunked.ts):
// the Drive protocol only requires non-final chunk sizes to be multiples of
// 256 KiB (manage-uploads, "resumable upload" chunk rules), so slow links step
// DOWN through these levels instead of failing. All three are 256 KiB
// multiples. The fixed 8 MiB chunk with the flat 120 s bound made slow links
// (< ~560 Kbps) fail deterministically: 8 MiB / 120 s ≈ 65 KB/s.
export const UPLOAD_CHUNK_LEVELS = [
  8 * 1024 * 1024,
  2 * 1024 * 1024,
  512 * 1024,
] as const;

// Slowest sustained rate the uploader commits to supporting (64 KiB/s): the
// chunk timeout scales so a full chunk at this rate still finishes inside its
// bound (8 MiB → 128 s, 2 MiB → 32 s).
export const UPLOAD_CHUNK_THROUGHPUT_KIB_PER_SEC = 64;
// Floor for a chunk PUT bound: even a tiny chunk gets a generous minimum so a
// stalled link is not mistaken for a slow-but-alive one (512 KiB → 8 s by the
// formula, clamped here to 30 s).
export const UPLOAD_CHUNK_TIMEOUT_FLOOR_MS = 30_000;

// Per-chunk PUT bound, proportional to the chunk size. The initiate POST and
// the conflict-GET keep the flat UPLOAD_TIMEOUT_MS above. Rounded UP to an
// integer: AbortSignal.timeout rejects non-integer delays (Node throws
// RangeError) and a rounded-down bound could break the 64 KiB/s guarantee.
export function uploadChunkTimeoutMs(chunkBytes: number): number {
  const seconds = chunkBytes / 1024 / UPLOAD_CHUNK_THROUGHPUT_KIB_PER_SEC;
  return Math.max(UPLOAD_CHUNK_TIMEOUT_FLOOR_MS, Math.ceil(seconds * 1000));
}

// Idempotent retry (developers.google.com/workspace/drive/api/guides/manage-uploads,
// "Use a pre-generated ID to upload files"): a pre-generated id lets a retry
// after an indeterminate server error or timeout re-run safely — if the file
// was already created, Drive answers the retry with 409 Conflict and NO
// duplicate file is created.
const GENERATE_IDS_URL = `${DRIVE_FILES_URL}/generateIds`;
const GENERATE_IDS_COUNT = 1;
// The 409 body carries no file id — fetch the file that already owns the
// pre-generated id so the retry resolves as DONE with the real file.
const FILE_GET_FIELDS = "id,name,mimeType,size,modifiedTime";

// A missing Range header on 308 means no bytes were received — resend from 0.
export const RANGE_HEADER_PATTERN = /^bytes=(\d+)-(\d+)$/;

// Shared 308 handling (chunk PUTs and the query-status PUT): parse the Range
// header ("bytes=0-<lastByte>" → next offset = lastByte + 1; no/malformed
// Range → nothing received, continue from 0 — Drive docs) and reject a server
// anomaly where 308 claims the whole file without a 200/201 (resuming would
// send an out-of-range chunk).
export function resumeOffsetFromRange(
  range: string | null,
  totalSize: number,
): number {
  const match = range ? RANGE_HEADER_PATTERN.exec(range) : null;
  const offset = match ? Number(match[2]) + 1 : 0;
  if (offset >= totalSize) {
    throw new UploadError(
      "resumable server reported a complete range without completing the upload",
      "invalid",
    );
  }
  return offset;
}

// Shared 2xx body narrowing (the final chunk PUT, the query-status PUT and the
// single-request bytes PUT all answer 200/201 with the created file's JSON):
// parse + narrow via asDriveFileItem; a JSON parse failure or a missing
// DriveFileItem shape logs `logLabel` with the concrete status (byte-for-byte
// the historical per-call-site message) and throws UploadError(errorMessage,
// 'invalid') — never a ghost object.
export async function parseUploadResponseJson(
  response: Response,
  logLabel: string,
  errorMessage: string,
): Promise<DriveFileItem> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    await captureError({
      level: "error",
      source: DRIVE_MODULE,
      message: `${logLabel} (status=${String(response.status)}): ${classifyDriveError(err)}`,
    });
    throw new UploadError(errorMessage, "invalid");
  }
  const file = asDriveFileItem(body);
  if (file === null) {
    await captureError({
      level: "error",
      source: DRIVE_MODULE,
      message: `${logLabel} (status=${String(response.status)})`,
    });
    throw new UploadError(errorMessage, "invalid");
  }
  return file;
}

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
      method: "GET",
      headers: authHeaders(token),
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
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=${FILE_GET_FIELDS}`;
  const response = await driveFetch(url, {
    headers: authHeaders(token),
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

// Shared 409 branching for every resumable-upload step: with a pre-generated
// id bound, a 409 means a retry of an idempotent upload whose first attempt
// completed server-side — the file already exists, so return it (null when the
// 409 is unrelated). Callers keep their own ending: the chunk PUT and the
// query-status PUT resolve DONE with the file, the initiate throws
// IdempotentConflictError.
export async function resolveConflictOrNull(
  token: string,
  fileId: string | undefined,
  signal: AbortSignal,
): Promise<DriveFileItem | null> {
  if (!fileId) return null;
  return resolveIdempotentConflict(token, fileId, signal);
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
      ...authHeaders(token),
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
    if (response.status === 409) {
      const file = await resolveConflictOrNull(token, generatedId, signal);
      if (file !== null) {
        // The file already exists from a previous (response-lost) attempt of
        // the same idempotent upload — resolve DONE with the real file.
        throw new IdempotentConflictError(file);
      }
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
