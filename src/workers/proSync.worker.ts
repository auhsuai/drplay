import { db } from '../db/db';
import type { DriveFile as DriveFileRow } from '../db/db';
import { getAudioQuery, isAudioFile } from '../utils/audioQuery';
import { classifyWorkerError, logWorkerError, WorkerAbortError } from './workerError';

interface DriveFile {
  id?: string; name?: string; mimeType?: string; size?: string;
  parents?: string[]; trashed?: boolean; createdTime?: string;
  modifiedTime?: string; md5Checksum?: string;
}
interface DriveChangesList { changes?: DriveChange[]; nextPageToken?: string; newStartPageToken?: string; }
interface DriveChange { file?: DriveFile; fileId?: string; removed?: boolean; changeType?: string; }

let isBusy = false;
let currentToken: string | null = null;
let tokenRefreshResolver: ((value: boolean) => void) | null = null;
const MAX_SYNC_RETRIES = 3;
const syncRetry = { count: 0, max: MAX_SYNC_RETRIES };
const SYNC_FETCH_TIMEOUT_MS = 30000;
const TOKEN_REFRESH_TIMEOUT_MS = 15000;
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

function toSize(raw: string | undefined | null): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

// Shared mapping of a Google Drive file resource to the DB row shape used by
// both full-sync and delta-sync. isFolder is a parameter so callers that
// already computed it (delta-sync) don't recompute it.
export function toDriveFileRow(f: DriveFile, isFolder: boolean): DriveFileRow {
  return {
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    parentId: f.parents && f.parents.length > 0 ? f.parents[0] : 'root',
    size: toSize(f.size),
    modifiedTime: f.modifiedTime,
    trashed: false,
    isFolder,
  };
}

async function waitForTokenRefresh(timeoutMs = TOKEN_REFRESH_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      tokenRefreshResolver = null;
      resolve(false);
    }, timeoutMs);
    tokenRefreshResolver = (ok: boolean) => {
      clearTimeout(timer);
      tokenRefreshResolver = null;
      resolve(ok);
    };
  });
}

export interface SyncRetryState {
  count: number;
  max: number;
}

// Injected deps so unit tests can stub postMessage / waitForTokenRefresh
// without a real worker scope or network.
export interface RefreshTokenRetryDeps {
  postMessage: (msg: { type: string }) => void;
  waitForTokenRefresh: () => Promise<boolean>;
}

// Shared 401 handler used by all three Drive fetch loops (full-sync
// startPageToken, full-sync files, delta-sync changes). Returns true when the
// caller should retry the request after a successful token refresh; returns
// false when it must give up (retries exhausted) or the refresh failed, and
// the caller decides whether to return/break. Extracted so the retry-count
// logic lives in one place instead of being copy-pasted three times.
export async function refreshTokenAndRetry(
  state: SyncRetryState,
  deps: RefreshTokenRetryDeps,
  ctx: string,
): Promise<boolean> {
  if (state.count >= state.max) {
    logWorkerError(
      'proSync/' + ctx,
      { kind: 'auth', status: 401, reason: 'max-retries' },
      new Error('token refresh retries exhausted'),
      'error'
    );
    deps.postMessage({ type: 'SYNC_ERROR' });
    return false;
  }
  state.count += 1;
  deps.postMessage({ type: 'TOKEN_EXPIRED' });
  const refreshed = await deps.waitForTokenRefresh();
  if (refreshed) {
    state.count = 0;
    return true;
  }
  return false;
}

// Production bindings: post to the worker's parent scope and wait on the
// module-level refresh resolver. Tests inject their own deps instead.
const syncRetryDeps: RefreshTokenRetryDeps = {
  postMessage: (msg) => self.postMessage(msg),
  waitForTokenRefresh: () => waitForTokenRefresh(),
};

