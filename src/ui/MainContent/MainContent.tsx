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

import { useDriveExplorer } from "../../hooks/useDriveExplorer";
import {
  useSkeletonRows,
  HEADER_CHROME_HEIGHT_PX,
} from "./hooks/useSkeletonRows";
import { useHighlightScroll } from "./hooks/useHighlightScroll";
import { useMainContentKeyboard } from "./hooks/useMainContentKeyboard";

import { TopNavigationBar } from "./components/TopNavigationBar";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { PaginationControls } from "./components/PaginationControls";
import { SkeletonRowList } from "../components/Skeleton";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";

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
  // True while the fullscreen NowPlaying overlay is open (plumbed from App):
  // Backspace must not navigate behind it. Optional so existing call sites
  // and tests keep compiling; absent means "overlay closed".
  isNowPlayingOpen?: boolean;
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
  isNowPlayingOpen = false,
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

  const skeletonRows = useSkeletonRows();

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

  useMainContentKeyboard({
    searchInputRef,
    setSearchQuery: explorer.setSearchQuery,
    isSelectionMode: explorer.isSelectionMode,
    setSelectedIds: explorer.setSelectedIds,
    setIsSelectionMode: explorer.setIsSelectionMode,
    showNewFolderModal,
    showBulkMoveScreen,
    showBulkDeleteConfirm,
    isNowPlayingOpen,
    hasHistory,
    onBack,
  });

  // Virtualizer is now isolated inside VirtualizedSongList
  const virtualizedListRef = useRef<VirtualizedSongListHandle>(null);

  useHighlightScroll({
    mainRef,
    virtualizedListRef,
    currentFolderId,
    highlightedFileId,
    filteredItems: explorer.filteredItems,
    currentPage: explorer.currentPage,
    setCurrentPage: explorer.setCurrentPage,
  });

  useEffect(() => {
    clearPrefetchedStreams();
  }, [currentFolderId]);

  // Latest-ref pattern: card rows are memoized and SongCard's comparator
  // deliberately ignores callback props (SongCard.tsx:258-273), so a mounted
  // card keeps the callback from its last render. Keeping handlePlay identity
  // stable (deps []) and reading the listing through a ref updated on every
  // commit means the queue is built from the CURRENT filteredItems at click
  // time instead of a stale closure snapshot (Dexie writes / delta sync
  // re-emit filteredItems as a new array without changing the mounted cards).
  const playContextRef = useRef({
    filteredItems: explorer.filteredItems,
    onPlay,
  });
  useEffect(() => {
    playContextRef.current = { filteredItems: explorer.filteredItems, onPlay };
  });
  const handlePlay = useCallback((t: Track) => {
    const { filteredItems, onPlay: play } = playContextRef.current;
    play(
      t,
      filteredItems
        .filter((f) => !f.isFolder && f.trackInfo)
        .map((f) => f.trackInfo as Track),
    );
  }, []);

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
        data-view-header
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
