import React from "react";
import type { ReactVirtualizer } from "@tanstack/react-virtual";
import type { Track, DriveItem } from "../../../App";
import type { DbTagMetadata } from "./SongCard";
import { SongCard } from "./SongCard";

interface VirtualizedSongListProps {
  items: DriveItem[];
  rowVirtualizer: ReactVirtualizer<HTMLElement, Element>;
  onPlay: (track: Track) => void;
  onOpenFolder: (id: string, name: string) => void;
  token: string | null;
  currentFolderId: string;
  currentFolderName: string;
  folderHistory: { id: string; name: string }[];
  highlightedFileId: { id: string; ts: number } | null | undefined;
  isPlaying: string | undefined;
  onRefresh: () => void;
  onRemoveItem?: (id: string) => void;
  isSelectionMode: boolean;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setIsSelectionMode: React.Dispatch<React.SetStateAction<boolean>>;
  onBulkMoveClick: () => void;
  onBulkDeleteClick: () => void;
  tagMetadataMap?: Map<string, DbTagMetadata>;
}

export function VirtualizedSongList({
  items,
  rowVirtualizer,
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
  tagMetadataMap,
}: VirtualizedSongListProps) {
  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div
      style={{
        position: "relative",
        height: `${rowVirtualizer.getTotalSize()}px`,
        transform: "translateZ(0)",
      }}
    >
      {virtualItems.map((virtualRow) => {
        const item = items[virtualRow.index];
        if (!item) {
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              className="pb-3"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
                willChange: "transform",
              }}
            >
              <div className="h-[76px] rounded-xl bg-gray-100 dark:bg-[#1a1b1e] animate-pulse" />
            </div>
          );
        }
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            className="pb-3"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
              willChange: "transform",
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
              dbMetadata={tagMetadataMap?.get(item.trackInfo?.id ?? "")}
              isHighlighted={item.id === highlightedFileId?.id}
              highlightTrigger={item.id === highlightedFileId?.id ? highlightedFileId.ts : undefined}
              isPlaying={item.trackInfo?.id === isPlaying}
              onRefresh={onRefresh}
              onRemoveItem={onRemoveItem}
              isSelectionMode={isSelectionMode}
              isSelected={selectedIds.has(item.id)}
              onToggleSelection={() => {
                setSelectedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                });
              }}
              onEnableSelectionMode={() => {
                setIsSelectionMode(true);
                setSelectedIds(new Set([item.id]));
              }}
              onBulkMoveClick={onBulkMoveClick}
              onBulkDeleteClick={onBulkDeleteClick}
            />
          </div>
        );
      })}
    </div>
  );
}
