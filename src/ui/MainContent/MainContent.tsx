import React, { useRef, useEffect, useCallback } from "react";
import { useVirtualizer } from '@tanstack/react-virtual';
import { Track, DriveItem } from "../../App";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";

import { clearNextTrackPrefetches } from "../../utils/nextTrackPrefetcher";
import { clearPrefetchedStreams } from "../../utils/streamPrefetcher";

import { SongCard } from './components/SongCard';
import { BulkDeleteConfirmModal } from './components/BulkDeleteConfirmModal';
import { NewFolderModal } from './components/NewFolderModal';

import { useDriveExplorer, ITEMS_PER_PAGE } from "../../hooks/useDriveExplorer";
import { getUploadState, subscribe as subscribeUploads } from "../../utils/uploadManager";

import { TopNavigationBar } from "./components/TopNavigationBar";
import { SelectionToolbar } from "./components/SelectionToolbar";
import { PaginationControls } from "./components/PaginationControls";

// Monotonic upload-status version: bumped on every uploadManager notify so the
// virtualized list can re-derive each card's uploadState. Module-level (not
// component state) so a list remounted mid-upload still starts from the latest
// version — useSyncExternalStore re-reads the snapshot right after subscribing.
let uploadVersion = 0;

interface MainContentProps {
  activeTab: string;
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

  const explorer = useDriveExplorer(
    currentFolderId,
    currentFolderName,
    token,
    onRefresh,
    onRemoveItem,
    sortOption
  );

  useEffect(() => {
    isInitialMount.current = false;
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
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
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [explorer]);

  // Enable selection mode from events
  useEffect(() => {
    const handleEnableSelection = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail?.id) {
        explorer.setIsSelectionMode(true);
        explorer.setSelectedIds(new Set([customEvent.detail.id]));
      }
    };
    window.addEventListener('enable-selection-mode', handleEnableSelection);
    return () => window.removeEventListener('enable-selection-mode', handleEnableSelection);
  }, [explorer]);

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
  const virtualizedListRef = useRef<{ scrollToIndex: (index: number, options?: any) => void }>(null);

  // Handle highlight scrolling
  useEffect(() => {
    if (highlightedFileId && explorer.filteredItems.length > 0) {
      const index = explorer.filteredItems.findIndex(item => item.id === highlightedFileId.id);
      if (index !== -1) {
        const targetPage = Math.floor(index / ITEMS_PER_PAGE) + 1;
        if (targetPage !== explorer.currentPage) {
          explorer.setCurrentPage(targetPage);
          setTimeout(() => {
            const pageIndex = index % ITEMS_PER_PAGE;
            virtualizedListRef.current?.scrollToIndex(pageIndex, { align: 'center' });
          }, 50);
        } else {
          const pageIndex = index % ITEMS_PER_PAGE;
          virtualizedListRef.current?.scrollToIndex(pageIndex, { align: 'center' });
        }
      }
    }
  }, [highlightedFileId, explorer.currentPage, explorer.filteredItems, explorer]);

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
          title="Chọn thư mục đích"
        />
      )}

      <div className="sticky top-0 px-8 pt-8 pb-4 shrink-0 z-20 bg-white/95 dark:bg-[#121212]/95 shadow-[0_4px_20px_rgba(0,0,0,0.02)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.1)]">
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
              return new Set(explorer.filteredItems.map(i => i.id));
            });
          }}
          onBulkMoveClick={handleBulkMoveClick}
          onBulkDeleteClick={handleBulkDeleteClick}
        />
      </div>
        
      <div className="px-8 pb-6 pt-4 min-h-[calc(100%-140px)]">
        {activeTab === "Settings" ? (
          <div className="text-gray-500">Settings page coming soon...</div>
        ) : isLoading ? (
          <div className="flex flex-col items-center justify-center h-[50vh] text-[#4285F4]">
            <Loader2 className="animate-spin h-10 w-10 mb-4 stroke-[1.5]" />
            <span className="text-base font-medium">{t('loading', 'Loading...')}</span>
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

            <PaginationControls
              currentPage={explorer.currentPage}
              totalPages={explorer.totalPages}
              setCurrentPage={explorer.setCurrentPage}
              onScrollTop={() => virtualizedListRef.current?.scrollToIndex(0, { align: 'start' })}
            />
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

const VirtualizedSongList = React.memo(React.forwardRef(function VirtualizedSongList({
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
}: {
  items: DriveItem[];
  scrollElementRef: React.RefObject<HTMLElement | null>;
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
}, ref: React.ForwardedRef<{ scrollToIndex: (index: number, options?: any) => void }>) {
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 92,
    overscan: 15,
    getItemKey: (index: number) => items[index].id,
    useFlushSync: false,
  });

  // External-store subscription to uploadManager: every status change bumps
  // uploadVersion and re-renders this list; each visible card then re-derives
  // its own uploadState via getUploadState(item.id) and the SongCard memo
  // comparator skips cards whose state did not change.
  React.useSyncExternalStore(
    (onStoreChange) => subscribeUploads(() => {
      uploadVersion += 1;
      onStoreChange();
    }),
    () => uploadVersion,
  );

  React.useImperativeHandle(ref, () => ({
    scrollToIndex: (index, options) => {
      rowVirtualizer.scrollToIndex(index, options);
    }
  }));

  const virtualItems = rowVirtualizer.getVirtualItems();

  const handleToggleSelection = React.useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [setSelectedIds]);

  const handleEnableSelectionMode = React.useCallback((id: string) => {
    setIsSelectionMode(true);
    setSelectedIds(new Set([id]));
  }, [setIsSelectionMode, setSelectedIds]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: `${rowVirtualizer.getTotalSize()}px`,
        pointerEvents: rowVirtualizer.isScrolling ? 'none' : 'auto',
      }}
    >
      {virtualItems.map((virtualRow) => {
        const item = items[virtualRow.index];
        if (!item) return null;
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            className="pb-3"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
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
              isHighlighted={item.id === highlightedFileId?.id}
              highlightTrigger={item.id === highlightedFileId?.id ? highlightedFileId.ts : undefined}
              isPlaying={!!isPlaying && item.trackInfo?.id === isPlaying}
              onRefresh={onRefresh}
              onRemoveItem={onRemoveItem}
              isSelectionMode={isSelectionMode}
              isSelected={selectedIds.has(item.id)}
              onToggleSelection={handleToggleSelection}
              onEnableSelectionMode={handleEnableSelectionMode}
              onBulkMoveClick={onBulkMoveClick}
              onBulkDeleteClick={onBulkDeleteClick}
              uploadState={getUploadState(item.id)}
            />
          </div>
        );
      })}
    </div>
  );
}));