// Guard so the module can be imported in node-based unit tests (vitest), where
// `self` does not exist. In a real worker `self` is always defined, so the
// listener registration is unchanged.
if (typeof self !== 'undefined') {
self.addEventListener('message', async (e: MessageEvent) => {
  const { type, token } = e.data;

  if (type === 'token') {
    currentToken = token;
    if (tokenRefreshResolver) {
      tokenRefreshResolver(true);
      tokenRefreshResolver = null;
    }
    return;
  }

  if (type !== 'sync') return;
  if (isBusy) { self.postMessage({ type: 'SYNC_BUSY' }); return; }
  if (!token) { self.postMessage({ type: 'SYNC_NO_TOKEN' }); return; }

  currentToken = token;
  isBusy = true;
  try {
    await startProSync();
  } finally {
    isBusy = false;
  }
});
}

// fetch() wrapper that applies the shared timeout and classifies transport
// failures (network / timeout / abort). HTTP status is still the caller's job.
async function fetchDrive(ctx: string, token: string, url: URL): Promise<Response> {
  try {
    return await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const kind = classifyWorkerError(err);
    if (kind === 'abort') {
      logWorkerError('proSync/' + ctx, { kind }, err, 'warn');
      throw new WorkerAbortError(`aborted during ${ctx}`);
    }
    if (kind === 'timeout') {
      logWorkerError('proSync/' + ctx, { kind, timeoutMs: SYNC_FETCH_TIMEOUT_MS }, err, 'error');
    } else {
      logWorkerError('proSync/' + ctx, { kind }, err, 'error');
    }
    throw err;
  }
}

// Parse a Drive JSON response, surfacing malformed bodies as a logged failure
// instead of an unhandled rejection that aborts the whole sync.
async function parseDriveJson<T = Record<string, unknown>>(ctx: string, res: Response): Promise<T> {
  try {
    return await res.json();
  } catch (err) {
    logWorkerError('proSync/' + ctx, { status: res.status, kind: 'parse' }, err, 'error');
    throw err;
  }
}

async function startProSync() {
  if (!currentToken) return;
  try {
    const tokenState = await db.syncState.get('startPageToken');

    if (!tokenState || !tokenState.value) {
      await performFullSync();
    } else {
      await performDeltaSync(tokenState.value as string);
    }
  } catch (err) {
    // Safety net for the Dexie read above and any error that escaped the
    // per-function handlers. We still inform the main thread.
    logWorkerError('proSync/start', {}, err, 'error');
    self.postMessage({ type: 'SYNC_ERROR' });
  }
}

async function performFullSync() {
  if (!currentToken) return;
  let startToken = '';

  // Retry the whole pass only when the startPageToken fetch hits 401 and the
  // main thread successfully refreshes the token.
  let retryFullSync = true;
  while (retryFullSync) {
    retryFullSync = false;

    try {
      const tokenUrl = new URL('https://www.googleapis.com/drive/v3/changes/startPageToken');
      const tokenRes = await fetchDrive('startPageToken', currentToken, tokenUrl);

      if (tokenRes.status === 401) {
        if (!(await refreshTokenAndRetry(syncRetry, syncRetryDeps, 'full-sync/startPageToken'))) return;
        retryFullSync = true;
        continue;
      }
      if (tokenRes.ok) {
        const tokenData = await parseDriveJson<{ startPageToken: string }>('startPageToken', tokenRes);
        startToken = tokenData.startPageToken;
      }
    } catch (err) {
      if (err instanceof WorkerAbortError) return;
      logWorkerError('proSync/full-sync', { phase: 'startPageToken' }, err, 'error');
      return;
    }

    let pageToken: string | undefined = undefined;
    try {
      do {
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        url.searchParams.append('q', getAudioQuery());
        url.searchParams.append('fields', 'nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)');
        url.searchParams.append('pageSize', '1000');
        if (pageToken) url.searchParams.append('pageToken', pageToken);

        const res = await fetchDrive('files', currentToken, url);

        if (!res.ok) {
          if (res.status === 401) {
            if (await refreshTokenAndRetry(syncRetry, syncRetryDeps, 'full-sync/files')) continue;
          }
          break;
        }

        const data = await parseDriveJson<{ files?: DriveFile[]; nextPageToken?: string }>('files', res);

        const filesToInsert = (data.files || []).map((f: DriveFile) =>
          toDriveFileRow(f, f.mimeType === FOLDER_MIME_TYPE)
        );

        if (filesToInsert.length > 0) {
          try {
            await db.files.bulkPut(filesToInsert);
            self.postMessage({ type: 'SYNC_PROGRESS' });
          } catch (err) {
            logWorkerError('proSync/full-sync', { phase: 'bulkPut', count: filesToInsert.length }, err, 'error');
            break;
          }
        }

      pageToken = data.nextPageToken ?? '';
      } while (pageToken);
    } catch (err) {
      if (err instanceof WorkerAbortError) return;
      logWorkerError('proSync/full-sync', { phase: 'files' }, err, 'error');
    }
  }

  if (startToken) {
    try {
      await db.syncState.put({ key: 'startPageToken', value: startToken });
    } catch (err) {
      logWorkerError('proSync/full-sync', { phase: 'saveStartToken' }, err, 'error');
    }
  }

  self.postMessage({ type: 'SYNC_COMPLETE' });
}

