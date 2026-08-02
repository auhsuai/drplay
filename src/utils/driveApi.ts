import { fetchWithAuth } from './apiClient';
import { getAudioFilesQuery } from './audioQuery';
import { captureError } from './errorLog';

// Google Drive API resilience layer.
// Official guidance (developers.google.com/workspace/drive/api/guides/limits):
// 403/429 rate-limit and 5xx transient errors must be retried with exponential
// backoff + jitter; honor the Retry-After header when present. 4xx (400/401/404)
// are NOT retried here — 401 refresh is handled inside fetchWithAuth.
const DRIVE_MODULE = "driveApi";
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const CONFIG_FILENAME = 'drplay_config.json';
const APP_DATA_FOLDER = 'appDataFolder';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32000;
const DEFAULT_TIMEOUT_MS = 20000;
// Drive files.list caps each request at 1000 results (docs: values above 1000
// are coerced to 1000). We aggregate pages so large folders/searches are never
// silently truncated in the UI.
const PAGINATION_PAGE_SIZE = 1000;
// Worst-case safety cap: 10 pages = up to 10,000 results per call. Guards
// against a misbehaving server that keeps issuing nextPageToken forever.
const MAX_PAGINATION_PAGES = 10;
// Resumable upload (developers.google.com/drive/api/guides/manage-uploads):
// initiate via POST ?uploadType=resumable, then PUT the whole body once.
const RESUMABLE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
const UPLOAD_MIME_TYPE = 'application/octet-stream';
const UPLOAD_METADATA_CONTENT_TYPE = 'application/json; charset=UTF-8';
// Large audio files need a much longer bound than the 20s default used for
// metadata requests; 120s covers a 50MB file on a slow connection.
const UPLOAD_TIMEOUT_MS = 120_000;
// Google's resumable protocol forbids re-sending a completed PUT (it would
// create a NEW upload). A transient PUT failure therefore re-initiates the
// whole session at most once — never after the server answered 200/201.
const MAX_UPLOAD_ATTEMPTS = 2;

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Merge a caller-supplied abort signal with a fresh timeout signal so a
// stalled network still fails after timeoutMs. A caller signal must NOT
// disable the timeout (same pattern as apiClient.fetchWithAuth); on runtimes
// lacking AbortSignal.any the timeout alone is used.
function mergeWithTimeoutSignal(callerSignal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

// Derive a short, safe classification tag from an error's message ONLY.
// We never log the error object or its stack — those can leak file ids, user
// data, or (in theory) auth material into logs. Callers use this for observability.
function classifyDriveError(err: unknown): string {
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
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Fresh timeout signal per attempt (an aborted signal cannot be reused).
      // A caller-supplied signal must NOT disable the timeout — merge both so
      // a stalled network still fails after timeoutMs.
      const signal = mergeWithTimeoutSignal(options.signal, timeoutMs);
      const res = await fetchWithAuth(url, { ...options, signal });

      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt, res.headers.get('Retry-After')));
        continue;
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
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Drive request failed after retries');
}

export async function createFolder(token: string, name: string, parentId: string): Promise<DriveFileItem> {
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
    body: JSON.stringify(metadata)
  });

  if (!response.ok) {
    throw new Error(`Failed to create folder (${response.status})`);
  }
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

  if (!response.ok) {
    throw new Error(`Failed to delete file (${response.status})`);
  }
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

  if (!response.ok) {
    throw new Error(`Failed to restore file (${response.status})`);
  }
  return response.json();
}

