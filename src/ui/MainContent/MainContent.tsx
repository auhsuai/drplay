import React, { useState } from "react";
import { Track, DriveItem } from "../../App";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";

import { clearPrefetchedStreams } from "../../utils/streamPrefetcher";
import { clearNextTrackPrefetches } from "../../utils/nextTrackPrefetcher";
import { useTagLookup } from "./hooks/useTagLookup";
import { useBulkOperations } from "./hooks/useBulkOperations";
import { useFolderSearch } from "./hooks/useFolderSearch";
import { useFileListVirtualizer } from "./hooks/useFileListVirtualizer";
import { useKeyboardSearch } from "./hooks/useKeyboardSearch";
import { useCreateFolder } from "./hooks/useCreateFolder";
import { VirtualizedSongList } from "./components/VirtualizedSongList";
import { PaginationBar } from "./components/PaginationBar";
import { Toolbar } from "./components/Toolbar";
import { BulkDeleteConfirmModal } from "./components/BulkDeleteConfirmModal";
import { NewFolderModal } from "./components/NewFolderModal";

interface MainContentProps {
  activeTab: string;
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  items: DriveItem[];
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
  activeTab, onPlay, items, isLoading, onOpenFolder, onBack,
  hasHistory, folderHistory, currentFolderName, currentFolderId,
  onBreadcrumbClick, token, highlightedFileId, onRefresh, onRemoveItem,
  currentTrack, sortOption = "name_natural", onSortChange,
}: MainContentProps) {
  const { t } = useTranslation();
  const mainRef = React.useRef<HTMLElement>(null);

  // Modal / UI state
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkMoveScreen, setShowBulkMoveScreen] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [isBulkOperating, setIsBulkOperating] = useState(false);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

  // Reset search on folder change
  React.useEffect(() => { setSearchQuery(""); }, [currentFolderId]);

  // Enable-selection-mode event
  React.useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent;
      if (ce.detail?.id) { setIsSelectionMode(true); setSelectedIds(new Set([ce.detail.id])); }
    };
    window.addEventListener('enable-selection-mode', handler);
    return () => window.removeEventListener('enable-selection-mode', handler);
  }, []);

  // Keyboard search (Ctrl+F)
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  useKeyboardSearch({ searchInputRef, setSearchQuery });

  // Search pipeline
  const { filteredItems, currentItems, totalPages } = useFolderSearch({
    items, currentFolderId, currentPage, itemsPerPage, searchQuery,
  });

  // Virtualizer + scroll logic
  const { rowVirtualizer } = useFileListVirtualizer({
    currentItems, currentFolderId, searchQuery, sortOption,
    highlightedFileId, filteredItems, itemsPerPage, currentPage, setCurrentPage,
    scrollContainerRef: mainRef,
  });

  // Clear prefetch caches on folder change
  React.useEffect(() => { clearPrefetchedStreams(); clearNextTrackPrefetches(); }, [currentFolderId]);

  // Tag lookup
  const { tagMetadataRef } = useTagLookup({ currentItems });

  // Bulk operations
  const { handleBulkDelete, handleBulkMove, handleBulkMoveClick, handleBulkDeleteClick } =
    useBulkOperations({ token, currentFolderId, selectedIds, setSelectedIds,
      setIsSelectionMode, setShowBulkDeleteConfirm, setShowBulkMoveScreen,
      isBulkOperating, setIsBulkOperating, onRemoveItem, t });

  // Create folder
  const { handleCreateFolder, isCreating } = useCreateFolder({ token, currentFolderId, onRefresh, setShowNewFolderModal });

  // Play handler
  const handlePlay = React.useCallback((t: Track) => {
    const queue = currentItems.filter(f => !f.isFolder && f.trackInfo).map(f => f.trackInfo!);
    onPlay(t, queue);
  }, [currentItems, onPlay]);

  return (
    <main ref={mainRef} className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto relative transition-colors duration-300">
      {showBulkMoveScreen && token && (
        <FolderSelectionScreen token={token} onCancel={() => setShowBulkMoveScreen(false)}
          onSelectFolder={handleBulkMove} title="Chọn thư mục đích" />
      )}
      <Toolbar
        isSelectionMode={isSelectionMode} selectedIds={selectedIds}
        filteredCount={filteredItems.length} hasHistory={hasHistory}
        folderHistory={folderHistory} currentFolderName={currentFolderName}
        searchQuery={searchQuery} searchInputRef={searchInputRef}
        sortOption={sortOption} showSortMenu={showSortMenu}
        isBulkOperating={isBulkOperating} token={token}
        onCancelSelection={() => { setIsSelectionMode(false); setSelectedIds(new Set()); }}
        onSelectAll={() => setSelectedIds(prev => prev.size === filteredItems.length ? new Set() : new Set(filteredItems.map(i => i.id)))}
        onSearchChange={setSearchQuery} onBack={onBack}
        onBreadcrumbClick={onBreadcrumbClick} onSortChange={onSortChange}
        onToggleSortMenu={() => setShowSortMenu(s => !s)}
        onNewFolder={() => setShowNewFolderModal(true)}
        onBulkMove={() => setShowBulkMoveScreen(true)}
        onBulkDelete={() => setShowBulkDeleteConfirm(true)}
      />
      <div className="px-8 pb-6 pt-4 min-h-[calc(100%-140px)]">
        {activeTab === "Settings" ? (
          <div className="text-gray-500">Settings page coming soon...</div>
        ) : isLoading ? (
          <div className="flex flex-col items-center justify-center h-[50vh] text-[#4285F4]">
            <Loader2 className="animate-spin h-10 w-10 mb-4 stroke-[1.5]" />
            <span className="text-base font-medium">{t('loading', 'Loading...')}</span>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="text-gray-500 py-10 text-center">
            {searchQuery ? t('drive.no_search_results') : t('drive.no_audio')}
          </div>
        ) : (
          <>
            <VirtualizedSongList
              items={currentItems} rowVirtualizer={rowVirtualizer}
              onPlay={handlePlay} onOpenFolder={onOpenFolder} token={token}
              currentFolderId={currentFolderId} currentFolderName={currentFolderName}
              folderHistory={folderHistory} highlightedFileId={highlightedFileId}
              isPlaying={currentTrack?.id} onRefresh={onRefresh} onRemoveItem={onRemoveItem}
              isSelectionMode={isSelectionMode} selectedIds={selectedIds}
              setSelectedIds={setSelectedIds} setIsSelectionMode={setIsSelectionMode}
              onBulkMoveClick={handleBulkMoveClick} onBulkDeleteClick={handleBulkDeleteClick}
              tagMetadataMap={tagMetadataRef.current}
            />
            <PaginationBar currentPage={currentPage} totalPages={totalPages}
              rowVirtualizer={rowVirtualizer} onPageChange={setCurrentPage} />
          </>
        )}
      </div>
      <BulkDeleteConfirmModal
        isOpen={showBulkDeleteConfirm} onClose={() => setShowBulkDeleteConfirm(false)}
        onConfirm={handleBulkDelete} isOperating={isBulkOperating}
        selectedCount={selectedIds.size} />
      <NewFolderModal
        isOpen={showNewFolderModal} onClose={() => setShowNewFolderModal(false)}
        onCreate={handleCreateFolder} isCreating={isCreating} />
    </main>
  );
});
