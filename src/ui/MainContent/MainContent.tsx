import React, { useRef, useEffect, useCallback } from "react";
import type { Track } from "../../types";
import { useTranslation } from "react-i18next";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";

import { clearNextTrackPrefetches } from "../../utils/nextTrackPrefetcher";
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
import { isUploading, clearUploadedTint } from "../../utils/uploadManager";
import { useHardwareBack } from "../../hooks/useHardwareBack";

import { TopNavigationBar } from "./components/TopNavigationBar";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { PaginationControls } from "./components/PaginationControls";
import { DRAG_ACTIVE_EVENT } from "../components/DropZone";
import { SkeletonRowList } from "../components/Skeleton";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";

// How long to wait after switching to the target page before scrolling the
// highlighted item into view — the new page must render first; 50ms is just
// enough for React to flush and the virtualizer to lay out the new rows.
const SCROLL_HIGHLIGHT_DELAY_MS = 50;

// Estimated height of the sticky header chrome (TopNavigationBar + SelectionToolbar)
// — the file-list container sizes itself to fill the viewport below it
// (applied as min-height: calc(100% - 140px) on the [data-drop-region] div).
const HEADER_CHROME_HEIGHT_PX = 140;

// Skeleton row ≈ 72px tall: 48px icon + p-3 (12px) padding top/bottom.
const SKELETON_ROW_HEIGHT_PX = 72;
// Minimum skeleton rows so short viewports never collapse the loading UI.
const SKELETON_MIN_ROWS = 4;

// Skeleton rows must fill the whole list area on every screen size — a
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
  highlightedFileId?: { id: string; ts: number } | null;
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
  // DEV-only override (Ctrl+Shift+D panel → "Pagination"): totalPages is
  // DERIVED from real data (Math.ceil(filteredItems.length / ITEMS_PER_PAGE)),
  // so it cannot be set directly — a local override forces the controls to
  // render while the real setCurrentPage stays wired underneath.
  const [debugTotalPages, setDebugTotalPages] = React.useState<number | null>(
    null,
  );
  // While a native drag is in flight (DropZone announces it), the header
  // chrome and pagination hide so the drop target area is unambiguous; the
  // file-list container also doubles as the scoped dim region ([data-drop-region]).
  const [isDragActive, setIsDragActive] = React.useState(false);

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

  const handleDragActive = (e: Event) => {
    // detail is typed | null because a CustomEvent constructed without the
    // detail option defaults to null at runtime.
    const detail = (e as CustomEvent<{ active: boolean } | null>).detail;
    setIsDragActive(detail?.active ?? false);
  };
  useEventListener(DRAG_ACTIVE_EVENT, handleDragActive);

  useEffect(() => {
    isInitialMount.current = false;
  }, []);

  // Leaving the My Drive tab unmounts MainContent — clear every transient
  // "uploaded" check so a fresh visit shows no stale completion tint.
  useEffect(() => {
    return () => {
      clearUploadedTint();
    };
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

  // Scroll to top on folder change
  const prevFolderRef = useRef(currentFolderId);
  useEffect(() => {
    if (mainRef.current) {
      const isFolderChange = currentFolderId !== prevFolderRef.current;
      if (isFolderChange && !highlightedFileId) {
        mainRef.current.scrollTo({ top: 0, behavior: "smooth" });
      }
      prevFolderRef.current = currentFolderId;
    }
  }, [currentFolderId, highlightedFileId]);

  // Virtualizer is now isolated inside VirtualizedSongList
  const virtualizedListRef = useRef<VirtualizedSongListHandle>(null);

  // Handle highlight scrolling
  useEffect(() => {
    if (highlightedFileId && explorer.filteredItems.length > 0) {
      const index = explorer.filteredItems.findIndex(
        (item) => item.id === highlightedFileId.id,
      );
      if (index !== -1) {
        const targetPage = Math.floor(index / ITEMS_PER_PAGE) + 1;
        if (targetPage !== explorer.currentPage) {
          explorer.setCurrentPage(targetPage);
          const timerId = setTimeout(() => {
            const pageIndex = index % ITEMS_PER_PAGE;
            virtualizedListRef.current?.scrollToIndex(pageIndex, {
              align: "center",
            });
          }, SCROLL_HIGHLIGHT_DELAY_MS);
          return () => {
            clearTimeout(timerId);
          };
        } else {
          const pageIndex = index % ITEMS_PER_PAGE;
          virtualizedListRef.current?.scrollToIndex(pageIndex, {
            align: "center",
          });
        }
      }
    }
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
    clearNextTrackPrefetches();
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

  // DEV-only debug triggers (Ctrl+Shift+D panel → "Loading / MainContent"):
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

  // Hardware back (mobile): closes the NewFolderModal when it owns the
  // foreground — without this, the back press falls through the App-level
  // chain to the folder-up handler and pops folder history instead.
  useHardwareBack(() => {
    setShowNewFolderModal(false);
    return true;
  }, showNewFolderModal);

  // Hardware back (mobile): closes the two bulk overlays (BulkDeleteConfirmModal
  // and bulk-move FolderSelectionScreen) when they own the foreground — without
  // this, a back press falls through the App-level chain to the folder-up
  // handler and pops folder history instead. BulkDeleteConfirmModal renders
  // after FolderSelectionScreen in JSX, so it closes first (MoreMenu pattern:
  // the later-rendered dialog is handled first). Handler closure includes every
  // boolean gate in deps so the latest version is always on the LIFO stack (an
  // inline `if (showBulkDeleteConfirm)` read against a stale closure would
  // re-peel the same overlay twice — MoreMenu pattern). Registered ONLY while
  // at least one bulk overlay is open, so an empty stack on close keeps the
  // chain falling through to App.
  const handleBulkOverlayBack = useCallback((): boolean => {
    if (showBulkDeleteConfirm) {
      setShowBulkDeleteConfirm(false);
      return true;
    }
    if (showBulkMoveScreen) {
      setShowBulkMoveScreen(false);
      return true;
    }
    return false;
  }, [
    setShowBulkDeleteConfirm,
    setShowBulkMoveScreen,
    showBulkDeleteConfirm,
    showBulkMoveScreen,
  ]);

  const isAnyBulkOverlayOpen = showBulkDeleteConfirm || showBulkMoveScreen;
  useHardwareBack(handleBulkOverlayBack, isAnyBulkOverlayOpen);

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
        className={`sticky top-0 px-8 pt-8 pb-4 shrink-0 z-20 bg-white/95 dark:bg-[#121212]/95 shadow-[0_4px_20px_rgba(0,0,0,0.02)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.1)] transition-opacity duration-200 ${isDragActive ? "opacity-0 pointer-events-none" : "opacity-100"}`}
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
              // Uploading items must never join the selection (their pending
              // rows cannot be bulk-deleted/moved); Select All picks only the
              // items that are safe to operate on.
              return new Set(
                explorer.filteredItems
                  .filter((i) => !isUploading(i.id))
                  .map((i) => i.id),
              );
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
              className={`sticky bottom-0 py-1 transition-opacity duration-200 ${isDragActive ? "opacity-0 pointer-events-none" : "opacity-100"}`}
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
