export async function createFolder(token: string, name: string, parentId: string): Promise<any> {
  const metadata = {
    name: name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId]
  };

  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
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

  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
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
  const getResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`, {
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

  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParentId}&removeParents=${removeParents}`, {
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

  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
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
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
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
