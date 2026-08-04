import { fetchWithAuth } from "./apiClient";
import { captureError } from "./errorLog";
import { sanitizeString } from "./logger";
import {
  backoffDelay,
  classifyDriveError,
  DRIVE_MODULE,
  driveFetch,
  isRateLimit403Response,
  mergeWithTimeoutSignal,
  readDriveErrorBody,
  sleep,
} from "./driveApi";
import type { DriveErrorBody, DriveFileItem } from "./driveApi";

// Resumable upload (developers.google.com/drive/api/guides/manage-uploads):
// initiate via POST ?uploadType=resumable, then PUT the whole body once.
const RESUMABLE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
const UPLOAD_MIME_TYPE = "application/octet-stream";
const UPLOAD_METADATA_CONTENT_TYPE = "application/json; charset=UTF-8";
// Slow uploads need a longer bound than the 20s metadata default; 120s covers
// a 50MB file on a slow connection.
const UPLOAD_TIMEOUT_MS = 120_000;
// Google forbids re-sending a completed PUT (it creates a NEW upload); a
// transient PUT failure re-initiates the session at most once — never after
// the server answered 200/201. Used by the chunked uploader only: the bytes
// path (uploadFileResumable) is a single attempt and delegates retry to
// uploadManager — one retry layer per mechanism, never two stacked on the
// same call.
const MAX_UPLOAD_ATTEMPTS = 2;
// Cap errBody.message/reason strings in error logs: a 400 can echo the
// request payload; the log must stay bounded yet carry diagnostics.
const UPLOAD_ERROR_DETAIL_MAX_LENGTH = 200;

// Chunked resumable upload (developers.google.com/drive/api/guides/manage-uploads):
// chunk sizes MUST be multiples of 256 KiB except the final; the server
// answers each chunk with 308 + Range header ("bytes=0-<lastByte>") telling
// where to resume, 200/201 means done, 404 means the session expired,
// 5xx/429 and 403 rate-limits are retryable per chunk.
const UPLOAD_CHUNK_MAX_RETRIES = 2;
// A missing Range header on 308 means no bytes were received — resend from 0.
const RANGE_HEADER_PATTERN = /^bytes=(\d+)-(\d+)$/;

// Typed upload failure; kind lets callers (uploadManager) branch on the real
// cause: quota/network/auth/invalid/aborted (no string-matching).
export class UploadError extends Error {
  readonly kind: "quota" | "network" | "auth" | "invalid" | "aborted";
  constructor(
    message: string,
    kind: "quota" | "network" | "auth" | "invalid" | "aborted",
  ) {
    super(message);
    this.name = "UploadError";
    this.kind = kind;
  }
}

// Drive error bodies carry { error: { message, reason } } — the shared
// readDriveErrorBody lives in driveApi (exported, single source of truth).
// 403 storage-quota detection: official reason storageQuotaExceeded (docs +
// real API traces). rate-limit 403s never reach this mapper — retried before;
// other 403s (permissions…) → 'invalid'.
function isQuotaExceeded(errBody: DriveErrorBody | null): boolean {
  const reason =
    typeof errBody?.error?.reason === "string"
      ? errBody.error.reason.toLowerCase()
      : "";
  const message =
    typeof errBody?.error?.message === "string"
      ? errBody.error.message.toLowerCase()
      : "";
  return reason.includes("quota") || message.includes("storage quota");
}

// Only the two official string fields of a Drive error body reach the log;
// each is sanitized (id=, tokens, links redacted) and length-capped so a hostile body cannot bloat the log.
function uploadErrorDetail(errBody: DriveErrorBody | null): string {
  const parts: string[] = [];
  const message = errBody?.error?.message;
  if (typeof message === "string" && message !== "")
    parts.push(sanitizeString(message));
  const reason = errBody?.error?.reason;
  if (typeof reason === "string" && reason !== "")
    parts.push(sanitizeString(reason));
  if (parts.length === 0) return "";
  const joined = parts.join(" | ");
  return joined.length > UPLOAD_ERROR_DETAIL_MAX_LENGTH
    ? `${joined.slice(0, UPLOAD_ERROR_DETAIL_MAX_LENGTH)}...`
    : joined;
}

// Single mapper for both upload steps — non-retryable by design: a PUT retried
// after the server answered would create a duplicate upload.
function mapUploadHttpError(
  status: number,
  errBody: DriveErrorBody | null,
): UploadError {
  // Log the concrete status + sanitized reason BEFORE throwing: the caller
  // (uploadManager) only records the UploadError kind — the exact 4xx from Drive would otherwise be invisible in the log.
  const detail = uploadErrorDetail(errBody);
  // fire-and-forget: logging must not throw in this sync path (captureError
  // never rejects — it swallows failures internally).
  void captureError({
    level: "warn",
    source: DRIVE_MODULE,
    message: `upload-http-error (status=${String(status)})${detail ? `: ${detail}` : ""}`,
  });
  if (status === 401)
    return new UploadError("upload unauthorized (401)", "auth");
  if (status === 403 && isQuotaExceeded(errBody))
    return new UploadError("drive storage quota exceeded", "quota");
  return new UploadError(
    `upload failed (status=${String(status)})`,
    "invalid",
  );
}

