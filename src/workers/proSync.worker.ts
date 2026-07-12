import { db } from '../db/db';
import { getAudioQuery, isAudioFile } from '../utils/audioQuery';

let isBusy = false;
let currentToken: string | null = null;
let tokenRefreshResolver: ((value: boolean) => void) | null = null;
let syncRetryCount = 0;
const MAX_SYNC_RETRIES = 3;

async function waitForTokenRefresh(timeoutMs = 15000): Promise<boolean> {
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

self.onmessage = async (e: MessageEvent) => {
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
  if (!token || isBusy) return;

  currentToken = token;
  isBusy = true;
  try {
    await startProSync();
  } finally {
    isBusy = false;
  }
};

async function startProSync() {
  if (!currentToken) return;
  const tokenState = await db.syncState.get('startPageToken');

  if (!tokenState || !tokenState.value) {
    await performFullSync();
  } else {
    await performDeltaSync(tokenState.value);
  }
}

async function performFullSync() {
  if (!currentToken) return;
  let startToken = '';
  const tokenUrl = new URL("https://www.googleapis.com/drive/v3/changes/startPageToken");
  const tokenRes = await fetch(tokenUrl.toString(), {
    headers: { Authorization: `Bearer ${currentToken}` }
  });
  if (tokenRes.status === 401) {
    if (syncRetryCount >= MAX_SYNC_RETRIES) return;
    syncRetryCount++;
    self.postMessage({ type: 'TOKEN_EXPIRED' });
    const refreshed = await waitForTokenRefresh();
    if (refreshed) { syncRetryCount = 0; return performFullSync(); }
    return;
  }
  if (tokenRes.ok) {
    const tokenData = await tokenRes.json();
    startToken = tokenData.startPageToken;
  }

  let pageToken: string | undefined = undefined;

  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.append("q", getAudioQuery());
    url.searchParams.append("fields", "nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)");
    url.searchParams.append("pageSize", "1000");
    if (pageToken) url.searchParams.append("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${currentToken}` }
    });

    if (!res.ok) {
      if (res.status === 401) {
        if (syncRetryCount >= MAX_SYNC_RETRIES) break;
        syncRetryCount++;
        self.postMessage({ type: 'TOKEN_EXPIRED' });
        const refreshed = await waitForTokenRefresh();
        if (refreshed) { syncRetryCount = 0; continue; }
      }
      break;
    }
    const data = await res.json();

    const filesToInsert = (data.files || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parentId: f.parents && f.parents.length > 0 ? f.parents[0] : 'root',
      size: f.size ? parseInt(f.size, 10) : undefined,
      modifiedTime: f.modifiedTime,
      trashed: false,
      isFolder: f.mimeType === 'application/vnd.google-apps.folder'
    }));

    if (filesToInsert.length > 0) {
      await db.files.bulkPut(filesToInsert);
      self.postMessage({ type: 'SYNC_PROGRESS' });
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  if (startToken) {
    await db.syncState.put({ key: 'startPageToken', value: startToken });
  }

  self.postMessage({ type: 'SYNC_COMPLETE' });
}

async function performDeltaSync(startPageToken: string) {
  if (!currentToken) return;
  let pageToken = startPageToken;
  let newStartPageToken = startPageToken;

  do {
    const url = new URL("https://www.googleapis.com/drive/v3/changes");
    url.searchParams.append("pageToken", pageToken);
    url.searchParams.append("fields", "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,size,modifiedTime,trashed))");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${currentToken}` }
    });

    if (!res.ok) {
      if (res.status === 410) {
        syncRetryCount = 0;
        await db.syncState.delete('startPageToken');
        return performFullSync();
      }
      if (res.status === 401) {
        if (syncRetryCount >= MAX_SYNC_RETRIES) break;
        syncRetryCount++;
        self.postMessage({ type: 'TOKEN_EXPIRED' });
        const refreshed = await waitForTokenRefresh();
        if (refreshed) { syncRetryCount = 0; continue; }
      }
      break;
    }

    const data = await res.json();

    const changes = data.changes || [];
    let hasValidChanges = false;

    for (const change of changes) {
      if (change.removed || (change.file && change.file.trashed)) {
        await db.files.delete(change.fileId);
        hasValidChanges = true;
      } else if (change.file) {
        const isFolder = change.file.mimeType === 'application/vnd.google-apps.folder';

        if (isFolder || isAudioFile(change.file.mimeType, change.file.name)) {
          await db.files.put({
            id: change.file.id,
            name: change.file.name,
            mimeType: change.file.mimeType,
            parentId: change.file.parents && change.file.parents.length > 0 ? change.file.parents[0] : 'root',
            size: change.file.size ? parseInt(change.file.size, 10) : undefined,
            modifiedTime: change.file.modifiedTime,
            trashed: false,
            isFolder
          });
          hasValidChanges = true;
        }
      }
    }

    if (data.newStartPageToken) {
      newStartPageToken = data.newStartPageToken;
    }
    pageToken = data.nextPageToken;

    if (hasValidChanges) {
      self.postMessage({ type: 'SYNC_PROGRESS' });
    }
  } while (pageToken);

  if (newStartPageToken !== startPageToken) {
    await db.syncState.put({ key: 'startPageToken', value: newStartPageToken });
    self.postMessage({ type: 'SYNC_COMPLETE' });
  }
}
