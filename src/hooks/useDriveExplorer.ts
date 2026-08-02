import { useState, useMemo, useEffect, useSyncExternalStore, useCallback } from 'react';
import type { DriveItem } from '../App';
import { useDebouncedLiveQuery } from './useDebouncedLiveQuery';
import { db, DriveFile } from '../db/db';
import { normalizeText } from '../utils/normalizeText';
import { deleteFile, moveFile, createFolder, driveFetch } from '../utils/driveApi';
import type { DriveFileItem } from '../utils/driveApi';
import { isUploading, getUploadState, subscribe as subscribeUploads } from '../utils/uploadManager';
import { showErrorToast } from '../utils/simpleToast';
import { t } from 'i18next';
import { captureError } from '../utils/errorLog';

import { useLiveQuery } from 'dexie-react-hooks';
import { metadataCache } from '../utils/metadata';
import { getFolderAudioQuery } from '../utils/audioQuery';
import { useDriveStore } from '../store/driveStore';

const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const ITEMS_PER_PAGE = 50;
const GLOBAL_SEARCH_LIMIT = 100;
const DRIVE_PAGE_SIZE = 1000;
const DEBOUNCE_DELAY_MS = 150;
const SEARCH_RESULT_LABEL = 'Search Result';
const UPLOADING_BLOCKED_FALLBACK = 'This item is being uploaded, please wait';

// Monotonic upload-status version: bumped on every uploadManager notify so the
// explorer re-runs the pin partition below with fresh getUploadState()
// verdicts (a started upload pins immediately, a finished one unpins).
// Module-level (same pattern as MainContent's VirtualizedSongList) so a
// remounted view still starts from the latest version — useSyncExternalStore
// re-reads the snapshot right after subscribing.
let uploadStatusVersion = 0;

