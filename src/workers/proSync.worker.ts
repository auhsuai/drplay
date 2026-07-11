import { db } from '../db/db';

let isBusy = false;

self.onmessage = async (e: MessageEvent) => {
  const { token } = e.data;
  if (!token || isBusy) return;
  isBusy = true;
  try {
    await startProSync(token);
  } finally {
    isBusy = false;
  }
};

async function startProSync(token: string) {
  // Check if we have a startPageToken
  const tokenState = await db.syncState.get('startPageToken');
  
  if (!tokenState || !tokenState.value) {
    // Initial Full Sync
    await performFullSync(token);
  } else {
    // Delta Sync
    await performDeltaSync(token, tokenState.value);
  }
}

async function performFullSync(token: string) {
  // Fetch startPageToken BEFORE full sync to avoid missing changes that happen during sync
  let startToken = '';
  const tokenUrl = new URL("https://www.googleapis.com/drive/v3/changes/startPageToken");
  const tokenRes = await fetch(tokenUrl.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (tokenRes.ok) {
    const tokenData = await tokenRes.json();
    startToken = tokenData.startPageToken;
  }

  let pageToken: string | undefined = undefined;
  
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.append("q", "trashed=false and (mimeType='application/vnd.google-apps.folder' or mimeType contains 'audio/')");
    url.searchParams.append("fields", "nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)");
    url.searchParams.append("pageSize", "1000");
    if (pageToken) url.searchParams.append("pageToken", pageToken);
    
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (!res.ok) break;
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

async function performDeltaSync(token: string, startPageToken: string) {
  let pageToken = startPageToken;
  let newStartPageToken = startPageToken;
  
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/changes");
    url.searchParams.append("pageToken", pageToken);
    url.searchParams.append("fields", "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,size,modifiedTime,trashed))");
    
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (!res.ok) {
      // If token is expired/invalid (410 Gone), we need a full resync
      if (res.status === 410) {
         await db.syncState.delete('startPageToken');
         return performFullSync(token);
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
        // Only insert if it's audio or folder
        const isFolder = change.file.mimeType === 'application/vnd.google-apps.folder';
        const isAudio = change.file.mimeType?.includes('audio/');
        
        if (isFolder || isAudio) {
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
