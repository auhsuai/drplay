import React from "react";
import { useVirtualizer, type ScrollToOptions } from "@tanstack/react-virtual";
import type { Track } from "../../../types";
import type { DriveItem } from "../../../types";
import { SongCard } from "./SongCard";

// Estimated height of one virtualized row: SongCard (~80px) + pb-3 wrapper (12px).
// Must match the real rendered height or the virtualizer miscalculates scroll
// offsets and scrollToIndex jumps to the wrong position.
const ROW_ESTIMATED_SIZE_PX = 92;

export type VirtualizedSongListHandle = {
  scrollToIndex: (index: number, options?: ScrollToOptions) => void;
};

export const VirtualizedSongList = React.memo(function VirtualizedSongList({
  items,
  scrollElementRef,
  onPlay,
  onOpenFolder,
  token,
  currentFolderId,
  currentFolderName,
  folderHistory,
  highlightedFileId,
  isPlaying,
  onRefresh,
  onRemoveItem,
  isSelectionMode,
  selectedIds,
  setSelectedIds,
  setIsSelectionMode,
  onBulkMoveClick,
  onBulkDeleteClick,
  ref,
}: {
  items: DriveItem[];
  scrollElementRef: React.RefObject<HTMLElement | null>;
  onPlay: (track: Track) => void;
  onOpenFolder: (id: string, name: string) => void;
  token: string | null;
  currentFolderId: string;
  currentFolderName: string;
  folderHistory: { id: string; name: string }[];
  highlightedFileId:
    { id: string; ts: number; folderId: string } | null | undefined;
  isPlaying: string | undefined;
  onRefresh: () => void;
  onRemoveItem?: ((id: string) => void) | undefined;
  isSelectionMode: boolean;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setIsSelectionMode: React.Dispatch<React.SetStateAction<boolean>>;
  onBulkMoveClick: () => void;
  onBulkDeleteClick: () => void;
  ref?: React.Ref<VirtualizedSongListHandle>;
}) {
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => ROW_ESTIMATED_SIZE_PX,
    overscan: 15,
    getItemKey: (index: number) => items[index]?.id ?? index,
    useFlushSync: false,
    directDomUpdates: true,
  });

  React.useImperativeHandle(ref, () => ({
    scrollToIndex: (index, options) => {
      rowVirtualizer.scrollToIndex(index, options);
    },
  }));

  const virtualItems = rowVirtualizer.getVirtualItems();

  const handleToggleSelection = React.useCallback(
    (id: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [setSelectedIds],
  );

  const handleEnableSelectionMode = React.useCallback(
    (id: string) => {
      setIsSelectionMode(true);
      setSelectedIds(new Set([id]));
    },
    [setIsSelectionMode, setSelectedIds],
  );

  return (
    <div
      ref={rowVirtualizer.containerRef}
      style={{
        position: "relative",
        width: "100%",
        pointerEvents: rowVirtualizer.isScrolling ? "none" : "auto",
      }}
    >
      {virtualItems.map((virtualRow) => {
        // The virtualizer can briefly report a stale index while the items
        // list is being filtered/replaced (count changes async), so the
        // runtime guard stays even though the array type says non-null.
        const item = items[virtualRow.index];
        if (!item) return null;
        return (
          <div
            key={virtualRow.key}
            ref={rowVirtualizer.measureElement}
            data-index={virtualRow.index}
            className="pb-3"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
            }}
          >
            <SongCard
              item={item}
              onPlay={onPlay}
              onOpenFolder={onOpenFolder}
              token={token}
              currentFolderId={currentFolderId}
              currentFolderName={currentFolderName}
              folderHistory={folderHistory}
              isHighlighted={item.id === highlightedFileId?.id}
              highlightTrigger={
                item.id === highlightedFileId?.id
                  ? highlightedFileId.ts
                  : undefined
              }
              isPlaying={!!isPlaying && item.trackInfo?.id === isPlaying}
              onRefresh={onRefresh}
              onRemoveItem={onRemoveItem}
              isSelectionMode={isSelectionMode}
              isSelected={selectedIds.has(item.id)}
              onToggleSelection={handleToggleSelection}
              onEnableSelectionMode={handleEnableSelectionMode}
              onBulkMoveClick={onBulkMoveClick}
              onBulkDeleteClick={onBulkDeleteClick}
            />
          </div>
        );
      })}
    </div>
  );
});
