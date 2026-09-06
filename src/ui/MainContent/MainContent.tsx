import React, { useRef, useEffect, useCallback } from "react";
import type { Track } from "../../types";
import { useTranslation } from "react-i18next";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";

import { clearPrefetchedStreams } from "../../utils/streamPrefetcher";
import { TABS, type TabKey } from "../../utils/driveConstants";

import {
  VirtualizedSongList,
  type VirtualizedSongListHandle,
} from "./components/VirtualizedSongList";
import { BulkDeleteConfirmModal } from "./components/BulkDeleteConfirmModal";
import { NewFolderModal } from "./components/NewFolderModal";

import { useDriveExplorer, ITEMS_PER_PAGE } from "../../hooks/useDriveExplorer";
import { useEventListener } from "../../hooks/useEventListener";

import { TopNavigationBar } from "./components/TopNavigationBar";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { PaginationControls } from "./components/PaginationControls";
import { SkeletonRowList } from "../components/Skeleton";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";

// Fallback delay for the cross-page highlight scroll: normally the page
// commit itself re-runs the highlight effect, whose cleanup cancels this
// timer before it fires; the timeout only performs the scroll when the new
// page renders slower than the delay (slow devices/commits).
const SCROLL_HIGHLIGHT_DELAY_MS = 50;

// Estimated height of the sticky header chrome (TopNavigationBar + SelectionToolbar)
// â€” the file-list container sizes itself to fill the viewport below it
// (applied as min-height: calc(100% - 140px) on the [data-drop-region] div).
const HEADER_CHROME_HEIGHT_PX = 140;

// Skeleton row â‰ˆ 72px tall: 48px icon + p-3 (12px) padding top/bottom.
const SKELETON_ROW_HEIGHT_PX = 72;
// Minimum skeleton rows so short viewports never collapse the loading UI.
const SKELETON_MIN_ROWS = 4;

// Skeleton rows must fill the whole list area on every screen size â€” a
// fixed count leaves a blank band on tall/wide displays. Estimate the
// count from the viewport and recompute on resize, like Spotify/YouTube
// skeletons do.
const calcSkeletonRows = () =>
  Math.max(
    SKELETON_MIN_ROWS,
    Math.ceil(
      (window.innerHeight - HEADER_CHROME_HEIGHT_PX) / SKELETON_ROW_HEIGHT_PX,
    ),
  );

interface MainContentProps {
  activeTab: TabKey;
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  isLoading: boolean;
  onOpenFolder: (id: string, name: string) => void;
  onBack: () => void;
  hasHistory: boolean;
  folderHistory: { id: string; name: string }[];
  currentFolderName: string;
  onBreadcrumbClick: (id: string, name: string, index: number) => void;
  token: string | null;
  currentFolderId: string;
  highlightedFileId?: { id: string; ts: number; folderId: string } | null;
  onRefresh: () => void;
  onRemoveItem?: (id: string) => void;
  currentTrack?: Track | null;
  sortOption?: string;
  onSortChange?: (option: string) => void;
}

