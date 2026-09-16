import React from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer, type ScrollToOptions } from "@tanstack/react-virtual";
import type { Track } from "../../../types";
import type { DriveItem } from "../../../types";
import { SongCard } from "./SongCard";

// Estimated height of one virtualized row: SongCard (~80px) + pb-3 wrapper (12px).
// Must match the real rendered height or the virtualizer miscalculates scroll
// offsets and scrollToIndex jumps to the wrong position.
const ROW_ESTIMATED_SIZE_PX = 92;

// PageUp/PageDown step. No viewport height is available here; 10 rows is a
// screenful, same step QueueList uses.
const PAGE_STEP = 10;

const rowId = (index: number): string => `song-row-${String(index)}`;

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
  onOpenFolder: (id: string, name: string, parentId?: string) => void;
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
  const { t } = useTranslation();
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

  // ARIA composite widget (APG layout grid): the container owns the keyboard
  // and keeps `aria-activedescendant` on the active row. Rows outside the
  // render window have no DOM node, so arrow navigation goes through the
  // virtualizer (scrollToIndex) instead of real focus — this is what makes
  // every row keyboard-reachable without dropping virtualization.
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [containerFocused, setContainerFocused] = React.useState(false);

  // The ring is the keyboard-navigation indicator only (App.css removes the
  // native outline). A click on the non-focusable padding gap between rows
  // focuses this container as the nearest focusable ancestor — no keyboard
  // involved. The flag covers exactly the focus event the browser fires
  // synchronously during the mousedown task; the timeout drops it before any
  // later focus, so a subsequent keyboard focus still rings (no stale flag).
  const pointerFocusRef = React.useRef(false);
  const markPointerFocus = () => {
    pointerFocusRef.current = true;
    window.setTimeout(() => {
      pointerFocusRef.current = false;
    }, 0);
  };

  const playingIndex = isPlaying
    ? items.findIndex((item) => item.trackInfo?.id === isPlaying)
    : -1;

  // Items change (search filter, navigation, data churn) while an index is
  // active — an out-of-range index simply has no active row.
  const effectiveActiveIndex =
    activeIndex >= 0 && activeIndex < items.length ? activeIndex : -1;

  // Visible active-row marker while the grid owns the keyboard focus.
  const rowClassName = (index: number): string =>
    containerFocused && effectiveActiveIndex === index
      ? "pb-3 rounded-xl ring-2 ring-inset ring-brand-primary/50"
      : "pb-3";

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

  // Keyboard activation mirrors SongCard's click exactly: selection mode
  // toggles, folder opens (parentId rides along for search folder hits),
  // track plays through the same onPlay handler the click path uses.
  const activate = (index: number) => {
    const item = items[index];
    if (!item) return;
    if (isSelectionMode) {
      handleToggleSelection(item.id);
      return;
    }
    if (item.isFolder) {
      if (item.parentId !== undefined) {
        onOpenFolder(item.id, item.title, item.parentId);
      } else {
        onOpenFolder(item.id, item.title);
      }
      return;
    }
    const track = item.trackInfo;
    if (!track) return;
    onPlay(track);
  };

  const moveTo = (index: number) => {
    setActiveIndex(index);
    rowVirtualizer.scrollToIndex(index, { align: "auto" });
  };

  const moveActive = (next: number) => {
    if (items.length === 0) return;
    moveTo(Math.max(0, Math.min(items.length - 1, next)));
  };

  // ArrowUp/ArrowDown wrap around the ends (keyboard model for this list).
  const moveActiveWrapped = (delta: 1 | -1) => {
    if (items.length === 0) return;
    moveTo(
      effectiveActiveIndex < 0
        ? delta > 0
          ? 0
          : items.length - 1
        : (effectiveActiveIndex + delta + items.length) % items.length,
    );
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Inner controls (MoreMenu trigger, selection checkbox) own their keys.
    if (target !== e.currentTarget && target.closest("button, input")) return;

    if (e.key === "Enter" || e.key === " ") {
      // A focused card activates itself (bubbled keys must not double-fire).
      if (target !== e.currentTarget || effectiveActiveIndex < 0) return;
      e.preventDefault();
      activate(effectiveActiveIndex);
      return;
    }

    const base =
      effectiveActiveIndex >= 0 ? effectiveActiveIndex : playingIndex;
    switch (e.key) {
      case "ArrowDown":
        moveActiveWrapped(1);
        break;
      case "ArrowUp":
        moveActiveWrapped(-1);
        break;
      case "PageDown":
        moveActive(base + PAGE_STEP);
        break;
      case "PageUp":
        moveActive(base - PAGE_STEP);
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
    // Keys pressed on a card hand focus back to the grid owner: the
    // activedescendant model only announces while the grid has focus.
    e.currentTarget.focus();
  };

  return (
    <div
      ref={rowVirtualizer.containerRef}
      role="grid"
      aria-label={t("drive.song_list")}
      aria-rowcount={items.length}
      aria-colcount={1}
      aria-multiselectable={isSelectionMode || undefined}
      tabIndex={0}
      aria-activedescendant={
        effectiveActiveIndex >= 0 ? rowId(effectiveActiveIndex) : undefined
      }
      onKeyDown={onListKeyDown}
      onPointerDownCapture={markPointerFocus}
      onFocus={(e) => {
        if (e.target !== e.currentTarget) return;
        if (!pointerFocusRef.current) setContainerFocused(true);
        // First focus lands on the playing row (or the top); focus returning
        // mid-navigation keeps the existing active row.
        setActiveIndex((prev) =>
          prev >= 0 && prev < items.length
            ? prev
            : playingIndex >= 0
              ? playingIndex
              : items.length > 0
                ? 0
                : -1,
        );
      }}
      onBlur={(e) => {
        if (e.target === e.currentTarget) setContainerFocused(false);
      }}
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
            id={rowId(virtualRow.index)}
            role="row"
            aria-rowindex={virtualRow.index + 1}
            aria-selected={
              isSelectionMode
                ? selectedIds.has(item.id)
                : !!isPlaying && item.trackInfo?.id === isPlaying
            }
            onFocus={() => {
              setActiveIndex(virtualRow.index);
            }}
            className={rowClassName(virtualRow.index)}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
            }}
          >
            <div role="gridcell">
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
          </div>
        );
      })}
    </div>
  );
});
