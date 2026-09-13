import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Track } from "../../types";
import { sameTrack } from "../../hooks/player/utils";
import { QueueFolderRow } from "./QueueFolderRow";
import { QueueRow, QUEUE_ROW_HEIGHT } from "./QueueRow";
import type { QueueViewItem } from "./queueView";

const QUEUE_OVERSCAN = 10;

export interface QueueListProps {
  items: QueueViewItem[];
  currentTrack: Track | null;
  selectionMode: boolean;
  selected: ReadonlySet<string>;
  emptyText: string;
  onSelectTrack: (track: Track) => void;
  onToggleSelected: (key: string) => void;
  onRemoveFromQueue: (key: string) => void;
  onRemoveFolderFromQueue: (folderId: string) => void;
  onOpenFolder: (folderId: string) => void;
}

/**
 * Scrollable virtualized queue list. Owns the virtualizer so the scroll
 * container and its measurements stay local; QueuePanel only feeds it the
 * already-filtered view items (folder rows collapsed) and callbacks.
 */
export function QueueList({
  items,
  currentTrack,
  selectionMode,
  selected,
  emptyText,
  onSelectTrack,
  onToggleSelected,
  onRemoveFromQueue,
  onRemoveFolderFromQueue,
  onOpenFolder,
}: QueueListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => QUEUE_ROW_HEIGHT,
    overscan: QUEUE_OVERSCAN,
    getItemKey: (index) => items[index]?.key ?? index,
  });

  const currentIndex = currentTrack
    ? items.findIndex(
        (item) => item.kind === "track" && sameTrack(item.track, currentTrack),
      )
    : -1;

  // Keep the playing row in view when the panel opens or the track changes.
  useEffect(() => {
    if (currentIndex < 0) return;
    virtualizer.scrollToIndex(currentIndex, { align: "center" });
  }, [currentIndex, virtualizer]);

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      {items.length === 0 ? (
        <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          {emptyText}
        </div>
      ) : (
        <div
          style={{
            position: "relative",
            width: "100%",
            height: virtualizer.getTotalSize(),
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            // Stale index while items shrink — guard like VirtualizedSongList.
            const item = items[virtualRow.index];
            if (!item) return null;
            if (item.kind === "folder") {
              return (
                <div
                  key={virtualRow.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: QUEUE_ROW_HEIGHT,
                    transform: `translateY(${String(virtualRow.start)}px)`,
                  }}
                >
                  <QueueFolderRow
                    folderId={item.folderId}
                    folderName={item.folderName}
                    count={item.count}
                    containsCurrent={item.containsCurrent}
                    selectionMode={selectionMode}
                    onOpen={() => {
                      onOpenFolder(item.folderId);
                    }}
                    onRemoveFolder={() => {
                      onRemoveFolderFromQueue(item.folderId);
                    }}
                  />
                </div>
              );
            }
            const { track, key } = item;
            // Root-folder removal: prefer the "add folder to queue" group id
            // (indexed in slice 1), fall back to the legacy direct parent.
            const folderId = track.folderGroupId ?? track.parentId;
            return (
              <div
                key={virtualRow.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: QUEUE_ROW_HEIGHT,
                  transform: `translateY(${String(virtualRow.start)}px)`,
                }}
              >
                <QueueRow
                  track={track}
                  isCurrent={
                    currentTrack !== null && sameTrack(track, currentTrack)
                  }
                  isChecked={selected.has(key)}
                  selectionMode={selectionMode}
                  onActivate={() => {
                    if (selectionMode) onToggleSelected(key);
                    else onSelectTrack(track);
                  }}
                  onToggleSelected={() => {
                    onToggleSelected(key);
                  }}
                  onRemoveFromQueue={() => {
                    onRemoveFromQueue(key);
                  }}
                  onRemoveFolderFromQueue={
                    folderId
                      ? () => {
                          onRemoveFolderFromQueue(folderId);
                        }
                      : undefined
                  }
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
