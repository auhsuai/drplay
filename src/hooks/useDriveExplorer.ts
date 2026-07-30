import { useState, useMemo, useEffect } from 'react';
import { DriveItem } from '../App';
import { useDebouncedLiveQuery } from './useDebouncedLiveQuery';
import { db } from '../db/db';
import { normalizeText } from '../utils/normalizeText';
import { deleteFile, moveFile, createFolder } from '../utils/driveApi';
import { showErrorToast } from '../utils/simpleToast';
import { t } from 'i18next';

export function useDriveExplorer(
  items: DriveItem[],
  currentFolderId: string,
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
  const allFiles = useDebouncedLiveQuery(async () => {
    if (!searchQuery) return undefined;
    const files = await db.files.toArray();
    return files.map(f => ({
      id: f.id,
      parentId: f.parentId,
      name: f.name,
      isFolder: f.isFolder,
      size: f.size,
      modifiedTime: f.modifiedTime,
    }));
  }, [searchQuery], 100);

  const parentMap = useMemo(() => {
    if (!allFiles) return new Map<string, string>();
    const map = new Map<string, string>();
    allFiles.forEach(f => map.set(f.id, f.parentId));
    return map;
  }, [allFiles]);

  const globalSearchItemsRaw = useMemo(() => {
    if (!searchQuery || !allFiles) return [];
    const query = normalizeText(searchQuery);

    const matches = allFiles.filter(f => normalizeText(f.name).includes(query));

    if (!currentFolderId || currentFolderId === 'root' || currentFolderId === '') {
      return matches;
    }

    return matches.filter(f => {
      let current: string | undefined = f.parentId;
      while (current) {
        if (current === currentFolderId) return true;
        current = parentMap.get(current);
      }
      return false;
    });
  }, [searchQuery, allFiles, currentFolderId, parentMap]);

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
