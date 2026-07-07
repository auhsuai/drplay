import { fetchWithAuth } from './apiClient';

export async function createFolder(token: string, name: string, parentId: string): Promise<any> {
  const metadata = {
    name: name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId]
  };

  const response = await fetchWithAuth('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });

  if (!response.ok) {
    throw new Error('Failed to create folder');
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

  const response = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });

  if (!response.ok) {
    throw new Error('Failed to delete file');
  }
  return response.json();
}

export async function moveFile(token: string, fileId: string, currentParentId: string, newParentId: string): Promise<any> {
  // First, get the actual parents of the file to ensure we remove it from all of them
  const getResponse = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`, {
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

  const response = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParentId}&removeParents=${removeParents}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => null);
    console.error("Drive API Move Error:", errData);
    throw new Error('Failed to move file');
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

  const response = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });

  if (!response.ok) {
    throw new Error('Failed to restore file');
  }
  return response.json();
}

export async function permanentlyDeleteFile(token: string, fileId: string): Promise<any> {
  const response = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error('Failed to permanently delete file');
  }
  return true;
}

export async function getRecentlyAddedAudioFiles(token: string): Promise<any[]> {
  const q = "mimeType contains 'audio/' and trashed = false";
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=createdTime desc&pageSize=5`;
  
  const response = await fetchWithAuth(url, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error('Failed to fetch recently added audio files');
  }
  
  const data = await response.json();
  return data.files || [];
}

// App Configuration in appDataFolder
export async function getAppConfig(token: string): Promise<any> {
  const q = "name = 'drplay_config.json' and 'appDataFolder' in parents";
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id)`;
  
  try {
    const searchRes = await fetchWithAuth(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    
    if (searchData.files && searchData.files.length > 0) {
      const fileId = searchData.files[0].id;
      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      const downloadRes = await fetchWithAuth(downloadUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (downloadRes.ok) {
        return await downloadRes.json();
      }
    }
  } catch (e) {
    console.error("Failed to get app config", e);
  }
  return null;
}

export async function saveAppConfig(token: string, config: any): Promise<void> {
  const q = "name = 'drplay_config.json' and 'appDataFolder' in parents";
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id)`;
  
  try {
    const searchRes = await fetchWithAuth(url, {
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

    await fetchWithAuth(uploadUrl, {
      method: fileId ? 'PATCH' : 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: multipartRequestBody
    });
  } catch (e) {
    console.error("Failed to save app config", e);
  }
}