export async function permanentlyDeleteFile(token: string, fileId: string): Promise<boolean> {
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to permanently delete file (${response.status})`);
  }
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

  if (!response.ok) {
    throw new Error(`Failed to fetch recently added audio files (${response.status})`);
  }
  
  const data = await response.json();
  return data.files || [];
}

// Aggregate ALL pages of a Drive files.list query. Drive caps each request at
// PAGINATION_PAGE_SIZE and signals more results via nextPageToken
// (developers.google.com/workspace/drive/api/reference/rest/v3/files/list).
// The official samples always include nextPageToken in the `fields` mask — a
// partial-response mask without it silently drops the token, so the caller
// MUST pass a fields string that contains it. Break (not throw) if the caller
// aborts between pages; per-request aborts still reject via driveFetch.
async function fetchAllFolderPages(
  token: string,
  query: string,
  fields: string,
  failureLabel: string,
  signal?: AbortSignal
): Promise<DriveFolderItem[]> {
  const baseUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=${fields}&orderBy=name&pageSize=${PAGINATION_PAGE_SIZE}`;
  const all: DriveFolderItem[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    if (signal?.aborted) break;
    const url = pageToken
      ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}`
      : baseUrl;
    const response = await driveFetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal
    });
    if (!response.ok) {
      throw new Error(`Failed to ${failureLabel} (${response.status})`);
    }
    const data = (await response.json()) as DriveFoldersListResponse;
    if (data.files) all.push(...data.files);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return all;
}

// Search for folders matching a fully-built Drive query string.
// `query` must already be a valid Drive q-expression (e.g. escaped/quoted).
export async function searchFolders(token: string, query: string, signal?: AbortSignal): Promise<DriveFolderItem[]> {
  return fetchAllFolderPages(token, query, 'nextPageToken,files(id,name)', 'search folders', signal);
}

// List immediate folder children (subfolders only, not trashed).
export async function listFolderChildren(token: string, folderId: string, signal?: AbortSignal): Promise<DriveFolderItem[]> {
  const q = `'${folderId}' in parents and trashed=false and mimeType='${FOLDER_MIME}'`;
  return fetchAllFolderPages(token, q, 'nextPageToken,files(id,name)', 'list folder children', signal);
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

// Fetch trashed items matching a fully-built Drive query string.
// Drive caps each request at PAGINATION_PAGE_SIZE results, so a trash list
// larger than one page was silently truncated without a nextPageToken loop
// (same pagination pattern as fetchAllFolderPages). nextPageToken MUST stay in
// the fields mask — Drive's partial response drops it otherwise. Keep
// orderBy=folder,name so folders sort before files in the trash screen.
export async function getTrashedFiles(token: string, query: string, signal?: AbortSignal): Promise<DriveFileItem[]> {
  const baseUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType)&orderBy=folder,name&pageSize=${PAGINATION_PAGE_SIZE}`;
  const all: DriveFileItem[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    if (signal?.aborted) break;
    const url = pageToken
      ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}`
      : baseUrl;
    const response = await driveFetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch trashed files (${response.status})`);
    }
    const data = (await response.json()) as DriveFilesListResponse;
    if (data.files) all.push(...data.files);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return all;
}

// App Configuration in appDataFolder
export async function getAppConfig(token: string): Promise<Record<string, unknown> | null> {
  const q = `name = '${CONFIG_FILENAME}' and '${APP_DATA_FOLDER}' in parents`;
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id)`;
  
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

// Serialize config writes with a simple async lock. Two concurrent saves
// would otherwise both search (find nothing), both POST, and create duplicate
// drplay_config.json files in appDataFolder (Drive has no conditional upsert).
let saveConfigLock = false;

async function withSaveConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  while (saveConfigLock) {
    await new Promise(r => setTimeout(r, 50));
  }
  saveConfigLock = true;
  try {
    return await fn();
  } finally {
    saveConfigLock = false;
  }
}

async function saveAppConfigInternal(token: string, config: unknown): Promise<boolean> {
  const q = `name = '${CONFIG_FILENAME}' and '${APP_DATA_FOLDER}' in parents`;
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id)`;

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

// Typed upload failure. kind lets callers (uploadManager) branch on the real
// cause without string-matching error messages: quota (storage full), network
// (transient, exhausted), auth (401), invalid (4xx / malformed response),
// aborted (caller cancelled).
export class UploadError extends Error {
  constructor(
    message: string,
    public readonly kind: 'quota' | 'network' | 'auth' | 'invalid' | 'aborted'
  ) {
    super(message);
    this.name = 'UploadError';
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

// 403 storage-quota detection: official reason storageQuotaExceeded with
// message "The user's Drive storage quota has been exceeded." (docs + real
// API traces). Everything else on 403 (e.g. rate-limit) stays 'invalid'.
function isQuotaExceeded(errBody: DriveErrorBody | null): boolean {
  const reason =
    typeof errBody?.error?.reason === 'string' ? errBody.error.reason.toLowerCase() : '';
  const message =
    typeof errBody?.error?.message === 'string' ? errBody.error.message.toLowerCase() : '';
  return reason.includes('quota') || message.includes('storage quota');
}

// Single mapper for both upload steps — non-retryable by design: a PUT retried
// after the server answered would create a duplicate upload.
function mapUploadHttpError(status: number, errBody: DriveErrorBody | null): UploadError {
  if (status === 401) return new UploadError('upload unauthorized (401)', 'auth');
  if (status === 403 && isQuotaExceeded(errBody)) return new UploadError('drive storage quota exceeded', 'quota');
  return new UploadError(`upload failed (status=${status})`, 'invalid');
}

// Step 1: initiate a resumable session. POST is idempotent (metadata only), so
// it safely reuses driveFetch's retry/backoff — unlike the PUT step below.
async function initiateResumableUpload(
  token: string,
  name: string,
  parentId: string,
  byteLength: number,
  signal: AbortSignal
): Promise<string> {
  const response = await driveFetch(RESUMABLE_UPLOAD_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': UPLOAD_METADATA_CONTENT_TYPE,
      'X-Upload-Content-Type': UPLOAD_MIME_TYPE,
      'X-Upload-Content-Length': String(byteLength)
    },
    body: JSON.stringify({ name, parents: [parentId] }),
    signal
  });