// Step 1: initiate a resumable session. POST is idempotent (metadata only) so it reuses driveFetch's retry/backoff — unlike the PUT step.
async function initiateResumableUpload(
  token: string,
  name: string,
  parentId: string,
  byteLength: number,
  signal: AbortSignal,
): Promise<string> {
  const response = await driveFetch(RESUMABLE_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": UPLOAD_METADATA_CONTENT_TYPE,
      "X-Upload-Content-Type": UPLOAD_MIME_TYPE,
      "X-Upload-Content-Length": String(byteLength),
    },
    body: JSON.stringify({ name, parents: [parentId] }),
    signal,
  });

  if (!response.ok) {
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

// Step 2: PUT the whole body once. fetchWithAuth (NOT driveFetch) — it must never auto-retry, and it gives us the 401 token-refresh for free.
async function putResumableBytes(
  uploadUri: string,
  token: string,
  data: Uint8Array,
  signal: AbortSignal,
): Promise<DriveFileItem> {
  const byteLength = data.byteLength;
  const response = await fetchWithAuth(uploadUri, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": UPLOAD_MIME_TYPE,
      "Content-Range": `bytes 0-${String(byteLength - 1)}/${String(byteLength)}`,
    },
    body: data,
    signal,
    // fetchWithAuth's 15s internal default would kill a slow upload PUT well before the session's 120s bound — keep both in sync.
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });

  if (!response.ok) {
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

  const mergedSignal = mergeWithTimeoutSignal(signal, UPLOAD_TIMEOUT_MS);
  try {
    const uploadUri = await initiateResumableUpload(
      token,
      name,
      parentId,
      byteLength,
      mergedSignal,
    );
    return await putResumableBytes(uploadUri, token, data, mergedSignal);
  } catch (err) {
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

// Internal marker: a 404 on a chunk PUT means the resumable session expired server-side; the whole upload must restart from a fresh session URI.
class SessionExpiredError extends Error {
  constructor() {
    super("resumable upload session expired");
    this.name = "SessionExpiredError";
  }
}

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
}

function abortedUploadError(): UploadError {
  return new UploadError("upload aborted by caller", "aborted");
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
    // a Drive rate limit. The body is read via a clone so the response keeps
    // its body for mapUploadHttpError below; a clone/parse failure means "not
    // a rate limit" → the 403 returns as-is. Read only on retryable attempts.
    let rateLimit403 = false;
    if (response.status === 403 && attempt < UPLOAD_CHUNK_MAX_RETRIES) {
      rateLimit403 = await isRateLimit403Response(response);
    }
    const retryable =
      response.status === 429 ||
      (response.status >= 500 && response.status < 600) ||
      rateLimit403;
    if (!retryable) return response;
    if (attempt < UPLOAD_CHUNK_MAX_RETRIES) {
      await sleep(backoffDelay(attempt, response.headers.get("Retry-After")));
      continue;
    }
    throw new UploadError(
      `upload failed (status=${String(response.status)})`,
      "network",
    );
  }
}

// Upload one session's worth of chunks. Throws UploadError for fatal errors
// (auth/quota/invalid/aborted), SessionExpiredError for a 404 (session died),
// and raw transient errors — the non-UploadError cases restart the session.
async function uploadChunksInSession(
  uploadUri: string,
  token: string,
  opts: ChunkedUploadOptions,
  mergedSignal: AbortSignal,
): Promise<DriveFileItem> {
  const { totalSize, readChunk, onProgress, signal } = opts;
  let offset = 0;
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
    throw mapUploadHttpError(
      response.status,
      await readDriveErrorBody(response),
    );
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
  for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) throw abortedUploadError();
    let uploadUri: string;
    try {
      uploadUri = await initiateResumableUpload(
        token,
        opts.name,
        opts.parentId,
        opts.totalSize,
        mergedSignal,
      );
    } catch (err) {
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
    try {
      return await uploadChunksInSession(uploadUri, token, opts, mergedSignal);
    } catch (err) {
      if (opts.signal?.aborted) throw abortedUploadError();
      if (err instanceof UploadError) throw err;
      // Session expired (404) or transient network/timeout — restart the whole upload from a fresh session URI, bounded by MAX_UPLOAD_ATTEMPTS.
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
  throw new UploadError(
    `upload failed after ${String(MAX_UPLOAD_ATTEMPTS)} attempts`,
    "network",
  );
}
