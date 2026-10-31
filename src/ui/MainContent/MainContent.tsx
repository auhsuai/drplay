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
import type { SearchSort } from "../../hooks/useDriveSearch";
import {
  useSkeletonRows,
  HEADER_CHROME_HEIGHT_PX,
} from "./hooks/useSkeletonRows";
import { useHighlightScroll } from "./hooks/useHighlightScroll";
import { useMainContentKeyboard } from "./hooks/useMainContentKeyboard";

import { TopNavigationBar } from "./components/TopNavigationBar";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { FileListHeader } from "./components/FileListHeader";
import { PaginationControls } from "./components/PaginationControls";
import { SkeletonRowList } from "../components/Skeleton";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";

// Search sort string mapping (Phase B2). Two-way adapter between the
// FileListHeader sort-string contract and the search sort model — one source
// of truth is the pin comment in useDriveSearch.ts:11-15:
//   "relevance" ↔ {relevance}; "name" ↔ {name, asc}; "name desc" ↔ {name,
//   desc}; "modifiedTime" ↔ {modifiedTime, asc}; "modifiedTime desc" ↔
//   {modifiedTime, desc}; "size" ↔ {size, asc}; "size desc" ↔ {size, desc}.
// The listing sortOption and the search sort NEVER cross (B2-3): while a
// search is active the header sorts through searchSort only.
type SearchSortString =
  | "relevance"
  | "name"
  | "name desc"
  | "modifiedTime"
  | "modifiedTime desc"
  | "size"
  | "size desc";

function searchSortToString(sort: SearchSort): SearchSortString {
  return sort.field === "relevance"
    ? "relevance"
    : sort.dir === "desc"
      ? `${sort.field} desc`
      : sort.field;
}

function searchSortFromString(option: string): SearchSort {
  if (option === "name") return { field: "name", dir: "asc" };
  if (option === "modifiedTime") return { field: "modifiedTime", dir: "asc" };
  if (option === "size") return { field: "size", dir: "asc" };
  if (option === "name desc") return { field: "name", dir: "desc" };
  if (option === "modifiedTime desc")
    return { field: "modifiedTime", dir: "desc" };
  if (option === "size desc") return { field: "size", dir: "desc" };
  return { field: "relevance", dir: "desc" };
}

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
  const isVirtualRoot = explorer.isVirtualRoot;

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

  // Search sort wiring (Phase B2): while a search is active the header's
  // sortOption/onSortChange route through the SEARCH sort model, never the
  // listing sortOption (B2-3 isolation). FileListHeader's native toggle
  // semantics carry over unchanged (Name→asc, Date/Size→desc, active column
  // flips the " desc" suffix). Default stays relevance (Phase A default),
  // which the header tolerates as an unknown base (all aria-sort "none").
  // The runtime searchSort guard exists for mocked explorers in tests that
  // predate the Phase A members (typed always-present, sometimes absent at
  // runtime — defensive, same spirit as the onSortChange guard).
  const searchSort = explorer.searchSort as SearchSort | undefined;
  const isSearchActive =
    explorer.searchQuery.trim() !== "" && searchSort !== undefined;
  const headerSortOption = isSearchActive
    ? searchSortToString(searchSort)
    : sortOption;
  const headerOnSortChange = isSearchActive
    ? (option: string) => {
        explorer.setSearchSort(searchSortFromString(option));
      }
    : onSortChange;
  const handleToggleSearchMode = useCallback(() => {
    explorer.setSearchMode(
      explorer.searchMode === "global" ? "recursive" : "global",
    );
    // The hook returns a fresh explorer object every render; both read members
    // are plain useState setters/values, same exhaustive-deps tradeoff as the
    // debug-trigger effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explorer.searchMode, explorer.setSearchMode]);

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
        className="sticky top-0 pl-8 pr-4 pt-8 pb-4 shrink-0 z-20 bg-white/95 dark:bg-[#121212]/95 shadow-[0_4px_20px_rgba(0,0,0,0.02)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.1)] transition-opacity duration-200"
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
          searchMode={explorer.searchMode}
          onToggleSearchMode={handleToggleSearchMode}
          sortOption={sortOption}
          onSortChange={onSortChange}
          token={token}
          onNewFolderClick={() => {
            setShowNewFolderModal(true);
          }}
          showNewFolderButton={!isVirtualRoot}
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

        {/* Trash-style sortable column header, living INSIDE the sticky
            chrome so it inherits stickiness with zero offset math (a second
            sticky band would double the sticky offset for rows). Guards,
            each mirroring an existing precedent:
            - isVirtualRoot: root rows are all folders with no date/size
              (precedent: showNewFolderButton).
            - isSelectionMode: selection checkboxes lead every row and would
              misalign the columns, so the header hides (it is the only sort
              control in this view now — the toolbar dropdown was removed).
            - onSortChange: render only when a callback is wired (defensive,
              mirrors the prop's optionality). The list-branch guards (not
              loading skeleton, not empty) come from the render site below.
            Phase B: the old `searchQuery.trim() === ""` guard is GONE —
            during a search the header stays visible and sorts the RESULTS
            through explorer.searchSort (relevance default → all aria-sort
            "none" via the tolerant unknown-base path). The listing
            sortOption is untouched by search sorting (B2-3).
            Changing the sort clears selection and resets the page — the
            existing useDriveExplorer contract. */}
        {!isVirtualRoot &&
          !explorer.isSelectionMode &&
          headerOnSortChange !== undefined && (
            <>
              {/* Toolbar divider. Edges are pinned to the toolbar's own
                  elements, not to the chrome padding: the Back icon starts
                  6px inside its p-1.5 button, so ml-[6px] lands the divider's
                  left edge exactly on the icon; the New Folder button is the
                  toolbar's last child (justify-between) and its right edge is
                  the chrome's pr-4, so mr-0 is exact. Change this if the
                  toolbar's leading/trailing furniture changes. */}
              <div
                aria-hidden="true"
                className="mt-2 ml-[6px] h-px shrink-0 bg-gray-200 dark:bg-[#2A2A2A]"
              />
              <FileListHeader
                sortOption={headerSortOption}
                onSortChange={headerOnSortChange}
              />
            </>
          )}
      </div>

      <div
        data-drop-region
        className="pl-8 pr-4 pb-6 pt-4"
        style={{
          minHeight: `calc(100% - ${String(HEADER_CHROME_HEIGHT_PX)}px)`,
        }}
      >
        {activeTab === TABS.settings ? (
          <div className="text-gray-500">{t("settings.coming_soon")}</div>
        ) : isLoading ? (
          // Deterministic skeleton: SkeletonRowList keeps its natural row
          // height (72px) + 12px gap and useSkeletonRows() already returns
          // enough rows to cover the region. No percentage-derived wrapper
          // and no flex-1 stretching — that relied on the WebView resolving
          // min-height:calc(100% - 140px) inside the auto-height
          // [data-drop-region] container.
          <div role="status" aria-label={t("loading")}>
            <SkeletonRowList rows={skeletonRows} />
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
              hideRowMenus={isVirtualRoot}
              hideRowColumns={isVirtualRoot}
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
