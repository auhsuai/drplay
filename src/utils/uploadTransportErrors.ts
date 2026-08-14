import { captureError } from "./errorLog";
import { sanitizeString } from "./logger";
import { DRIVE_MODULE } from "./driveApi";
import type { DriveErrorBody, DriveFileItem } from "./driveApi";

// Google forbids re-sending a completed PUT (it creates a NEW upload); a
// transient PUT failure re-initiates the session at most once — never after
// the server answered 200/201. Used by the chunked uploader only: the bytes
// path (uploadFileResumable) is a single attempt and delegates retry to
// uploadManager — one retry layer per mechanism, never two stacked on the
// same call.
export const CHUNKED_SESSION_MAX_ATTEMPTS = 2;
// Cap errBody.message/reason strings in error logs: a 400 can echo the
// request payload; the log must stay bounded yet carry diagnostics.
const UPLOAD_ERROR_DETAIL_MAX_LENGTH = 200;
// Single source of truth for the two shared upload error messages: the
// manager layer (upload/errors.ts re-exports both) and the transport layer
// (mapUploadHttpError / abortedUploadError) must spell them identically.
export const ERROR_QUOTA_EXCEEDED = "drive storage quota exceeded";
export const ABORTED_UPLOAD_MESSAGE = "upload aborted by caller";

// Chunked resumable upload (developers.google.com/drive/api/guides/manage-uploads):
// chunk sizes MUST be multiples of 256 KiB except the final; the server
// answers each chunk with 308 + Range header ("bytes=0-<lastByte>") telling
// where to resume, 200/201 means done, 404 means the session expired,
// 5xx/429 and 403 rate-limits are retryable per chunk. ANY other 4xx also
// means the session is dead — the upload restarts once from a fresh session
// URI (see uploadFileResumableChunked).
export const UPLOAD_CHUNK_MAX_RETRIES = 2;
// Google: any 4xx during a resumable upload means the session expired and
// must be restarted from a new session URI (manage-uploads, "Handle media
// upload errors"). Named bounds so the wrap decision is not a magic range.
export const SESSION_DEAD_STATUS_MIN = 400;
export const SESSION_DEAD_STATUS_MAX = 500; // exclusive — 5xx are retried per chunk

// Typed upload failure; kind lets callers (uploadManager) branch on the real
// cause: quota/network/auth/invalid/aborted (no string-matching). status
// carries the concrete HTTP status (undefined for local failures) so logs and
// the retry layer can see the exact 4xx/5xx; retryAfter carries the response's
// Retry-After header (RFC 9110) for the manager's backoff to honor.
export class UploadError extends Error {
  readonly kind: "quota" | "network" | "auth" | "invalid" | "aborted";
  readonly status: number | undefined;
  readonly retryAfter: string | undefined;
  constructor(
    message: string,
    kind: "quota" | "network" | "auth" | "invalid" | "aborted",
    status?: number,
    retryAfter?: string,
  ) {
    super(message);
    this.name = "UploadError";
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
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
export function mapUploadHttpError(
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
    return new UploadError("upload unauthorized (401)", "auth", status);
  if (status === 403 && isQuotaExceeded(errBody))
    return new UploadError(ERROR_QUOTA_EXCEEDED, "quota", status);
  return new UploadError(
    `upload failed (status=${String(status)})`,
    "invalid",
    status,
  );
}

// Shared 4xx wrap for resumable-session responses (chunk PUTs and the
// query-status PUT): mapUploadHttpError then, when the mapped error is an
// internal 'invalid' 4xx, the session expired server-side (Google: any 4xx
// during a resumable upload must be restarted from a new session URI) — throw
// SessionExpiredError carrying the concrete UploadError. auth/quota are NOT
// wrapped (a fresh session cannot fix them), nor are 'invalid' errors outside
// the 4xx band.
export function mapResumableSessionError(
  status: number,
  errBody: DriveErrorBody | null,
): UploadError {
  const uploadError = mapUploadHttpError(status, errBody);
  if (
    uploadError.kind === "invalid" &&
    status >= SESSION_DEAD_STATUS_MIN &&
    status < SESSION_DEAD_STATUS_MAX
  ) {
    throw new SessionExpiredError(uploadError);
  }
  return uploadError;
}

// Internal marker: the initiate step answered 409 for a pre-generated id — it
// carries the already-uploaded file so callers resolve as DONE, not error.
export class IdempotentConflictError extends Error {
  readonly file: DriveFileItem;
  constructor(file: DriveFileItem) {
    super("idempotent upload conflict resolved");
    this.name = "IdempotentConflictError";
    this.file = file;
  }
}

// Internal marker: a 4xx on a chunk PUT means the resumable session expired
// server-side (Google: any 4xx during a resumable upload must be restarted
// from a fresh session URI); the whole upload must restart. The optional
// wrapped UploadError (absent on the 404 path) surfaces the concrete 4xx
// status when the restarted session fails again — instead of a generic
// network error.
export class SessionExpiredError extends Error {
  readonly uploadError: UploadError | undefined;
  constructor(uploadError?: UploadError) {
    super("resumable upload session expired");
    this.name = "SessionExpiredError";
    this.uploadError = uploadError;
  }
}

export function abortedUploadError(): UploadError {
  return new UploadError(ABORTED_UPLOAD_MESSAGE, "aborted");
}

export function uploadAttemptsExhaustedError(): UploadError {
  return new UploadError(
    `upload failed after ${String(CHUNKED_SESSION_MAX_ATTEMPTS)} attempts`,
    "network",
  );
}

// The LAST attempt still answered 4xx: surface the wrapped UploadError (kind
// 'invalid' + concrete status in the message) instead of the generic network
// error — uploadManager classifies by kind and logs the status. A bare 404
// (no wrapped error) keeps the legacy generic network error. Returns true
// when the error was surfaced (thrown); false when the caller should restart.
export function surfaceSessionUploadError(
  err: unknown,
  attempt: number,
): boolean {
  if (
    err instanceof SessionExpiredError &&
    err.uploadError !== undefined &&
    attempt + 1 >= CHUNKED_SESSION_MAX_ATTEMPTS
  ) {
    throw err.uploadError;
  }
  return false;
}
