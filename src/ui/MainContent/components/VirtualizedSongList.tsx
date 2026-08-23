import React from "react";
import { useVirtualizer, type ScrollToOptions } from "@tanstack/react-virtual";
import type { Track } from "../../../types";
import type { DriveItem } from "../../../types";
import { SongCard } from "./SongCard";
import {
  getUploadProgress,
  getUploadState,
  isUploading,
  subscribe as subscribeUploads,
} from "../../../utils/uploadManager";

// Monotonic upload-status version: bumped on every uploadManager notify so the
// virtualized list can re-derive each card's uploadState. Module-level (not
// component state) so a list remounted mid-upload still starts from the latest
// version — useSyncExternalStore re-reads the snapshot right after subscribing.
let uploadVersion = 0;

// Estimated height of one virtualized row: SongCard (~80px) + pb-3 wrapper (12px).
// Must match the real rendered height or the virtualizer miscalculates scroll
// offsets and scrollToIndex jumps to the wrong position.
const ROW_ESTIMATED_SIZE_PX = 92;

// Overscan of 15 rows (other lists use 3): this list renders SongCards with
// cover images on a slow Android WebView, so the larger buffer prevents blank
// flashes when fast scrolling outpaces image decode/layout.
const OVERSCAN_ROWS = 15;

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
    overscan: OVERSCAN_ROWS,
    getItemKey: (index: number) => items[index]?.id ?? index,
    useFlushSync: false,
    directDomUpdates: true,
  });

  // External-store subscription to uploadManager: every status change bumps
  // uploadVersion and re-renders this list; each visible card then re-derives
  // its own uploadState via getUploadState(item.id) and the SongCard memo
  // comparator skips cards whose state did not change.
  // Stable subscribe identity: useSyncExternalStore re-subscribes every time a
  // different subscribe function is passed on a re-render (react.dev caveat).
  // With directDomUpdates: true, scroll-only updates skip React re-renders —
  // the list re-renders only when the visible index range or isScrolling
  // changes — so memoize the wrapper to keep the subscription stable across
  // those re-renders.
  const subscribeUploadsStable = React.useCallback(
    (onStoreChange: () => void) =>
      subscribeUploads(() => {
        uploadVersion += 1;
        onStoreChange();
      }),
    [],
  );

  React.useSyncExternalStore(subscribeUploadsStable, () => uploadVersion);

  React.useImperativeHandle(ref, () => ({
    scrollToIndex: (index, options) => {
      rowVirtualizer.scrollToIndex(index, options);
    },
  }));

  const virtualItems = rowVirtualizer.getVirtualItems();

  const handleToggleSelection = React.useCallback(
    (id: string) => {
      // Upload race guard (UI layer): an uploading item must never be toggled
      // into the selection — bulk ops on it are impossible and the pending row
      // disappears when the upload finishes.
      if (isUploading(id)) return;
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
      if (isUploading(id)) return;
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
              uploadState={getUploadState(item.id)}
              uploadProgress={getUploadProgress(item.id)}
            />
          </div>
        );
      })}
    </div>
  );
});
