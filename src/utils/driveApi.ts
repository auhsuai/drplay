import { fetchWithAuth } from './apiClient';
import { getAudioFilesQuery } from './audioQuery';
import { captureError } from './errorLog';

// Google Drive API resilience layer.
// Official guidance (developers.google.com/workspace/drive/api/guides/limits):
// 403/429 rate-limit and 5xx transient errors must be retried with exponential
// backoff + jitter; honor the Retry-After header when present. 4xx (400/401/404)
// are NOT retried here — 401 refresh is handled inside fetchWithAuth.
export const DRIVE_MODULE = "driveApi";
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const CONFIG_FILENAME = 'drplay_config.json';
const APP_DATA_FOLDER = 'appDataFolder';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// 403 is retryable ONLY when its body reports a Drive usage-limit reason
// (official docs: "403 error: rateLimitExceeded" / "userRateLimitExceeded" —
// developers.google.com/workspace/drive/api/guides/handle-errors; same set as
// the proSync worker precedent). Other 403s (permissions…) are never retried.
const DRIVE_RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32000;
const DEFAULT_TIMEOUT_MS = 20000;

export interface DriveFileItem {
  id: string; name: string; mimeType: string; size?: string;
  parents?: string[]; trashed?: boolean; createdTime?: string;
  modifiedTime?: string; md5Checksum?: string; capabilities?: Record<string, boolean>;
}
export interface DriveFilesListResponse {
  files?: DriveFileItem[]; nextPageToken?: string; incompleteSearch?: boolean;
}
export interface DriveFolderItem {
  id: string; name: string; mimeType: string;
}
export interface DriveFoldersListResponse {
  files?: DriveFolderItem[]; nextPageToken?: string;
}

// Google Drive "about" resource quota fields
// (developers.google.com/workspace/drive/api/reference/rest/v3/about). All
// fields are int64 byte counts delivered as JSON strings; "limit" is ABSENT
// for accounts with unlimited storage (e.g. Workspace pooled quota), so the
// UI must treat a missing limit as unlimited rather than 0.
const QUOTA_API_URL = 'https://www.googleapis.com/drive/v3/about';
const QUOTA_FIELDS = 'storageQuota';

export interface DriveStorageQuota {
  limit: number | null;
  usage: number;
  usageInDrive: number;
  usageInDriveTrash: number;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Merge a caller-supplied abort signal with a fresh timeout signal so a
// stalled network still fails after timeoutMs. A caller signal must NOT
// disable the timeout (same pattern as apiClient.fetchWithAuth); on runtimes
// lacking AbortSignal.any the timeout alone is used.
export function mergeWithTimeoutSignal(callerSignal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

// Derive a short, safe classification tag from an error's message ONLY.
// We never log the error object or its stack — those can leak file ids, user
// data, or (in theory) auth material into logs. Callers use this for observability.
export function classifyDriveError(err: unknown): string {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown-error";
  const m = msg.toLowerCase();
  if (m.includes("timeout") || m.includes("aborterror")) return "timeout";
  if (m.includes("network") || m.includes("failed to fetch") || m.includes("unreachable"))
    return "network";
  const statusMatch = m.match(/\((\d{3})\)/);
  if (statusMatch) return `http-${statusMatch[1]}`;
  return "unknown";
}

export function backoffDelay(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, MAX_DELAY_MS);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      const diff = dateMs - Date.now();
      if (diff > 0) return Math.min(diff, MAX_DELAY_MS);
    }
  }
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = Math.random() * exp * 0.5;
  return Math.min(exp + jitter, MAX_DELAY_MS);
}

