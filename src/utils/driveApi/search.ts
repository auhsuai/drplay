import { driveFetch } from './core';

// Search for folders matching a fully-built Drive query string.
// `query` must already be a valid Drive q-expression (e.g. escaped/quoted).
export async function searchFolders(token: string, query: string, signal?: AbortSignal): Promise<any[]> {
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&orderBy=name&pageSize=30`;
  const response = await driveFetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal
  });
  if (!response.ok) {
    throw new Error(`Failed to search folders (${response.status})`);
  }
  const data = await response.json();
  return data.files || [];
}

// List immediate folder children (subfolders only, not trashed).
export async function listFolderChildren(token: string, folderId: string, signal?: AbortSignal): Promise<any[]> {
  const q = `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=name`;
  const response = await driveFetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal
  });
  if (!response.ok) {
    throw new Error(`Failed to list folder children (${response.status})`);
  }
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

// Fetch trashed items matching a fully-built Drive query string.
export async function getTrashedFiles(token: string, query: string, signal?: AbortSignal): Promise<any[]> {
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType)&orderBy=folder,name`;
  const response = await driveFetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch trashed files (${response.status})`);
  }
  const data = await response.json();
  return data.files || [];
}