  if (!response.ok) {
    throw mapUploadHttpError(response.status, await readDriveErrorBody(response));
  }
  const location = response.headers.get('Location');
  if (!location) {
    throw new UploadError('resumable session returned no Location header', 'invalid');
  }
  return location;
}

// Step 2: PUT the whole body once. fetchWithAuth (NOT driveFetch) — it must
// never auto-retry, and it gives us the 401 token-refresh for free.
async function putResumableBytes(
  uploadUri: string,
  token: string,
  data: Uint8Array,
  signal: AbortSignal
): Promise<DriveFileItem> {
  const byteLength = data.byteLength;
  const response = await fetchWithAuth(uploadUri, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': UPLOAD_MIME_TYPE,
      'Content-Range': `bytes 0-${byteLength - 1}/${byteLength}`
    },
    body: data,
    signal,
    // fetchWithAuth's 15s internal default would kill a slow upload PUT well
    // before the resumable session's 120s bound (already merged into the
    // signal via mergeWithTimeoutSignal) — override so both stay in sync.
    timeoutMs: UPLOAD_TIMEOUT_MS
  });

  if (!response.ok) {
    throw mapUploadHttpError(response.status, await readDriveErrorBody(response));
  }
  try {
    return (await response.json()) as DriveFileItem;
  } catch (err) {
    captureError({ level: 'error', source: DRIVE_MODULE, message: `upload-parse-response-failed (status=${response.status}): ${classifyDriveError(err)}` });
    throw new UploadError('upload response was not valid JSON', 'invalid');
  }
}

// Upload file bytes to Drive via the resumable protocol (2 steps: POST
// initiate → PUT bytes). Non-retryable HTTP errors map to UploadError kinds;
// only transient network/timeout failures re-initiate the session, at most
// once. A caller abort (signal.aborted) always wins and never retries — a
// timeout fired on our merged signal is still treated as transient.
export async function uploadFileResumable(
  token: string,
  bytes: Blob | Uint8Array,
  name: string,
  parentId: string,
  signal?: AbortSignal
): Promise<DriveFileItem> {
  if (signal?.aborted) {
    throw new UploadError('upload aborted by caller', 'aborted');
  }

  const data = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
  const byteLength = data.byteLength;
  if (byteLength === 0) {
    // Google's resumable docs define no Content-Range format for empty files
    // (verified 2026-08-02); reject rather than risk a malformed upload.
    throw new UploadError('cannot upload an empty file', 'invalid');
  }

  const mergedSignal = mergeWithTimeoutSignal(signal, UPLOAD_TIMEOUT_MS);
  for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      throw new UploadError('upload aborted by caller', 'aborted');
    }
    try {
      const uploadUri = await initiateResumableUpload(token, name, parentId, byteLength, mergedSignal);
      return await putResumableBytes(uploadUri, token, data, mergedSignal);
    } catch (err) {
      if (signal?.aborted) {
        throw new UploadError('upload aborted by caller', 'aborted');
      }
      if (err instanceof UploadError) {
        throw err;
      }
      // Transient network/timeout — re-initiate a fresh session (Google: a
      // 4xx/expired session must be restarted from scratch).
      captureError({ level: 'warn', source: DRIVE_MODULE, message: `upload-transient-failure (attempt=${attempt + 1}/${MAX_UPLOAD_ATTEMPTS}): ${classifyDriveError(err)}` });
    }
  }
  throw new UploadError(`upload failed after ${MAX_UPLOAD_ATTEMPTS} attempts`, 'network');
}
