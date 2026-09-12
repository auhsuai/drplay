import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Track } from "../../types";
import { sameTrack } from "../../hooks/player/utils";
import { QueueRow, QUEUE_ROW_HEIGHT } from "./QueueRow";

const QUEUE_OVERSCAN = 10;

const trackKey = (track: Track): string => track.queueItemId ?? track.id;

export interface QueueListProps {
  items: Track[];
  currentTrack: Track | null;
  selectionMode: boolean;
  selected: ReadonlySet<string>;
  emptyText: string;
  onSelectTrack: (track: Track) => void;
  onToggleSelected: (key: string) => void;
  onRemoveFromQueue: (key: string) => void;
  onRemoveFolderFromQueue: (parentId: string) => void;
}

/**
 * Scrollable virtualized queue list. Owns the virtualizer so the scroll
 * container and its measurements stay local; QueuePanel only feeds it the
 * already-filtered items and callbacks.
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
}: QueueListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => QUEUE_ROW_HEIGHT,
    overscan: QUEUE_OVERSCAN,
    getItemKey: (index) => {
      const track = items[index];
      return track ? trackKey(track) : index;
    },
  });

  const currentIndex = currentTrack
    ? items.findIndex((track) => sameTrack(track, currentTrack))
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
            const track = items[virtualRow.index];
            if (!track) return null;
            const key = trackKey(track);
            const parentId = track.parentId;
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
                    parentId
                      ? () => {
                          onRemoveFolderFromQueue(parentId);
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
