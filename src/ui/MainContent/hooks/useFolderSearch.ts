import React, { useMemo } from "react";
import type { DriveItem } from "../../../App";
import { db } from "../../../db/db";
import { normalizeText } from "../../../utils/normalizeText";
import { useDebouncedLiveQuery } from "./useDebouncedLiveQuery";

interface UseFolderSearchParams {
  items: DriveItem[];
  currentFolderId: string;
  currentPage: number;
  itemsPerPage: number;
  searchQuery: string;
}

export interface FolderSearchResult {
  filteredItems: DriveItem[];
  currentItems: DriveItem[];
  totalPages: number;
}

export function useFolderSearch({
  items,
  currentFolderId,
  currentPage,
  itemsPerPage,
  searchQuery,
}: UseFolderSearchParams): FolderSearchResult {
  // Global search through all files
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

  const parentMap = React.useMemo(() => {
    if (!allFiles) return new Map<string, string>();
    const map = new Map<string, string>();
    allFiles.forEach(f => map.set(f.id, f.parentId));
    return map;
  }, [allFiles]);

  const globalSearchItemsRaw = React.useMemo(() => {
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

  const globalSearchItems = React.useMemo(() => {
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

  return { filteredItems, currentItems, totalPages };
}
