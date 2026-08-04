import React, { useRef, useEffect, useCallback } from "react";
import { Track } from "../../App";
import { useTranslation } from "react-i18next";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";

import { clearNextTrackPrefetches } from "../../utils/nextTrackPrefetcher";
import { clearPrefetchedStreams } from "../../utils/streamPrefetcher";
import { TABS, type TabKey } from "../../utils/driveConstants";

import { VirtualizedSongList, type VirtualizedSongListHandle } from './components/VirtualizedSongList';
import { BulkDeleteConfirmModal } from './components/BulkDeleteConfirmModal';
import { NewFolderModal } from './components/NewFolderModal';

import { useDriveExplorer, ITEMS_PER_PAGE } from "../../hooks/useDriveExplorer";
import { useEventListener } from "../../hooks/useEventListener";
import { isUploading } from "../../utils/uploadManager";

import { TopNavigationBar } from "./components/TopNavigationBar";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { PaginationControls } from "./components/PaginationControls";
import { DRAG_ACTIVE_EVENT } from "../components/DropZone";
import { SkeletonRowList } from "../components/Skeleton";

// How long to wait after switching to the target page before scrolling the
// highlighted item into view — the new page must render first; 50ms is just
// enough for React to flush and the virtualizer to lay out the new rows.
const SCROLL_HIGHLIGHT_DELAY_MS = 50;

// Estimated height of the sticky header chrome (TopNavigationBar + SelectionToolbar)
// — the file-list container sizes itself to fill the viewport below it
// (applied as min-height: calc(100% - 140px) on the [data-drop-region] div).
const HEADER_CHROME_HEIGHT_PX = 140;