// Bulk ops must never touch items that are still uploading (a pending row can
// not be deleted/moved — it has no Drive id yet). Excluded ids get a toast and
// the rest of the batch proceeds unchanged.
function filterUploading(ids: string[]): string[] {
  return ids.filter((id) => !isUploading(id));
}

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

  const stripExt = (name: string, isFolder: boolean) => isFolder ? name : name.replace(/\.[^/.]+$/, "");

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

  // Re-render on every upload status change so the pin partition below re-runs
  // with fresh getUploadState() verdicts while an upload is in flight.
  // Stable subscribe identity: useSyncExternalStore re-subscribes every time a
  // different subscribe function is passed on a re-render (react.dev caveat),
  // so the uploadManager wrapper is memoized to keep the subscription stable.
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeUploads(() => {
      uploadStatusVersion += 1;
      onStoreChange();
    }),
    [],
  );

  useSyncExternalStore(subscribe, () => uploadStatusVersion);

  // Global search data loading
  const globalSearchItemsRaw = useDebouncedLiveQuery(async () => {
    if (!searchQuery) return undefined;
    const query = normalizeText(searchQuery);
    const matches = await db.files
      .filter(f => normalizeText(f.name).includes(query))
      .limit(GLOBAL_SEARCH_LIMIT)
      .toArray();
    return matches;
  }, [searchQuery], DEBOUNCE_DELAY_MS);

  const globalSearchItems = useMemo(() => {
    if (!globalSearchItemsRaw) return [];
    
    const mapped = globalSearchItemsRaw.map(file => {
      const title = stripExt(file.name, file.isFolder);
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
          parentName: SEARCH_RESULT_LABEL,
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
      if (!currentFolderId) return Promise.resolve<DriveFile[]>([]);
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
    const abortController = new AbortController();
    
    const fetchOnDemand = async () => {
      try {
        const count = await db.files.where('parentId').equals(currentFolderId).count();
        if (count === 0) setIsLoadingTracks(true);

        const q = getFolderAudioQuery(currentFolderId);
        let hasMore = true;
        let pageToken: string | undefined = undefined;

        while (hasMore && isMounted && !abortController.signal.aborted) {
          const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)&pageSize=${DRIVE_PAGE_SIZE}${pageToken ? `&pageToken=${pageToken}` : ''}`;

          // driveFetch owns the retry policy (driveApi resilience layer):
          // 429/5xx and 403 rate-limit are retried with exponential backoff,
          // honoring Retry-After when present; a caller abort propagates as an
          // immediate rejection (Google handle-errors guidance). A response
          // returned here is final — retried or non-retryable.
          const res = await driveFetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: abortController.signal,
          });
          if (abortController.signal.aborted) break;

          if (!res.ok) {
            captureError({ level: 'warn', source: 'useDriveExplorer', message: `OnDemandFetch Drive API error: HTTP ${res.status} (folder=${currentFolderId})` });
            break;
          }
          const data = await res.json();
          if (abortController.signal.aborted) break;

          // Write each page to Dexie immediately instead of accumulating all
          // pages in memory (mirrors proSync.worker.ts full-sync pattern).
          if (isMounted && Array.isArray(data.files) && data.files.length > 0) {
            const filesToInsert = data.files.map((f: DriveFileItem) => ({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              parentId: currentFolderId,
              size: f.size ? parseInt(f.size, 10) : undefined,
              modifiedTime: f.modifiedTime,
              trashed: false,
              isFolder: f.mimeType === GOOGLE_FOLDER_MIME,
            }));
            try {
              await db.files.bulkPut(filesToInsert);
            } catch (dbErr) {
              captureError({ level: 'error', source: 'useDriveExplorer', message: `OnDemandFetch Dexie bulkPut failed (folder=${currentFolderId}, count=${filesToInsert.length}): ${String(dbErr)}` });
              break;
            }
          }

          pageToken = data.nextPageToken;
          if (!pageToken) hasMore = false;
        }
      } catch (err) {
        if (abortController.signal.aborted) return;
        if (err instanceof TypeError) {
          captureError({ level: 'warn', source: 'useDriveExplorer', message: `OnDemandFetch network error (folder=${currentFolderId}): ${err.message}` });
        } else {
          captureError({ level: 'error', source: 'useDriveExplorer', message: `OnDemandFetch unexpected error (folder=${currentFolderId}): ${err instanceof Error ? err.message : String(err)}` });
        }
      } finally {
        if (isMounted) setIsLoadingTracks(false);
      }
    };
    
    fetchOnDemand();
    return () => {
      isMounted = false;
      abortController.abort();
    };
  }, [currentFolderId, token, setIsLoadingTracks]);

  const items = useMemo(() => {
    if (!dbFiles) return [];
    const _items: DriveItem[] = dbFiles.map(file => {
      const title = stripExt(file.name, file.isFolder);
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

    // Pin items that are THEMSELVES uploading to the top of the list while the
    // upload runs — a just-started upload must be visible in My Drive even
    // when its name would sort to page 2+. Only 'uploading' pins: a folder
    // whose child is uploading ('parent-uploading') already exists on Drive
    // and must keep its normal sorted position (spinner only, no dim).
    const uploadingItems: DriveItem[] = [];
    const restItems: DriveItem[] = [];
    for (const item of _items) {
      if (getUploadState(item.id) === 'uploading') {
        uploadingItems.push(item);
      } else {
        restItems.push(item);
      }
    }

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    restItems.sort((a, b) => {
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

    // Uploading items keep their _items (dbFiles) order — pending rows are
    // inserted in upload enqueue order and the queue is strictly sequential,
    // so this mirrors the order uploads started, not the active sort option.
    return uploadingItems.length === 0 ? restItems : [...uploadingItems, ...restItems];
  }, [dbFiles, sortOption, currentFolderName, uploadStatusVersion]);

  const filteredItems = searchQuery ? globalSearchItems : items;
  const totalPages = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);
  
  const currentItems = useMemo(
    () => filteredItems.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE),
    [filteredItems, currentPage, ITEMS_PER_PAGE]
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
          mimeType: GOOGLE_FOLDER_MIME,
          isFolder: true,
          trashed: false,
          modifiedTime: new Date().toISOString()
        });
      }
      onRefresh();
      onComplete();
    } catch (e: unknown) {
      captureError({ level: 'error', source: 'useDriveExplorer', message: `create-folder failed: ${e instanceof Error ? e.message : String(e)}` });
      showErrorToast(t('drive.create_folder_error') || "Failed to create folder");
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const handleBulkDelete = async (onComplete: () => void) => {
    if (!token || selectedIds.size === 0) return;

    const itemsToDelete = filterUploading([...selectedIds]);
    if (itemsToDelete.length < selectedIds.size) {
      showErrorToast(t('upload.uploading_blocked') || UPLOADING_BLOCKED_FALLBACK);
    }
    if (itemsToDelete.length === 0) return;

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
        } catch (e: unknown) {
          failedIds.push(id);
          captureError({ level: 'error', source: 'useDriveExplorer', message: `bulk-delete failed for item ${id}: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
      if (deletedIds.length > 0) {
        await db.files.bulkDelete(deletedIds);
        if (onRemoveItem) deletedIds.forEach(id => onRemoveItem(id));
      }
      if (failedIds.length > 0) {
        showErrorToast(t('drive.delete_error') || "Failed to delete one or more items.");
      }
    } catch (e: unknown) {
      captureError({ level: 'error', source: 'useDriveExplorer', message: `bulk-delete unexpected error: ${e instanceof Error ? e.message : String(e)}` });
      showErrorToast(t('drive.delete_error') || "Failed to delete one or more items.");
    } finally {
      setIsBulkOperating(false);
      onComplete();
    }
  };

  const handleBulkMove = async (destinationFolderId: string, onComplete: () => void) => {
    if (!token || selectedIds.size === 0) return;

    const itemsToMove = filterUploading([...selectedIds]);
    if (itemsToMove.length < selectedIds.size) {
      showErrorToast(t('upload.uploading_blocked') || UPLOADING_BLOCKED_FALLBACK);
    }
    if (itemsToMove.length === 0) return;

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
        } catch (e: unknown) {
          failedIds.push(id);
          captureError({ level: 'error', source: 'useDriveExplorer', message: `bulk-move failed for item ${id}: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
      // Single transaction for the whole batch (vs. one update() per item);
      // missing keys are skipped without throwing, same as update().
      await db.files.bulkUpdate(movedIds.map(id => ({ key: id, changes: { parentId: destinationFolderId } })));
      if (onRemoveItem && movedIds.length > 0) movedIds.forEach(id => onRemoveItem(id));
      if (failedIds.length > 0) {
        showErrorToast(t('drive.move_error') || "Failed to move one or more items.");
      }
    } catch (e: unknown) {
      captureError({ level: 'error', source: 'useDriveExplorer', message: `bulk-move unexpected error: ${e instanceof Error ? e.message : String(e)}` });
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
  };
}