async function performDeltaSync(startPageToken: string) {
  if (!currentToken) return;
  let pageToken = startPageToken;
  let newStartPageToken = startPageToken;

  try {
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/changes');
      url.searchParams.append('pageToken', pageToken);
      url.searchParams.append('fields', 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,size,modifiedTime,trashed))');

      const res = await fetchDrive('changes', currentToken, url);

      if (!res.ok) {
        if (res.status === 410) {
          syncRetry.count = 0;
          try {
            await db.syncState.delete('startPageToken');
          } catch (err) {
            logWorkerError('proSync/delta-sync', { phase: 'deleteStartToken' }, err, 'error');
          }
          await performFullSync();
          return;
        }
        if (res.status === 401) {
          if (await refreshTokenAndRetry(syncRetry, syncRetryDeps, 'delta-sync/changes')) continue;
        }
        break;
      }

      const data = await parseDriveJson<DriveChangesList>('changes', res);

      const changes = data.changes || [];
      let hasValidChanges = false;

      for (const change of changes) {
        try {
          if (change.removed || (change.file && change.file.trashed)) {
            await db.files.delete(change.fileId!);
            hasValidChanges = true;
          } else if (change.file) {
            const file = change.file;
            const isFolder = file.mimeType === FOLDER_MIME_TYPE;

            if (isFolder || isAudioFile(file.mimeType!, file.name!)) {
              await db.files.put(toDriveFileRow(file, isFolder));
              hasValidChanges = true;
            }
          }
        } catch (err) {
          // One bad change must not abort the whole delta batch.
          logWorkerError('proSync/delta-sync', { phase: 'applyChange', fileId: change.fileId }, err, 'error');
        }
      }

      if (data.newStartPageToken) {
        newStartPageToken = data.newStartPageToken;
      }
      pageToken = data.nextPageToken ?? '';

      if (hasValidChanges) {
        self.postMessage({ type: 'SYNC_PROGRESS' });
      }
    } while (pageToken);

    if (newStartPageToken !== startPageToken) {
      try {
        await db.syncState.put({ key: 'startPageToken', value: newStartPageToken });
      } catch (err) {
        logWorkerError('proSync/delta-sync', { phase: 'saveStartToken' }, err, 'error');
      }
      self.postMessage({ type: 'SYNC_COMPLETE' });
    }
  } catch (err) {
    if (err instanceof WorkerAbortError) return;
    logWorkerError('proSync/delta-sync', { phase: 'changes' }, err, 'error');
  }
}
