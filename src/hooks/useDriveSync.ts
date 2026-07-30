import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { fetchWithAuth } from '../utils/apiClient';
import { getFolderAudioQuery } from '../utils/audioQuery';
import { metadataCache } from '../utils/metadata';
import { createFolderFetchGuard } from '../utils/folderFetchGuard';
import { DriveItem } from '../App';

const folderFetchGuard = createFolderFetchGuard();

function classifyAppError(err: unknown): string {
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

export function useDriveSync(
  isLoggedIn: boolean,
  accessToken: string | null,
  currentFolderId: string,
  currentFolderName: string,
  sortOption: string
) {
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);

  const fetchFolderContentsToDexie = async (token: string, folderId: string) => {
    const myId = folderFetchGuard.start();
    let fetchCompleted = true;
    try {
      const existingCount = await db.files.where('parentId').equals(folderId).count();
      if (existingCount === 0) {
        setIsLoadingTracks(true);
      }
      
      const q = getFolderAudioQuery(folderId);
      
      let pageToken: string | undefined = undefined;
      let allFiles: any[] = [];
      let isFirstPage = true;

      do {
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size)&pageSize=1000` + (pageToken ? `&pageToken=${pageToken}` : '');
        const response = await fetchWithAuth(url, { headers: { Authorization: `Bearer ${token}` } });

        if (!response.ok) {
          console.error(`[useDriveSync] Failed to fetch page from drive API`, response.status);
          fetchCompleted = false;
          break;
        }

        const data = await response.json();
        if (data.files && data.files.length > 0) {
          const filesToInsert = data.files.map((file: any) => ({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            parentId: folderId,
            size: (() => {
              const parsed = file.size ? parseInt(file.size, 10) : NaN;
              return Number.isFinite(parsed) ? parsed : undefined;
            })(),
            modifiedTime: file.modifiedTime,
            trashed: false,
            isFolder: file.mimeType === "application/vnd.google-apps.folder"
          }));
          
          await db.files.bulkPut(filesToInsert);
          allFiles = allFiles.concat(filesToInsert);
        }

        pageToken = data.nextPageToken;
        
        if (isFirstPage && pageToken && existingCount === 0 && folderFetchGuard.isLatest(myId)) {
          setIsLoadingTracks(false);
        }
        isFirstPage = false;
        
      } while (pageToken);

      if (fetchCompleted && !pageToken && folderFetchGuard.isLatest(myId)) {
        const fetchedIds = new Set(allFiles.map((f: any) => f.id));
        const localFiles = await db.files.where('parentId').equals(folderId).toArray();
        const idsToDelete = localFiles
          .filter(f => !fetchedIds.has(f.id))
          .map(f => f.id);
          
        if (idsToDelete.length > 0) {
          await db.files.bulkDelete(idsToDelete);
        }
      }
    } catch (error) {
      console.error(`[useDriveSync] Failed to fetch folder contents on demand:`, classifyAppError(error));
      fetchCompleted = false;
    } finally {
      if (folderFetchGuard.isLatest(myId)) {
        setIsLoadingTracks(false);
      }
    }
  };

  useEffect(() => {
    if (isLoggedIn && accessToken && currentFolderId) {
      fetchFolderContentsToDexie(accessToken, currentFolderId);
    }
  }, [isLoggedIn, accessToken, currentFolderId]);

  useEffect(() => {
    const handleRefreshDrive = () => {
      if (isLoggedIn && accessToken && currentFolderId) {
        fetchFolderContentsToDexie(accessToken, currentFolderId);
      }
    };
    window.addEventListener('refresh-drive', handleRefreshDrive);
    return () => window.removeEventListener('refresh-drive', handleRefreshDrive);
  }, [isLoggedIn, accessToken, currentFolderId]);

  useEffect(() => {
    const handleSyncComplete = () => setIsLoadingTracks(false);
    window.addEventListener('pro-sync-complete', handleSyncComplete);
    return () => {
      window.removeEventListener('pro-sync-complete', handleSyncComplete);
    };
  }, []);

  const dbFiles = useLiveQuery(
    () => {
      if (!currentFolderId) return Promise.resolve<any[]>([]);
      return db.files.where('parentId').equals(currentFolderId).toArray()
    },
    [currentFolderId]
  );

  const driveItems = useMemo(() => {
    if (!dbFiles) return [];
    const items: DriveItem[] = dbFiles.map(file => {
      const title = file.isFolder ? file.name : file.name.replace(/\.[^/.]+$/, "");
      return {
        id: file.id,
        title,
        isFolder: file.isFolder,
        size: file.size,
        modifiedTime: file.modifiedTime,
        trackInfo: file.isFolder ? undefined : {
          id: file.id,
          title,
          artist: "",
          streamUrl: "",
          size: file.size,
          originalName: file.name,
          parentId: file.parentId,
          parentName: currentFolderName,
        }
      };
    });

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return items.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      
      switch (sortOption) {
        case 'name': {
          const titleA = metadataCache[a.id]?.title || a.title;
          const titleB = metadataCache[b.id]?.title || b.title;
          return collator.compare(titleA, titleB);
        }
        case 'name desc': {
          const titleA = metadataCache[a.id]?.title || a.title;
          const titleB = metadataCache[b.id]?.title || b.title;
          return collator.compare(titleB, titleA);
        }
        case 'modifiedTime': {
          const timeA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
          const timeB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
          if (timeA === timeB) return collator.compare(a.title, b.title);
          return timeA - timeB;
        }
        case 'modifiedTime desc': {
          const timeA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
          const timeB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
          if (timeA === timeB) return collator.compare(a.title, b.title);
          return timeB - timeA;
        }
        case 'size': {
          const diff = (a.size || 0) - (b.size || 0);
          if (diff === 0) return collator.compare(a.title, b.title);
          return diff;
        }
        case 'size desc': {
          const diff = (b.size || 0) - (a.size || 0);
          if (diff === 0) return collator.compare(a.title, b.title);
          return diff;
        }
        default: {
          const titleA = metadataCache[a.id]?.title || a.title;
          const titleB = metadataCache[b.id]?.title || b.title;
          return collator.compare(titleA, titleB);
        }
      }
    });
  }, [dbFiles, sortOption, currentFolderName]);

  return { driveItems, isLoadingTracks, setIsLoadingTracks };
}