export async function driveFetch(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  // Infinite loop: every iteration ends in `return res`, `throw err`, or a
  // `continue` gated by attempt < MAX_RETRIES — the loop can never exit
  // normally (TS needs the non-terminating form to accept the shape).
  for (let attempt = 0; ; attempt++) {
    try {
      // Fresh timeout signal per attempt (an aborted signal cannot be reused).
      // A caller-supplied signal must NOT disable the timeout — merge both so
      // a stalled network still fails after timeoutMs.
      const signal = mergeWithTimeoutSignal(options.signal, timeoutMs);
      const res = await fetchWithAuth(url, { ...options, signal, timeoutMs });

      if (attempt < MAX_RETRIES) {
        // 429/5xx are retryable by status alone; a 403 only when its body
        // reports a Drive rate limit. The body is read via a clone so the
        // response returned to the caller keeps its body; the clone is only
        // taken on attempts that could still retry (never for 2xx/5xx).
        const rateLimit403 = res.status === 403 && (await isRateLimit403Response(res));
        if (RETRYABLE_STATUS.has(res.status) || rateLimit403) {
          await sleep(backoffDelay(attempt, res.headers.get('Retry-After')));
          continue;
        }
      }
      return res;
    } catch (err) {
      // User-initiated cancel (unmount / navigation / folder switch) must NOT
      // be retried: re-firing an aborted request only wastes network and
      // prolongs spinners. A timeout fired on OUR merged signal (caller signal
      // NOT aborted) is still retryable — a stalled network is transient.
      if (options.signal?.aborted === true) {
        throw err;
      }
      // Network failure or timeout (AbortError) — transient, retry with backoff.
      if (attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw err;
    }
  }
}

// Google Drive error responses carry { error: { message, reason } }; only the
// public message/reason are read (never the raw body — it can embed file ids).
interface DriveErrorBody {
  error?: { message?: unknown; reason?: unknown };
}

async function readDriveErrorBody(response: Response): Promise<DriveErrorBody | null> {
  try {
    const data = await response.json();
    if (typeof data !== 'object' || data === null) return null;
    return data as DriveErrorBody;
  } catch {
    return null;
  }
}

// 403 rate-limit detection: Drive reports usage limits with the official
// reasons rateLimitExceeded / userRateLimitExceeded (handle-errors docs + the
// proSync worker precedent). Everything else on 403 (permissions…) is NOT a
// rate limit and must not be retried.
function isRateLimitError(status: number, errBody: DriveErrorBody | null): boolean {
  if (status !== 403) return false;
  const reason = typeof errBody?.error?.reason === 'string' ? errBody.error.reason : '';
  return DRIVE_RATE_LIMIT_REASONS.has(reason);
}

// Read a 403 body via a clone so the response handed back to the caller keeps
// its body intact (same clone pattern as the worker's isDriveRateLimitResponse).
// A clone/parse failure means we cannot confirm a rate limit → treat the 403
// as non-retryable (fail as before) instead of guessing.
export async function isRateLimit403Response(response: Response): Promise<boolean> {
  let cloned: Response;
  try {
    cloned = response.clone();
  } catch {
    return false;
  }
  return isRateLimitError(response.status, await readDriveErrorBody(cloned));
}

// Shared guard for the simple `Failed to <action> (status)` throw pattern.
// NOT used where a non-ok response has its own handling (null returns,
// captureError + detail parsing in moveFile, quota, etc.).
function assertDriveOk(response: Response, action: string): void {
  if (!response.ok) {
    throw new Error(`Failed to ${action} (${response.status})`);
  }
}

// signal?: AbortSignal wires a caller cancel (uploadManager batch controller)
// into the request; driveFetch already turns a caller abort into an immediate
// non-retried rejection. Optional: callers like useDriveExplorer omit it.
export async function createFolder(token: string, name: string, parentId: string, signal?: AbortSignal): Promise<DriveFileItem> {
  const metadata = {
    name: name,
    mimeType: FOLDER_MIME,
    parents: [parentId]
  };

  const response = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata),
    signal
  });

  assertDriveOk(response, 'create folder');
  return response.json();
}

export async function deleteFile(token: string, fileId: string): Promise<DriveFileItem> {
  // Move to trash instead of permanent delete for safety
  const metadata = {
    trashed: true,
    appProperties: {
      deletedByDrPlay: 'true'
    }
  };

  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });

  assertDriveOk(response, 'delete file');
  return response.json();
}

export async function moveFile(token: string, fileId: string, currentParentId: string, newParentId: string): Promise<DriveFileItem | { success: boolean }> {
  // First, get the actual parents of the file to ensure we remove it from all of them
  const getResponse = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  let removeParents = currentParentId;
  if (getResponse.ok) {
    const data = await getResponse.json();
    if (data.parents && data.parents.length > 0) {
      removeParents = data.parents.join(',');
      
      // If the file is already in the new parent, do nothing to prevent 400 error
      if (data.parents.includes(newParentId)) {
         return { success: true };
      }
    }
  }

  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParentId}&removeParents=${removeParents}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => null);
    // Do NOT log the raw error body (errData) — it can contain file ids / user
    // data. Log only the public status and a sanitized message (never the object).
    const detail =
      errData?.error?.message && typeof errData.error.message === "string"
        ? errData.error.message
        : null;
    captureError({ level: 'error', source: DRIVE_MODULE, message: `move-file-failed (status=${response.status}): ${detail ?? 'no detail'}` });
    throw new Error(`Failed to move file (${response.status})`);
  }
  return response.json();
}

export async function restoreFile(token: string, fileId: string): Promise<DriveFileItem> {
  const metadata = {
    trashed: false,
    appProperties: {
      deletedByDrPlay: null
    }
  };

  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });

  assertDriveOk(response, 'restore file');
  return response.json();
}

export async function permanentlyDeleteFile(token: string, fileId: string): Promise<boolean> {
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  assertDriveOk(response, 'permanently delete file');
  return true;
}

export async function getRecentlyAddedAudioFiles(token: string): Promise<DriveFileItem[]> {
  const q = getAudioFilesQuery();
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=createdTime desc&pageSize=5`;
  
  const response = await driveFetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  assertDriveOk(response, 'fetch recently added audio files');
  
  const data = await response.json();
  return data.files || [];
}

// Return the parent ids of a file/folder. Returns null when the Drive request
// fails (or the file has no parents) so callers can fall back to root.
export async function getFileParents(token: string, fileId: string, signal?: AbortSignal): Promise<string[] | null> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`;
  const response = await driveFetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal
  });
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return data.parents || [];
}