interface MainContentProps {
  activeTab: TabKey;
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  isLoading: boolean;
  onOpenFolder: (id: string, name: string) => void;
  onBack: () => void;
  hasHistory: boolean;
  folderHistory: { id: string, name: string }[];
  currentFolderName: string;
  onBreadcrumbClick: (id: string, name: string, index: number) => void;
  token: string | null;
  currentFolderId: string;
  highlightedFileId?: {id: string, ts: number} | null;
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
  onSortChange
}: MainContentProps) {
  const { t } = useTranslation();
  const isInitialMount = useRef(true);
  const mainRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [showNewFolderModal, setShowNewFolderModal] = React.useState(false);
  const [showBulkMoveScreen, setShowBulkMoveScreen] = React.useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = React.useState(false);
  // While a native drag is in flight (DropZone announces it), the header
  // chrome and pagination hide so the drop target area is unambiguous; the
  // file-list container also doubles as the scoped dim region ([data-drop-region]).
  const [isDragActive, setIsDragActive] = React.useState(false);

  const explorer = useDriveExplorer(
    currentFolderId,
    currentFolderName,
    token,
    onRefresh,
    onRemoveItem,
    sortOption
  );

  const handleDragActive = (e: Event) => {
    const detail = (e as CustomEvent<{ active: boolean }>).detail;
    setIsDragActive(detail?.active ?? false);
  };
  useEventListener(DRAG_ACTIVE_EVENT, handleDragActive);

  useEffect(() => {
    isInitialMount.current = false;
  }, []);

  // Keyboard shortcuts
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      if (document.activeElement === searchInputRef.current) {
        searchInputRef.current?.blur();
        explorer.setSearchQuery("");
      } else {
        searchInputRef.current?.focus();
      }
    }
    if (e.key === 'Escape' && document.activeElement === searchInputRef.current) {
      searchInputRef.current?.blur();
      explorer.setSearchQuery("");
    }
  };
  useEventListener('keydown', handleKeyDown, [explorer.setSearchQuery]);

  // Enable selection mode from events
  const handleEnableSelection = (e: Event) => {
    const customEvent = e as CustomEvent;
    if (customEvent.detail?.id) {
      explorer.setIsSelectionMode(true);
      explorer.setSelectedIds(new Set([customEvent.detail.id]));
    }
  };
  useEventListener('enable-selection-mode', handleEnableSelection, [explorer.setIsSelectionMode, explorer.setSelectedIds]);

  // Scroll to top on folder change
  const prevFolderRef = useRef(currentFolderId);
  useEffect(() => {
    if (mainRef.current) {
      const isFolderChange = currentFolderId !== prevFolderRef.current;
      if (isFolderChange && !highlightedFileId) {
        mainRef.current.scrollTo({ top: 0, behavior: 'smooth' });
      }
      prevFolderRef.current = currentFolderId;
    }
  }, [currentFolderId, highlightedFileId]);

  // Virtualizer is now isolated inside VirtualizedSongList
  const virtualizedListRef = useRef<VirtualizedSongListHandle>(null);

  // Handle highlight scrolling
  useEffect(() => {
    if (highlightedFileId && explorer.filteredItems.length > 0) {
      const index = explorer.filteredItems.findIndex(item => item.id === highlightedFileId.id);
      if (index !== -1) {
        const targetPage = Math.floor(index / ITEMS_PER_PAGE) + 1;
        if (targetPage !== explorer.currentPage) {
          explorer.setCurrentPage(targetPage);
          const timerId = setTimeout(() => {
            const pageIndex = index % ITEMS_PER_PAGE;
            virtualizedListRef.current?.scrollToIndex(pageIndex, { align: 'center' });
          }, SCROLL_HIGHLIGHT_DELAY_MS);
          return () => clearTimeout(timerId);
        } else {
          const pageIndex = index % ITEMS_PER_PAGE;
          virtualizedListRef.current?.scrollToIndex(pageIndex, { align: 'center' });
        }
      }
    }
  }, [highlightedFileId, explorer.currentPage, explorer.filteredItems, explorer.setCurrentPage]);

  useEffect(() => {
    clearPrefetchedStreams();
    clearNextTrackPrefetches();
  }, [currentFolderId]);

  const handlePlay = useCallback((t: Track) => {
    const queue = explorer.filteredItems.filter(f => !f.isFolder && f.trackInfo).map(f => f.trackInfo!);
    onPlay(t, queue);
  }, [explorer.filteredItems, onPlay]);

  const handleBulkMoveClick = useCallback(() => setShowBulkMoveScreen(true), []);
  const handleBulkDeleteClick = useCallback(() => setShowBulkDeleteConfirm(true), []);

  return (
    <main ref={mainRef} className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto overscroll-none relative transition-colors duration-300" style={{ contain: 'layout style paint' }}>
      {showBulkMoveScreen && token && (
        <FolderSelectionScreen
          token={token}
          onCancel={() => setShowBulkMoveScreen(false)}
          onSelectFolder={(destId) => explorer.handleBulkMove(destId, () => setShowBulkMoveScreen(false))}
          title={t('folder_selection.bulk_move_title', 'Choose destination folder')}
        />
      )}

      <div
        data-testid="main-header-chrome"
        className={`sticky top-0 px-8 pt-8 pb-4 shrink-0 z-20 bg-white/95 dark:bg-[#121212]/95 shadow-[0_4px_20px_rgba(0,0,0,0.02)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.1)] transition-opacity duration-200 ${isDragActive ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
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
          onNewFolderClick={() => setShowNewFolderModal(true)}
          isInitialMount={isInitialMount}
          searchInputRef={searchInputRef}
        />

        <SelectionToolbar
          isSelectionMode={explorer.isSelectionMode}
          selectedCount={explorer.selectedIds.size}
          totalCount={explorer.filteredItems.length}
          isBulkOperating={explorer.isBulkOperating}
          onToggleSelectAll={() => {
            explorer.setSelectedIds(prev => {
              if (prev.size === explorer.filteredItems.length) return new Set();
              // Uploading items must never join the selection (their pending
              // rows cannot be bulk-deleted/moved); Select All picks only the
              // items that are safe to operate on.
              return new Set(
                explorer.filteredItems.filter(i => !isUploading(i.id)).map(i => i.id)
              );
            });
          }}
          onBulkMoveClick={handleBulkMoveClick}
          onBulkDeleteClick={handleBulkDeleteClick}
        />
      </div>
        
      <div data-drop-region className="px-8 pb-6 pt-4" style={{ minHeight: `calc(100% - ${HEADER_CHROME_HEIGHT_PX}px)` }}>
        {activeTab === TABS.settings ? (
          <div className="text-gray-500">{t('settings.coming_soon', 'Coming Soon')}</div>
        ) : isLoading ? (
          // [data-drop-region] sizes itself with min-height only, so a
          // percentage h-full inside it would not resolve. Give the skeleton
          // wrapper the same min-height formula instead, then let
          // SkeletonRowList (h-full + flex-1) and its rows (flex-1) share the
          // space so the skeleton covers the whole loading region.
          <div role="status" aria-label={t('loading', 'Loading...')} className="flex flex-col" style={{ minHeight: `calc(100% - ${HEADER_CHROME_HEIGHT_PX}px)` }}>
            <SkeletonRowList rows={8} stretch className="flex-1" />
          </div>
        ) : explorer.filteredItems.length === 0 ? (
          <div className="text-gray-500 py-10 text-center">
            {explorer.searchQuery ? t('drive.no_search_results') : t('drive.no_audio')}
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
              className={`sticky bottom-0 py-1 transition-opacity duration-200 ${isDragActive ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
            >
              <PaginationControls
                currentPage={explorer.currentPage}
                totalPages={explorer.totalPages}
                setCurrentPage={explorer.setCurrentPage}
                onScrollTop={() => virtualizedListRef.current?.scrollToIndex(0, { align: 'start' })}
              />
            </div>
          </>
        )}
      </div>

      <BulkDeleteConfirmModal
        isOpen={showBulkDeleteConfirm}
        onClose={() => setShowBulkDeleteConfirm(false)}
        onConfirm={() => explorer.handleBulkDelete(() => setShowBulkDeleteConfirm(false))}
        isOperating={explorer.isBulkOperating}
        selectedCount={explorer.selectedIds.size}
      />

      <NewFolderModal
        isOpen={showNewFolderModal}
        onClose={() => setShowNewFolderModal(false)}
        onCreate={(name) => explorer.handleCreateFolder(name, () => setShowNewFolderModal(false))}
        isCreating={explorer.isCreatingFolder}
      />
    </main>
  );
});