export const MainContent = React.memo(function MainContent({
  activeTab,
  onPlay,
  isLoading,
  onOpenFolder,
  onBack,
  hasHistory,
  folderHistory,
  currentFolderName,
  currentFolderId,
  onBreadcrumbClick,
  token,
  highlightedFileId,
  onRefresh,
  onRemoveItem,
  currentTrack,
  sortOption = "name_natural",
  onSortChange,
}: MainContentProps) {
  const { t } = useTranslation();
  const isInitialMount = useRef(true);
  const mainRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [showNewFolderModal, setShowNewFolderModal] = React.useState(false);
  const [showBulkMoveScreen, setShowBulkMoveScreen] = React.useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] =
    React.useState(false);
  // DEV-only override (Ctrl+Shift+D panel â†’ "Pagination"): totalPages is
  // DERIVED from real data (Math.ceil(filteredItems.length / ITEMS_PER_PAGE)),
  // so it cannot be set directly â€” a local override forces the controls to
  // render while the real setCurrentPage stays wired underneath.
  const [debugTotalPages, setDebugTotalPages] = React.useState<number | null>(
    null,
  );

  // Recompute the skeleton row count on resize so the loading state keeps
  // filling the list area after a window size change.
  const [skeletonRows, setSkeletonRows] = React.useState(calcSkeletonRows);
  React.useEffect(() => {
    const onResize = () => {
      setSkeletonRows(calcSkeletonRows());
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const explorer = useDriveExplorer(
    currentFolderId,
    currentFolderName,
    token,
    onRefresh,
    onRemoveItem,
    sortOption,
  );

  useEffect(() => {
    isInitialMount.current = false;
  }, []);

  // Keyboard shortcuts
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      if (document.activeElement === searchInputRef.current) {
        searchInputRef.current?.blur();
        explorer.setSearchQuery("");
      } else {
        searchInputRef.current?.focus();
      }
    }
    if (
      e.key === "Escape" &&
      document.activeElement === searchInputRef.current
    ) {
      searchInputRef.current?.blur();
      explorer.setSearchQuery("");
    }
  };
  useEventListener("keydown", handleKeyDown, [explorer.setSearchQuery]);

  // Enable selection mode from events
  const handleEnableSelection = (e: Event) => {
    // detail is typed | null because a CustomEvent constructed without the
    // detail option defaults to null at runtime.
    const customEvent = e as CustomEvent<{ id?: string } | null>;
    if (customEvent.detail?.id) {
      explorer.setIsSelectionMode(true);
      explorer.setSelectedIds(new Set([customEvent.detail.id]));
    }
  };
  useEventListener("enable-selection-mode", handleEnableSelection, [
    explorer.setIsSelectionMode,
    explorer.setSelectedIds,
  ]);

  // Scroll to top on folder change — unless a LIVE locate highlight belongs
  // to the destination folder itself (the highlight effect will land on the
  // row anyway). The highlight carries the folderId it was produced for, so a
  // highlight from another folder no longer suppresses this scroll when the
  // user navigates manually within the 5s window (audit B3: the old check was
  // folder-blind and skipped scroll-to-top unfairly).
  const prevFolderRef = useRef(currentFolderId);
  useEffect(() => {
    if (mainRef.current) {
      const isFolderChange = currentFolderId !== prevFolderRef.current;
      const isLiveHighlightForDestination =
        highlightedFileId != null &&
        highlightedFileId.folderId === currentFolderId;
      if (isFolderChange && !isLiveHighlightForDestination) {
        mainRef.current.scrollTo({ top: 0, behavior: "smooth" });
      }
      prevFolderRef.current = currentFolderId;
    }
  }, [currentFolderId, highlightedFileId]);

  // Virtualizer is now isolated inside VirtualizedSongList
  const virtualizedListRef = useRef<VirtualizedSongListHandle>(null);

  // Consume-once latch for highlight scrolling: the ts of the last locate we
  // actually scrolled to. Data churn (search refreshes, Dexie writes)
  // keeps re-creating filteredItems while the SAME highlight is active — the
  // effect re-runs on every new identity but must not re-yank the viewport:
  // one locate = one scroll.
  const lastScrolledTsRef = useRef<number | null>(null);

  // Handle highlight scrolling — consume-once per locate (keyed by ts). The
  // latch is written ONLY where a scrollToIndex actually executes, never at
  // effect entry. The cross-page path relies on this: Run 1 only switches
  // pages and schedules the fallback timer; committing the new page re-runs
  // this effect and its cleanup cancels that timer — an entry-latch would
  // make Run 2 skip and lose the scroll entirely.
  useEffect(() => {
    if (!highlightedFileId || explorer.filteredItems.length === 0) return;
    if (lastScrolledTsRef.current === highlightedFileId.ts) return;
    const index = explorer.filteredItems.findIndex(
      (item) => item.id === highlightedFileId.id,
    );
    if (index === -1) return;
    const scrollToHighlightedRow = () => {
      virtualizedListRef.current?.scrollToIndex(index % ITEMS_PER_PAGE, {
        align: "center",
      });
      lastScrolledTsRef.current = highlightedFileId.ts;
    };
    const targetPage = Math.floor(index / ITEMS_PER_PAGE) + 1;
    if (targetPage !== explorer.currentPage) {
      explorer.setCurrentPage(targetPage);
      const timerId = setTimeout(
        scrollToHighlightedRow,
        SCROLL_HIGHLIGHT_DELAY_MS,
      );
      return () => {
        clearTimeout(timerId);
      };
    }
    scrollToHighlightedRow();
    // The effect only reads the enumerated explorer members (adding the whole
    // explorer object would re-run the highlight-scroll on every render since
    // useDriveExplorer returns a fresh object each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    highlightedFileId,
    explorer.currentPage,
    explorer.filteredItems,
    explorer.setCurrentPage,
  ]);

  useEffect(() => {
    clearPrefetchedStreams();
  }, [currentFolderId]);

  const handlePlay = useCallback(
    (t: Track) => {
      const queue = explorer.filteredItems
        .filter((f) => !f.isFolder && f.trackInfo)
        .map((f) => f.trackInfo as Track);
      onPlay(t, queue);
    },
    [explorer.filteredItems, onPlay],
  );

  const handleBulkMoveClick = useCallback(() => {
    setShowBulkMoveScreen(true);
  }, []);
  const handleBulkDeleteClick = useCallback(() => {
    setShowBulkDeleteConfirm(true);
  }, []);

  // DEV-only debug triggers (Ctrl+Shift+D panel â†’ "Loading / MainContent"):
  // bulk-delete modal and selection toolbar drive the SAME local/explorer
  // state the real flows use, so every subsequent interaction (close modal,
  // exit selection, bulk action) keeps working unchanged. onDebugEvent no-ops
  // in production builds; the listeners never run there.
  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.BULK_DELETE, () => {
      setShowBulkDeleteConfirm(true);
    });
  }, []);

  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.SELECTION_MODE, () => {
      explorer.setIsSelectionMode(true);
    });
    // The hook returns a fresh explorer object every render; the setter itself
    // is the stable useState setter, so only the member dep is meaningful.
    // Same shape as the highlight-scroll effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorer.setIsSelectionMode]);

  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.PAGINATION, () => {
      setDebugTotalPages(2);
    });
  }, []);

  return (
    <main
      ref={mainRef}
      className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto overscroll-none relative transition-colors duration-300"
    >
      {showBulkMoveScreen && token && (
        <FolderSelectionScreen
          token={token}
          onCancel={() => {
            setShowBulkMoveScreen(false);
          }}
          onSelectFolder={(destId) => {
            void explorer.handleBulkMove(destId, () => {
              setShowBulkMoveScreen(false);
            });
          }}
          title={t(
            "folder_selection.bulk_move_title",
            "Choose destination folder",
          )}
        />
      )}

      <div
        data-testid="main-header-chrome"
        className="sticky top-0 px-8 pt-8 pb-4 shrink-0 z-20 bg-white/95 dark:bg-[#121212]/95 shadow-[0_4px_20px_rgba(0,0,0,0.02)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.1)] transition-opacity duration-200"
      >
        <TopNavigationBar
          isSelectionMode={explorer.isSelectionMode}
          selectedCount={explorer.selectedIds.size}
          onClearSelection={() => {
            explorer.setIsSelectionMode(false);
            explorer.setSelectedIds(new Set());
          }}
          onBack={onBack}
          hasHistory={hasHistory}
          folderHistory={folderHistory}
          currentFolderName={currentFolderName}
          onBreadcrumbClick={onBreadcrumbClick}
          searchQuery={explorer.searchQuery}
          onSearchChange={explorer.setSearchQuery}
          sortOption={sortOption}
          onSortChange={onSortChange}
          token={token}
          onNewFolderClick={() => {
            setShowNewFolderModal(true);
          }}
          isInitialMount={isInitialMount}
          searchInputRef={searchInputRef}
        />

        <SelectionToolbar
          isSelectionMode={explorer.isSelectionMode}
          selectedCount={explorer.selectedIds.size}
          totalCount={explorer.filteredItems.length}
          isBulkOperating={explorer.isBulkOperating}
          onToggleSelectAll={() => {
            explorer.setSelectedIds((prev) => {
              if (prev.size === explorer.filteredItems.length) return new Set();
              return new Set(explorer.filteredItems.map((i) => i.id));
            });
          }}
          onBulkMoveClick={handleBulkMoveClick}
          onBulkDeleteClick={handleBulkDeleteClick}
        />
      </div>

      <div
        data-drop-region
        className="px-8 pb-6 pt-4"
        style={{
          minHeight: `calc(100% - ${String(HEADER_CHROME_HEIGHT_PX)}px)`,
        }}
      >
        {activeTab === TABS.settings ? (
          <div className="text-gray-500">{t("settings.coming_soon")}</div>
        ) : isLoading ? (
          // [data-drop-region] sizes itself with min-height only, so a
          // percentage h-full inside it would not resolve. Give the skeleton
          // wrapper the same min-height formula instead, then let
          // SkeletonRowList (h-full + flex-1) and its rows (flex-1) share the
          // space so the skeleton covers the whole loading region.
          <div
            role="status"
            aria-label={t("loading")}
            className="flex flex-col"
            style={{
              minHeight: `calc(100% - ${String(HEADER_CHROME_HEIGHT_PX)}px)`,
            }}
          >
            <SkeletonRowList rows={skeletonRows} stretch className="flex-1" />
          </div>
        ) : explorer.filteredItems.length === 0 ? (
          <div className="text-gray-500 py-10 text-center">
            {explorer.searchQuery
              ? t("drive.no_search_results")
              : t("drive.no_audio")}
          </div>
        ) : (
          <>
            <VirtualizedSongList
              ref={virtualizedListRef}
              scrollElementRef={mainRef}
              items={explorer.currentItems}
              onPlay={handlePlay}
              onOpenFolder={onOpenFolder}
              token={token}
              currentFolderId={currentFolderId}
              currentFolderName={currentFolderName}
              folderHistory={folderHistory}
              highlightedFileId={highlightedFileId}
              isPlaying={currentTrack?.id}
              onRefresh={onRefresh}
              onRemoveItem={onRemoveItem}
              isSelectionMode={explorer.isSelectionMode}
              selectedIds={explorer.selectedIds}
              setSelectedIds={explorer.setSelectedIds}
              setIsSelectionMode={explorer.setIsSelectionMode}
              onBulkMoveClick={handleBulkMoveClick}
              onBulkDeleteClick={handleBulkDeleteClick}
            />

            <div
              data-testid="main-pagination-chrome"
              className="sticky bottom-0 py-1 transition-opacity duration-200"
            >
              <PaginationControls
                currentPage={explorer.currentPage}
                totalPages={debugTotalPages ?? explorer.totalPages}
                setCurrentPage={explorer.setCurrentPage}
                onScrollTop={() =>
                  virtualizedListRef.current?.scrollToIndex(0, {
                    align: "start",
                  })
                }
              />
            </div>
          </>
        )}
      </div>

      <BulkDeleteConfirmModal
        isOpen={showBulkDeleteConfirm}
        onClose={() => {
          setShowBulkDeleteConfirm(false);
        }}
        onConfirm={() => {
          void explorer.handleBulkDelete(() => {
            setShowBulkDeleteConfirm(false);
          });
        }}
        isOperating={explorer.isBulkOperating}
        selectedCount={explorer.selectedIds.size}
      />

      <NewFolderModal
        isOpen={showNewFolderModal}
        onClose={() => {
          setShowNewFolderModal(false);
        }}
        onCreate={(name) => {
          void explorer.handleCreateFolder(name, () => {
            setShowNewFolderModal(false);
          });
        }}
        isCreating={explorer.isCreatingFolder}
      />
    </main>
  );
});