// Fetch a file/folder's display name. Returns null on failure.
export async function getFileName(token: string, fileId: string, signal?: AbortSignal): Promise<string | null> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name`;
  const response = await driveFetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal
  });
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return typeof data.name === "string" ? data.name : null;
}

// App Configuration in appDataFolder
// Search URL for the config file in appDataFolder (shared by getAppConfig and
// saveAppConfigInternal so both always query the exact same endpoint).
function buildConfigSearchUrl(): string {
  const q = `name = '${CONFIG_FILENAME}' and '${APP_DATA_FOLDER}' in parents`;
  return `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id)`;
}

export async function getAppConfig(token: string): Promise<Record<string, unknown> | null> {
  const url = buildConfigSearchUrl();
  
  try {
    const searchRes = await driveFetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    
    if (searchData.files && searchData.files.length > 0) {
      const fileId = searchData.files[0].id;
      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      const downloadRes = await driveFetch(downloadUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (downloadRes.ok) {
        return await downloadRes.json();
      }
    }
  } catch (e: unknown) {
    captureError({ level: 'error', source: DRIVE_MODULE, message: `get-config-failed: ${classifyDriveError(e)}` });
  }
  return null;
}

// Serialize config writes with a promise-chain mutex. Two concurrent saves
// would otherwise both search (find nothing), both POST, and create duplicate
// drplay_config.json files in appDataFolder (Drive has no conditional upsert).
// A chain of gate promises gives FIFO fairness (each task waits on the previous
// task's gate) without polling: no busy-wait, no wasted event-loop spins, no
// magic poll interval. release() always runs in finally, and prev.catch()
// swallows a rejected predecessor's gate so a failed save can never leave the
// lock stuck. Nested calls deadlock (a task awaiting its own gate) — same as
// the previous boolean-flag lock, so that behavior is unchanged.
// Exported (like backoffDelay) so tests can assert the lock semantics directly.
let lockTail: Promise<unknown> = Promise.resolve();

export async function withSaveConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const prev = lockTail;
  lockTail = gate;
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function saveAppConfigInternal(token: string, config: unknown): Promise<boolean> {
  const url = buildConfigSearchUrl();

  try {
    const searchRes = await driveFetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    let fileId = null;
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      if (searchData.files && searchData.files.length > 0) {
        fileId = searchData.files[0].id;
      }
    }

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const close_delim = `\r\n--${boundary}--`;

    const metadata = {
      name: CONFIG_FILENAME,
      mimeType: 'application/json',
      ...(fileId ? {} : { parents: [APP_DATA_FOLDER] })
    };

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(config) +
      close_delim;

    const uploadUrl = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

    const uploadRes = await driveFetch(uploadUrl, {
      method: fileId ? 'PATCH' : 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: multipartRequestBody
    });

    if (!uploadRes.ok) {
      captureError({ level: 'error', source: DRIVE_MODULE, message: `save-config-upload-failed (status=${uploadRes.status})` });
      return false;
    }
    return true;
  } catch (e: unknown) {
    captureError({ level: 'error', source: DRIVE_MODULE, message: `save-config-failed: ${classifyDriveError(e)}` });
    return false;
  }
}

export async function saveAppConfig(token: string, config: unknown): Promise<boolean> {
  return withSaveConfigLock(() => saveAppConfigInternal(token, config));
}

// Parse a Drive int64 field that arrives as a JSON string (or already a
// number). Returns null for anything non-numeric so callers can distinguish
// "absent" from "0".
function parseByteCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Fetch the signed-in user's Drive storage quota for the sidebar display.
// Quota is non-critical chrome: any failure returns null (never throws) and
// logs at 'warn' so the UI simply hides the section — a quota outage must
// never crash or block the sidebar.
export async function getDriveStorageQuota(token: string): Promise<DriveStorageQuota | null> {
  try {
    const response = await driveFetch(`${QUOTA_API_URL}?fields=${QUOTA_FIELDS}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) {
      captureError({ level: 'warn', source: DRIVE_MODULE, message: `get-storage-quota-failed (status=${response.status})` });
      return null;
    }
    const data = (await response.json()) as { storageQuota?: Record<string, unknown> } | null;
    const quota = data?.storageQuota;
    if (!quota) {
      captureError({ level: 'warn', source: DRIVE_MODULE, message: 'get-storage-quota-malformed-response (missing storageQuota)' });
      return null;
    }
    const limit = parseByteCount(quota.limit);
    const usage = parseByteCount(quota.usage);
    const usageInDrive = parseByteCount(quota.usageInDrive);
    const usageInDriveTrash = parseByteCount(quota.usageInDriveTrash);
    // The three usage fields are mandatory on a valid storageQuota object;
    // a payload missing any of them is malformed → treat as failure, hide UI.
    if (usage === null || usageInDrive === null || usageInDriveTrash === null) {
      captureError({ level: 'warn', source: DRIVE_MODULE, message: 'get-storage-quota-malformed-response (missing usage field)' });
      return null;
    }
    return { limit, usage, usageInDrive, usageInDriveTrash };
  } catch (err) {
    captureError({ level: 'warn', source: DRIVE_MODULE, message: `get-storage-quota-failed: ${classifyDriveError(err)}` });
    return null;
  }
}
