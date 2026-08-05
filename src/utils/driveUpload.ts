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
// The query-status PUT carries no bytes, so a much shorter bound is enough —
// a stalled status request must not sit for the full 120s chunk bound.
const QUERY_STATUS_TIMEOUT_MS = 20_000;
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

// Chunked resumable upload (developers.google.com/drive/api/guides/manage-uploads):
// chunk sizes MUST be multiples of 256 KiB except the final; the server
// answers each chunk with 308 + Range header ("bytes=0-<lastByte>") telling
// where to resume, 200/201 means done, 404 means the session expired,
// 5xx/429 and 403 rate-limits are retryable per chunk. ANY other 4xx also
// means the session is dead — the upload restarts once from a fresh session
// URI (see uploadFileResumableChunked).
const UPLOAD_CHUNK_MAX_RETRIES = 2;
// A missing Range header on 308 means no bytes were received — resend from 0.
const RANGE_HEADER_PATTERN = /^bytes=(\d+)-(\d+)$/;
// Google: any 4xx during a resumable upload means the session expired and
// must be restarted from a new session URI (manage-uploads, "Handle media
// upload errors"). Named bounds so the wrap decision is not a magic range.
const SESSION_DEAD_STATUS_MIN = 400;
const SESSION_DEAD_STATUS_MAX = 500; // exclusive — 5xx are retried per chunk

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
  return new UploadError(`upload failed (status=${String(status)})`, "invalid");
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
function asDriveFileItem(data: unknown): DriveFileItem | null {
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
async function resolveIdempotentConflict(
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

// Internal marker: the initiate step answered 409 for a pre-generated id — it
// carries the already-uploaded file so callers resolve as DONE, not error.
class IdempotentConflictError extends Error {
  readonly file: DriveFileItem;
  constructor(file: DriveFileItem) {
    super("idempotent upload conflict resolved");
    this.name = "IdempotentConflictError";
    this.file = file;
  }
}

// Step 1: initiate a resumable session. POST is idempotent (metadata only) so it reuses driveFetch's retry/backoff — unlike the PUT step. With a pre-generated id the session is bound to that id: a retried session for an already-created file answers 409 here or at the PUT step.
async function initiateResumableUpload(
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

// Internal marker: a 4xx on a chunk PUT means the resumable session expired
// server-side (Google: any 4xx during a resumable upload must be restarted
// from a fresh session URI); the whole upload must restart. The optional
// wrapped UploadError (absent on the 404 path) surfaces the concrete 4xx
// status when the restarted session fails again — instead of a generic
// network error.
class SessionExpiredError extends Error {
  readonly uploadError: UploadError | undefined;
  constructor(uploadError?: UploadError) {
    super("resumable upload session expired");
    this.name = "SessionExpiredError";
    this.uploadError = uploadError;
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

function abortedUploadError(): UploadError {
  return new UploadError("upload aborted by caller", "aborted");
}

function uploadAttemptsExhaustedError(): UploadError {
  return new UploadError(
    `upload failed after ${String(MAX_UPLOAD_ATTEMPTS)} attempts`,
    "network",
  );
}

// The LAST attempt still answered 4xx: surface the wrapped UploadError (kind
// 'invalid' + concrete status in the message) instead of the generic network
// error — uploadManager classifies by kind and logs the status. A bare 404
// (no wrapped error) keeps the legacy generic network error. Returns true
// when the error was surfaced (thrown); false when the caller should restart.
function surfaceSessionUploadError(err: unknown, attempt: number): boolean {
  if (
    err instanceof SessionExpiredError &&
    err.uploadError !== undefined &&
    attempt + 1 >= MAX_UPLOAD_ATTEMPTS
  ) {
    throw err.uploadError;
  }
  return false;
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

async function queryResumableStatus(
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
          Authorization: `Bearer ${token}`,
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
    // like a chunk PUT (same retry bound, backoffDelay honors Retry-After).
    let rateLimit403 = false;
    if (response.status === 403 && attempt < UPLOAD_CHUNK_MAX_RETRIES) {
      rateLimit403 = await isRateLimit403Response(response);
    }
    const retryable =
      response.status === 429 ||
      (response.status >= 500 && response.status < 600) ||
      rateLimit403;
    if (retryable) {
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
