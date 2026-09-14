import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Track } from "../../types";
import { sameTrack } from "../../hooks/player/utils";
import { QueueFolderRow } from "./QueueFolderRow";
import { QueueRow, QUEUE_ROW_HEIGHT } from "./QueueRow";
import type { QueueViewItem } from "./queueView";

const QUEUE_OVERSCAN = 10;
// PageUp/PageDown step. No viewport height is available here; 10 rows is a
// screenful at the 84px row height.
const QUEUE_PAGE_STEP = 10;

const optionId = (index: number): string => `queue-option-${String(index)}`;

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
 * Scrollable virtualized queue grid (APG layout grid). Owns the virtualizer so
 * the scroll container and its measurements stay local; QueuePanel only feeds
 * it the already-filtered view items (folder rows collapsed) and callbacks.
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
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  // ARIA composite widget (APG layout grid): the container is the single
  // keyboard owner and keeps `aria-activedescendant` on the active row —
  // rows outside the render window have no DOM node to focus, so arrow
  // navigation must go through the virtualizer instead of real focus.
  const [activeIndex, setActiveIndex] = useState(-1);
  const [containerFocused, setContainerFocused] = useState(false);

  // eslint-disable-next-line react-hooks/incompatible-library -- useVirtualizer is interior-mutable; React Compiler intentionally skips memoizing this component, so no stale cache can occur (TanStack/virtual#736).
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

  // Keep the playing row in view on mount and when the playing track changes.
  useEffect(() => {
    if (currentIndex < 0) return;
    virtualizer.scrollToIndex(currentIndex, { align: "center" });
  }, [currentIndex, virtualizer]);

  // Items change (search filter, folder drill-down, queue edits) while an
  // index is active — an out-of-range index simply has no active row.
  const effectiveActiveIndex =
    activeIndex >= 0 && activeIndex < items.length ? activeIndex : -1;

  // Visible active-row marker while the grid owns the keyboard focus.
  const optionClassName = (index: number): string | undefined =>
    containerFocused && effectiveActiveIndex === index
      ? "rounded-xl ring-2 ring-inset ring-brand-primary/50"
      : undefined;

  const moveActive = (next: number) => {
    if (items.length === 0) return;
    const clamped = Math.max(0, Math.min(items.length - 1, next));
    setActiveIndex(clamped);
    virtualizer.scrollToIndex(clamped, { align: "auto" });
  };

  const activate = (index: number) => {
    const item = items[index];
    if (!item) return;
    if (item.kind === "folder") {
      onOpenFolder(item.folderId);
      return;
    }
    // The playing row is not a control (QueueRow contract): keyboard
    // activation is a no-op there, same as a click.
    if (currentTrack !== null && sameTrack(item.track, currentTrack)) return;
    if (selectionMode) onToggleSelected(item.key);
    else onSelectTrack(item.track);
  };

  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Inner controls (row menu trigger, selection checkbox) own their keys.
    if (target !== e.currentTarget && target.closest("button, input")) return;

    if (e.key === "Enter" || e.key === " ") {
      // A focused row activates itself (bubbled keys must not double-fire).
      if (target !== e.currentTarget || effectiveActiveIndex < 0) return;
      e.preventDefault();
      activate(effectiveActiveIndex);
      return;
    }

    const base =
      effectiveActiveIndex >= 0 ? effectiveActiveIndex : currentIndex;
    switch (e.key) {
      case "ArrowDown":
        moveActive(base + 1);
        break;
      case "ArrowUp":
        moveActive(base - 1);
        break;
      case "PageDown":
        moveActive(base + QUEUE_PAGE_STEP);
        break;
      case "PageUp":
        moveActive(base - QUEUE_PAGE_STEP);
        break;
      case "Home":
        moveActive(0);
        break;
      case "End":
        moveActive(items.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
    // Keys pressed on a row hand focus back to the list owner: the
    // activedescendant model only announces while the grid has focus.
    e.currentTarget.focus();
  };

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label={t("queue.title")}
      aria-rowcount={items.length}
      aria-colcount={1}
      aria-multiselectable={selectionMode || undefined}
      tabIndex={0}
      aria-activedescendant={
        effectiveActiveIndex >= 0 ? optionId(effectiveActiveIndex) : undefined
      }
      onKeyDown={onListKeyDown}
      onFocus={(e) => {
        if (e.target !== e.currentTarget) return;
        setContainerFocused(true);
        // First focus lands on the playing row (or the top); focus returning
        // mid-navigation keeps the existing active option.
        setActiveIndex((prev) =>
          prev >= 0 && prev < items.length
            ? prev
            : currentIndex >= 0
              ? currentIndex
              : items.length > 0
                ? 0
                : -1,
        );
      }}
      onBlur={(e) => {
        if (e.target === e.currentTarget) setContainerFocused(false);
      }}
      className="flex-1 min-h-0 overflow-y-auto"
    >
      {items.length === 0 ? (
        <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          {emptyText}
        </div>
      ) : (
        <div
          role="rowgroup"
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
                  id={optionId(virtualRow.index)}
                  role="row"
                  aria-rowindex={virtualRow.index + 1}
                  aria-selected={false}
                  onFocus={() => {
                    setActiveIndex(virtualRow.index);
                  }}
                  className={optionClassName(virtualRow.index)}
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
            const isCurrent =
              currentTrack !== null && sameTrack(track, currentTrack);
            // Root-folder removal: prefer the "add folder to queue" group id
            // (indexed in slice 1), fall back to the legacy direct parent.
            const folderId = track.folderGroupId ?? track.parentId;
            return (
              <div
                key={virtualRow.key}
                id={optionId(virtualRow.index)}
                role="row"
                aria-rowindex={virtualRow.index + 1}
                aria-selected={selectionMode ? selected.has(key) : isCurrent}
                onFocus={() => {
                  setActiveIndex(virtualRow.index);
                }}
                className={optionClassName(virtualRow.index)}
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
                  isCurrent={isCurrent}
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
