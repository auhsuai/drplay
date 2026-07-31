import { useState, useMemo, useEffect } from 'react';
import { DriveItem } from '../App';
import { useDebouncedLiveQuery } from './useDebouncedLiveQuery';
import { db } from '../db/db';
import { normalizeText } from '../utils/normalizeText';
import { deleteFile, moveFile, createFolder } from '../utils/driveApi';
import { showErrorToast } from '../utils/simpleToast';
import { t } from 'i18next';

import { useLiveQuery } from 'dexie-react-hooks';
import { metadataCache } from '../utils/metadata';
import { getFolderAudioQuery } from '../utils/audioQuery';
import { fetchWithAuth } from '../utils/apiClient';
import { useDriveStore } from '../store/driveStore';

export function useDriveExplorer(
  currentFolderId: string,
  currentFolderName: string,
  token: string | null,
  onRefresh: () => void,
  onRemoveItem?: (id: string) => void,
  sortOption: string = "name_natural"
) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [isBulkOperating, setIsBulkOperating] = useState(false);

  // Reset page when folder, search, or sort changes
  useEffect(() => {
    setCurrentPage(1);
  }, [currentFolderId, searchQuery, sortOption]);

  // Reset highlight and search on folder change
  useEffect(() => {
    setSearchQuery("");
  }, [currentFolderId]);

  // Global search data loading
  const globalSearchItemsRaw = useDebouncedLiveQuery(async () => {
    if (!searchQuery) return undefined;
    const query = normalizeText(searchQuery);
    const matches = await db.files
      .filter(f => normalizeText(f.name).includes(query))
      .limit(100)
      .toArray();
    return matches;
  }, [searchQuery], 150);

  const globalSearchItems = useMemo(() => {
    if (!globalSearchItemsRaw) return [];
    
    const mapped = globalSearchItemsRaw.map(file => {
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
          parentName: "Search Result",
        }
      };
    });
    
    return mapped.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.title.localeCompare(b.title, undefined, { numeric: true });
    });
  }, [globalSearchItemsRaw]);

  const dbFiles = useLiveQuery(
    () => {
      if (!currentFolderId) return Promise.resolve<any[]>([]);
      return db.files.where('parentId').equals(currentFolderId).toArray()
    },
    [currentFolderId]
  );

  const setIsLoadingTracks = useDriveStore(state => state.setIsLoadingTracks);

  // On-Demand Fetching: Kéo nóng 1 trang từ Drive nếu thư mục chưa có trong Dexie
  useEffect(() => {
    if (!token || !currentFolderId || currentFolderId === '') return;
    
    // Nếu có dữ liệu rồi thì fetch ngầm (không hiện spinner)
    // Nếu chưa có (dbFiles undefined hoặc = 0), hiện spinner.
    let isMounted = true;
    
    const fetchOnDemand = async () => {
      try {
        const count = await db.files.where('parentId').equals(currentFolderId).count();
        if (count === 0) setIsLoadingTracks(true);

        const q = getFolderAudioQuery(currentFolderId);
        let hasMore = true;
        let pageToken: string | undefined = undefined;

        while (hasMore && isMounted) {
          const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`;
          const res = await fetchWithAuth(url, { headers: { Authorization: `Bearer ${token}` } });

          if (!res.ok) {
            console.warn(`[OnDemandFetch] Drive API error: HTTP ${res.status} (folder=${currentFolderId})`);
            break;
          }
          const data = await res.json();

          // Write each page to Dexie immediately instead of accumulating all
          // pages in memory (mirrors proSync.worker.ts full-sync pattern).
          if (isMounted && Array.isArray(data.files) && data.files.length > 0) {
            const filesToInsert = data.files.map((f: any) => ({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              parentId: currentFolderId,
              size: f.size ? parseInt(f.size, 10) : undefined,
              modifiedTime: f.modifiedTime,
              trashed: false,
              isFolder: f.mimeType === 'application/vnd.google-apps.folder',
            }));
            try {
              await db.files.bulkPut(filesToInsert);
            } catch (dbErr) {
              console.error(`[OnDemandFetch] Dexie bulkPut failed (folder=${currentFolderId}, count=${filesToInsert.length}):`, dbErr);
              break;
            }
          }

          pageToken = data.nextPageToken;
          if (!pageToken) hasMore = false;
        }
      } catch (err) {
        if (err instanceof TypeError) {
          // Network-level failure from fetch (DNS, offline, CORS, aborted).
          console.warn(`[OnDemandFetch] network error (folder=${currentFolderId}):`, err);
        } else {
          console.error(`[OnDemandFetch] unexpected error (folder=${currentFolderId}):`, err);
        }
      } finally {
        if (isMounted) setIsLoadingTracks(false);
      }
    };
    
    fetchOnDemand();
    return () => { isMounted = false; };
  }, [currentFolderId, token, setIsLoadingTracks]);

  const items = useMemo(() => {
    if (!dbFiles) return [];
    const _items: DriveItem[] = dbFiles.map(file => {
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
    return _items.sort((a, b) => {
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

  useEffect(() => {
    // cover prefetches are handled by useCoverPrefetch in MainContent
  }, [items, token]);

  const filteredItems = searchQuery ? globalSearchItems : items;
  const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
  
  const currentItems = useMemo(
    () => filteredItems.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage),
    [filteredItems, currentPage, itemsPerPage]
  );

  const handleCreateFolder = async (folderName: string, onComplete: () => void) => {
    if (!token) return;
    setIsCreatingFolder(true);
    try {
      const res = await createFolder(token, folderName, currentFolderId);
      if (res && res.id) {
        await db.files.put({
          id: res.id,
          name: res.name || folderName,
          parentId: currentFolderId,
          mimeType: 'application/vnd.google-apps.folder',
          isFolder: true,
          trashed: false,
          modifiedTime: new Date().toISOString()
        });
      }
      onRefresh();
      onComplete();
    } catch (e) {
      console.error("[useDriveExplorer] create-folder: Failed to create folder", e);
      showErrorToast(t('drive.create_folder_error') || "Failed to create folder");
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const handleBulkDelete = async (onComplete: () => void) => {
    if (!token || selectedIds.size === 0) return;
    
    const itemsToDelete = Array.from(selectedIds);
    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setIsBulkOperating(true);
    
    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    try {
      for (const id of itemsToDelete) {
        try {
          await deleteFile(token, id);
          deletedIds.push(id);
        } catch (e) {
          failedIds.push(id);
          console.error(`[useDriveExplorer] bulk-delete: Failed to delete item ${id}`, e);
        }
      }
      if (deletedIds.length > 0) {
        await db.files.bulkDelete(deletedIds);
        if (onRemoveItem) deletedIds.forEach(id => onRemoveItem(id));
      }
      if (failedIds.length > 0) {
        showErrorToast(t('drive.delete_error') || "Failed to delete one or more items.");
      }
    } catch (e) {
      console.error("[useDriveExplorer] bulk-delete: Unexpected error", e);
      showErrorToast(t('drive.delete_error') || "Failed to delete one or more items.");
    } finally {
      setIsBulkOperating(false);
      onComplete();
    }
  };

  const handleBulkMove = async (destinationFolderId: string, onComplete: () => void) => {
    if (!token || selectedIds.size === 0) return;
    
    const itemsToMove = Array.from(selectedIds);
    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setIsBulkOperating(true);
    
    const movedIds: string[] = [];
    const failedIds: string[] = [];
    try {
      for (const id of itemsToMove) {
        try {
          await moveFile(token, id, currentFolderId, destinationFolderId);
          movedIds.push(id);
        } catch (e) {
          failedIds.push(id);
          console.error(`[useDriveExplorer] bulk-move: Failed to move item ${id}`, e);
        }
      }
      for (const id of movedIds) {
        await db.files.update(id, { parentId: destinationFolderId });
      }
      if (onRemoveItem && movedIds.length > 0) movedIds.forEach(id => onRemoveItem(id));
      if (failedIds.length > 0) {
        showErrorToast(t('drive.move_error') || "Failed to move one or more items.");
      }
    } catch (e) {
      console.error("[useDriveExplorer] bulk-move: Unexpected error", e);
      showErrorToast(t('drive.move_error') || "Failed to move one or more items.");
    } finally {
      setIsBulkOperating(false);
      onComplete();
    }
  };

  return {
    searchQuery,
    setSearchQuery,
    currentPage,
    setCurrentPage,
    totalPages,
    currentItems,
    filteredItems,
    isSelectionMode,
    setIsSelectionMode,
    selectedIds,
    setSelectedIds,
    isCreatingFolder,
    isBulkOperating,
    handleCreateFolder,
    handleBulkDelete,
    handleBulkMove,
    itemsPerPage
  };
}
