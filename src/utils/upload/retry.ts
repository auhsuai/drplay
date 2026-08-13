import { backoffDelay, getDriveStorageQuota, sleep } from "../driveApi";
import type { DriveFileItem, DriveStorageQuota } from "../driveApi";
import {
  UploadError,
  generateClientId,
  uploadFileResumable,
} from "../driveUpload";
import { captureError } from "../errorLog";
import { controllerFor } from "./controllers";
import {
  ABORTED_UPLOAD_MESSAGE,
  ERROR_ABORTED,
  ERROR_QUOTA_EXCEEDED,
  FileTooLargeError,
  MAX_FILE_BYTES,
  MAX_UPLOAD_ATTEMPTS,
  MODULE,
  describeError,
} from "./errors";
import type { InternalEntry } from "./types";

// Bytes-path uploads (picker/tests keep the whole body in memory): quota check
// then uploadFileResumable with manager-level retries — the SINGLE retry layer
// for the bytes path (uploadFileResumable is one attempt; retry lives here, so
// a transient failure is retried at most 3 times, never 3×2). Disk paths
// bypass this and go through uploadDiskFileStreaming — the chunked uploader
// retries transient failures internally (2 session restarts via its own
// CHUNKED_SESSION_MAX_ATTEMPTS + per-chunk backoff through the 308-resume protocol), a
// DIFFERENT mechanism, so layering the manager retries on top would multiply
// upload attempts.
export async function uploadWithQuotaAndRetry(
  entry: InternalEntry,
  data: Blob | Uint8Array,
): Promise<DriveFileItem> {
  const byteLength = data instanceof Blob ? data.size : data.byteLength;
  if (!(await quotaAllows(entry, byteLength))) {
    throw new UploadError(ERROR_QUOTA_EXCEEDED, "quota");
  }
  return uploadWithRetry(entry, data);
}
// Unknown quota (fetch fail / null) must never block: getDriveStorageQuota logs its own warn.
export async function quotaAllows(
  entry: InternalEntry,
  byteLength: number,
): Promise<boolean> {
  // Fail-early guard (single choke point for BOTH the bytes and the disk
  // path): reject >5 TB files before any quota fetch or upload call, because
  // Google fails such uploads mid-transfer — a >5 TB file is a defective
  // seed, so it should fail in milliseconds, not hours.
  if (byteLength > MAX_FILE_BYTES) {
    throw new FileTooLargeError(byteLength);
  }
  let quota: DriveStorageQuota | null;
  try {
    quota = await getDriveStorageQuota(entry.token);
  } catch (err) {
    await captureError({
      level: "warn",
      source: MODULE,
      message: `quota-check-skipped name=${entry.name}: ${describeError(err)}`,
    });
    return true;
  }
  if (quota === null) return true;
  if (quota.limit === null) return true; // unlimited account (pooled Workspace quota)
  return quota.usage + byteLength <= quota.limit;
}

// ONE pre-generated id per logical upload: retry attempts must bind their
// sessions to the SAME id or Drive would create a duplicate file when the
// first PUT succeeded server-side but its response was lost (the idempotent
// retry fix — driveUpload turns the retry's 409 into a resolve-DONE). A
// failure only degrades to the legacy non-idempotent upload — never blocks.
export async function tryGenerateClientId(
  entry: InternalEntry,
): Promise<string | undefined> {
  try {
    return await generateClientId(entry.token, controllerFor(entry)?.signal);
  } catch (err) {
    await captureError({
      level: "warn",
      source: MODULE,
      message: `client-id-generation-failed name=${entry.name}: ${describeError(err)}`,
    });
    return undefined;
  }
}

// Only transient network failures are retried (bounded backoff); pending row stays.
async function uploadWithRetry(
  entry: InternalEntry,
  data: Blob | Uint8Array,
): Promise<DriveFileItem> {
  const signal = controllerFor(entry)?.signal;
  // Generated BEFORE the retry loop so every attempt creates a session bound
  // to the same pre-generated id — the core of the idempotent-retry fix.
  const clientGeneratedId = await tryGenerateClientId(entry);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw abortedUploadError();
    try {
      return await uploadFileResumable(
        entry.token,
        data,
        entry.name,
        entry.parentId,
        signal,
        { clientGeneratedId },
      );
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof UploadError &&
        err.kind === "network" &&
        attempt < MAX_UPLOAD_ATTEMPTS;
      if (!retryable) throw err;
      await sleep(backoffDelay(attempt - 1));
      // An abort during the backoff must not schedule another attempt — the
      // user asked to cancel; re-firing would waste a fresh upload session.
      if (signal?.aborted) throw abortedUploadError();
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new UploadError("upload failed", "network");
}
export function abortedUploadError(): UploadError {
  return new UploadError(ABORTED_UPLOAD_MESSAGE, ERROR_ABORTED);
}

// Normalize a rejection caused by a user-initiated cancel into the manager's
// canonical UploadError('aborted'). A raw AbortError/DOMException would
// otherwise classify as 'failed' and show an error toast — markError only
// treats UploadError kind 'aborted' as a silent cancel. The signal is
// re-checked in the catch (instead of inspecting err.name) because diskFs
// throws its own AbortError-like error and driveFetch rethrows the merged
// fetch rejection; both are aborts and both are normalized here.
export async function abortIfCancelled<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (signal?.aborted) throw abortedUploadError();
    throw err;
  }
}
