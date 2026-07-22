import React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DriveItem } from "../../../App";

interface UseFileListVirtualizerParams {
  currentItems: DriveItem[];
  currentFolderId: string;
  searchQuery: string;
  sortOption: string;
  highlightedFileId?: { id: string; ts: number } | null;
  filteredItems: DriveItem[];
  itemsPerPage: number;
  currentPage: number;
  setCurrentPage: (page: number) => void;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
}

export function useFileListVirtualizer({
  currentItems,
  currentFolderId,
  searchQuery,
  sortOption,
  highlightedFileId,
  filteredItems,
  itemsPerPage,
  currentPage,
  setCurrentPage,
  scrollContainerRef,
}: UseFileListVirtualizerParams) {
  // Reset page when folder, search, or sort changes
  React.useEffect(() => {
    setCurrentPage(1);
  }, [currentFolderId, searchQuery, sortOption]);

  const rowVirtualizer = useVirtualizer({
    count: currentItems.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 92,
    overscan: 2,
    getItemKey: (index: number) => currentItems[index].id,
    // Skip React re-renders for scroll-only position updates (writes
    // transform/height straight to the DOM via elementsCache/containerRef
    // instead) -- only re-renders when the visible index range changes.
    // Set once at mount per the library's own guidance (not meant to be
    // toggled at runtime). Requires VirtualizedSongList's item wrappers to
    // stop setting `transform` themselves and the size container to use
    // `rowVirtualizer.containerRef` instead of an inline `height`.
    directDomUpdates: true,
  });

  // Scroll to top when going from empty to populated
  const prevItemsLengthRef = React.useRef(currentItems.length);
  React.useEffect(() => {
    if (prevItemsLengthRef.current === 0 && currentItems.length > 0) {
      rowVirtualizer.measure();
      rowVirtualizer.scrollToIndex(0, { align: 'start' });
    }
    prevItemsLengthRef.current = currentItems.length;
  }, [currentItems.length, rowVirtualizer]);

  // Highlight + scroll to file
  React.useEffect(() => {
    if (highlightedFileId && filteredItems.length > 0) {
      const index = filteredItems.findIndex(item => item.id === highlightedFileId.id);
      if (index !== -1) {
        const targetPage = Math.floor(index / itemsPerPage) + 1;
        if (targetPage !== currentPage) {
          setCurrentPage(targetPage);
          rowVirtualizer.measure();
          setTimeout(() => {
            rowVirtualizer.scrollToIndex(index % itemsPerPage, { align: 'center' });
          }, 50);
        } else {
          rowVirtualizer.scrollToIndex(index % itemsPerPage, { align: 'center' });
        }
      }
    }
  }, [highlightedFileId, currentPage, filteredItems, rowVirtualizer, itemsPerPage, setCurrentPage]);

  // Scroll to top on folder change (non-highlighted)
  const prevFolderRef = React.useRef(currentFolderId);
  React.useEffect(() => {
    if (scrollContainerRef.current) {
      const isFolderChange = currentFolderId !== prevFolderRef.current;
      if (isFolderChange && !highlightedFileId) {
        scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
      }
      prevFolderRef.current = currentFolderId;
    }
  }, [currentFolderId, highlightedFileId, scrollContainerRef]);

  return { rowVirtualizer };
}
