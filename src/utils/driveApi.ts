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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
      // A caller-supplied signal must NOT disable the timeout — merge both via
      // AbortSignal.any (same pattern as apiClient.fetchWithAuth) so a stalled
      // network still fails after timeoutMs; fall back to the timeout alone on
      // runtimes lacking AbortSignal.any.
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal =
        options.signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
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
