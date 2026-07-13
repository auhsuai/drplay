import { fetchWithAuth } from './apiClient';
import { getAudioFilesQuery } from './audioQuery';

// Google Drive API resilience layer.
// Official guidance (developers.google.com/workspace/drive/api/guides/limits):
// 403/429 rate-limit and 5xx transient errors must be retried with exponential
// backoff + jitter; honor the Retry-After header when present. 4xx (400/401/404)
// are NOT retried here — 401 refresh is handled inside fetchWithAuth.
const DRIVE_MODULE = "driveApi";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32000;
const DEFAULT_TIMEOUT_MS = 20000;

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
      // Fresh timeout signal per attempt (an aborted signal cannot be reused);
      // a caller-supplied signal takes precedence and is preserved across retries.
      const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
      const res = await fetchWithAuth(url, { ...options, signal });

      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt, res.headers.get('Retry-After')));
        continue;
      }
      return res;
    } catch (err) {
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

export async function createFolder(token: string, name: string, parentId: string): Promise<any> {
  const metadata = {
    name: name,
    mimeType: 'application/vnd.google-apps.folder',
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

export async function deleteFile(token: string, fileId: string): Promise<any> {
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

export async function moveFile(token: string, fileId: string, currentParentId: string, newParentId: string): Promise<any> {
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
    console.error(`[${DRIVE_MODULE}] move-file-failed`, {
      status: response.status,
      message: detail,
    });
    throw new Error(`Failed to move file (${response.status})`);
  }
  return response.json();
}

export async function restoreFile(token: string, fileId: string): Promise<any> {
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

export async function permanentlyDeleteFile(token: string, fileId: string): Promise<any> {
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

export async function getRecentlyAddedAudioFiles(token: string): Promise<any[]> {
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

// App Configuration in appDataFolder
export async function getAppConfig(token: string): Promise<any> {
  const q = "name = 'drplay_config.json' and 'appDataFolder' in parents";
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
  } catch (e) {
    console.error(`[${DRIVE_MODULE}] get-config-failed`, classifyDriveError(e));
  }
  return null;
}

// Serialize config writes with a promise-chain mutex. Two concurrent saves
// would otherwise both search (find nothing), both POST, and create duplicate
// drplay_config.json files in appDataFolder (Drive has no conditional upsert).
// Chaining forces the 2nd save to observe the file the 1st created → PATCH.
let saveConfigChain: Promise<unknown> = Promise.resolve();

async function saveAppConfigInternal(token: string, config: any): Promise<boolean> {
  const q = "name = 'drplay_config.json' and 'appDataFolder' in parents";
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
      name: 'drplay_config.json',
      mimeType: 'application/json',
      ...(fileId ? {} : { parents: ['appDataFolder'] })
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
      console.error(`[${DRIVE_MODULE}] save-config-upload-failed`, { status: uploadRes.status });
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[${DRIVE_MODULE}] save-config-failed`, classifyDriveError(e));
    return false;
  }
}

export function saveAppConfig(token: string, config: any): Promise<boolean> {
  const run = saveConfigChain.then(() => saveAppConfigInternal(token, config));
  // Keep the chain alive even if a save fails, and swallow here to avoid an
  // unhandled rejection; the real result/rejection is returned to the caller.
  saveConfigChain = run.catch(() => {});
  return run;
}
