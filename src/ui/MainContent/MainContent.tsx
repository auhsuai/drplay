import React, { useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Track, DriveItem } from "../../App";
import { FolderPlus, Trash2, ArrowLeft, Loader2, Search, CheckSquare, Square, X, Check, FolderOutput, ArrowUpDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";
import { deleteFile, moveFile } from "../../utils/driveApi";


interface MainContentProps {
  activeTab: string;
  onPlay: (track: Track) => void;
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

import { createFolder } from '../../utils/driveApi';
import { db } from '../../db/db';
import { SongCard } from './components/SongCard';
import { BulkDeleteConfirmModal } from './components/BulkDeleteConfirmModal';
import { NewFolderModal } from './components/NewFolderModal';

export function MainContent({ 
  activeTab, 
  onPlay, 
  items, 
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
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkMoveScreen, setShowBulkMoveScreen] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [isBulkOperating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const mainRef = React.useRef<HTMLElement>(null);

  // Reset highlight on folder change
  React.useEffect(() => {
    // any extra folder change logic can go here
  }, [currentFolderId]);

  React.useEffect(() => {
    const handleEnableSelection = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail?.id) {
        setIsSelectionMode(true);
        setSelectedIds(new Set([customEvent.detail.id]));
      }
    };
    window.addEventListener('enable-selection-mode', handleEnableSelection);
    return () => window.removeEventListener('enable-selection-mode', handleEnableSelection);
  }, []);

  const prevFolderRef = React.useRef(currentFolderId);

  React.useEffect(() => {
    if (mainRef.current) {
      const isFolderChange = currentFolderId !== prevFolderRef.current;
      
      if (isFolderChange && !highlightedFileId) {
        mainRef.current.scrollTo({ top: 0, behavior: 'smooth' });
      }
      
      prevFolderRef.current = currentFolderId;
    }
  }, [currentFolderId]);

  React.useEffect(() => {
    if (highlightedFileId && items.length > 0) {
      const filteredItemsForHighlight = items.filter(item => 
        item.title.toLowerCase().includes(searchQuery.toLowerCase())
      );
      const index = filteredItemsForHighlight.findIndex(item => item.id === highlightedFileId.id);
      if (index !== -1) {
        rowVirtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
      }
    }
  }, [highlightedFileId, items, searchQuery]);

  const filteredItems = items.filter(item => 
    item.title.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const currentItems = filteredItems;
  
  const rowVirtualizer = useVirtualizer({
    count: currentItems.length,
    getScrollElement: () => mainRef.current,
    estimateSize: () => 92,
    overscan: 10,
  });

  const handleCreateFolder = async (folderName: string) => {
    if (!token) return;
    setIsCreating(true);
    try {
      const res = await createFolder(token, folderName, currentFolderId);
      if (res && res.id) {
        await db.files.put({
          id: res.id,
          name: res.name || folderName,
          parentId: currentFolderId,
          mimeType: 'application/vnd.google-apps.folder',
          isFolder: true,
          trashed: false,
          modifiedTime: new Date().toISOString()
        });
      }
      setShowNewFolderModal(false);
      onRefresh();
    } catch (e) {
      console.error("Failed to create folder", e);
      alert(t('drive.create_folder_error') || "Failed to create folder");
      throw e;
    } finally {
      setIsCreating(false);
    }
  };

  const handleBulkDelete = async () => {
    if (!token || selectedIds.size === 0) return;
    
    // Optimistic UI
    const itemsToDelete = Array.from(selectedIds);
    if (onRemoveItem) {
      itemsToDelete.forEach(id => onRemoveItem(id));
    }
    
    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setShowBulkDeleteConfirm(false);
    
    try {
      const deletePromises = itemsToDelete.map(async id => {
        await db.files.delete(id);
        return deleteFile(token, id);
      });
      await Promise.all(deletePromises);
    } catch (e) {
      console.error("Failed to delete items", e);
      alert(t('drive.delete_error') || "Failed to delete one or more items.");
      onRefresh();
    }
  };

  const handleBulkMove = async (destinationFolderId: string) => {
    if (!token || selectedIds.size === 0) return;
    
    // Optimistic UI
    const itemsToMove = Array.from(selectedIds);
    if (onRemoveItem) {
      itemsToMove.forEach(id => onRemoveItem(id));
    }
    
    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setShowBulkMoveScreen(false);
    
    try {
      const movePromises = itemsToMove.map(async id => {
        const item = await db.files.get(id);
        if (item) {
          await db.files.update(id, { parentId: destinationFolderId });
        }
        return moveFile(token, id, currentFolderId, destinationFolderId);
      });
      await Promise.all(movePromises);
    } catch (e) {
      console.error("Failed to move items", e);
      alert("Failed to move one or more items.");
      onRefresh();
    }
  };

  const sortOptions = [
    { id: 'name', label: t('sort.name_asc', 'Tên File (A-Z)') },
    { id: 'name desc', label: t('sort.name_desc', 'Tên File (Z-A)') },
    { id: 'modifiedTime desc', label: t('sort.modified_desc', 'Mới nhất') },
    { id: 'modifiedTime', label: t('sort.modified_asc', 'Cũ nhất') },
  ];
  const currentSortLabel = sortOptions.find(opt => opt.id === sortOption)?.label || t('drive.sort', 'Sort');

  return (
    <main ref={mainRef} className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto relative transition-colors duration-300">
      {showBulkMoveScreen && token && (
        <FolderSelectionScreen
          token={token}
          onCancel={() => setShowBulkMoveScreen(false)}
          onSelectFolder={handleBulkMove}
          title="Chọn thư mục đích"
        />
      )}
      <div className="sticky top-0 px-8 pt-8 pb-4 shrink-0 z-20 bg-white/95 dark:bg-[#121212]/95 backdrop-blur-md shadow-[0_4px_20px_rgba(0,0,0,0.02)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.1)]">
        <div className="flex items-center justify-between">
          {isSelectionMode ? (
            <div className="flex items-center gap-2 text-sm font-medium animate-in fade-in slide-in-from-left-4 duration-300">
              <button
                onClick={() => {
                  setIsSelectionMode(false);
                  setSelectedIds(new Set());
                }}
                className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors mr-2 shrink-0"
              >
                <X className="w-5 h-5 text-gray-700 dark:text-gray-300" />
              </button>
              <span className="text-gray-900 dark:text-white px-2 py-1 font-semibold text-lg truncate">
                {t('drive.items_selected', '{{count}} mục đã chọn', { count: selectedIds.size })}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm font-medium">
              <button 
                onClick={onBack}
                disabled={!hasHistory}
                className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent transition-colors mr-2 shrink-0"
              >
                <ArrowLeft className="w-5 h-5 text-gray-700 dark:text-gray-300" />
              </button>
              
              {folderHistory.map((folder, index) => (
                <div key={folder.id} className="flex items-center">
                  <span className="text-gray-400 mx-1">/</span>
                  <button 
                    onClick={() => onBreadcrumbClick(folder.id, folder.name, index)}
                    className="text-gray-500 dark:text-gray-400 hover:text-[#4285F4] dark:hover:text-[#4285F4] hover:bg-[#4285F4]/5 px-2 py-1 rounded-md transition-colors truncate max-w-[150px]"
                    title={folder.name}
                  >
                    {folder.name}
                  </button>
                </div>
              ))}
              <div className="flex items-center">
                {folderHistory.length > 0 && <span className="text-gray-400 mx-1">/</span>}
                <span className="text-gray-900 dark:text-white px-2 py-1 font-semibold truncate max-w-[200px]" title={currentFolderName}>
                  {currentFolderName}
                </span>
              </div>
            </div>
          )}
          
          {isSelectionMode ? (
            <div className="flex items-center gap-3 animate-in fade-in slide-in-from-right-4 duration-300">
              <button
                onClick={() => {
                  if (selectedIds.size === currentItems.length) {
                    setSelectedIds(new Set());
                  } else {
                    setSelectedIds(new Set(currentItems.map(i => i.id)));
                  }
                }}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-colors shadow-sm active:scale-95"
              >
                {selectedIds.size === currentItems.length ? <Square className="w-4 h-4" /> : <CheckSquare className="w-4 h-4" />}
                <span className="hidden sm:inline">{t('drive.select_all', 'Chọn tất cả')}</span>
              </button>
              
              <button
                onClick={() => {
                  setShowBulkMoveScreen(true);
                }}
                disabled={selectedIds.size === 0 || isBulkOperating}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-colors shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <FolderOutput className="w-4 h-4" />
                <span className="hidden sm:inline">{t('drive.bulk_move', 'Di chuyển')}</span>
              </button>

              <button
                onClick={() => {
                  setShowBulkDeleteConfirm(true);
                }}
                disabled={selectedIds.size === 0 || isBulkOperating}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isBulkOperating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                <span className="hidden sm:inline">{t('drive.delete', 'Xóa')}</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
            {/* Search Input */}
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder={t('search_placeholder', 'Tìm kiếm...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-40 sm:w-56 pl-9 pr-3 py-1.5 text-sm font-medium bg-gray-100 dark:bg-[#1a1b1e] text-gray-900 dark:text-gray-100 rounded-lg outline-none focus:ring-2 focus:ring-[#4285F4]/50 border border-transparent focus:border-transparent transition-all placeholder:text-gray-400"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Sort Dropdown */}
            {token && (
              <div className="relative">
                <button
                  onClick={() => setShowSortMenu(!showSortMenu)}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-colors shadow-sm active:scale-95"
                >
                  <ArrowUpDown className="w-4 h-4" />
                  <span className="hidden sm:inline">{currentSortLabel}</span>
                </button>

                {showSortMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowSortMenu(false)}></div>
                    <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-[#1a1b1e] rounded-xl shadow-lg p-1.5 flex flex-col gap-0.5 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
                      {sortOptions.map((opt) => (
                        <button
                          key={opt.id}
                          onClick={() => {
                            onSortChange?.(opt.id);
                            setShowSortMenu(false);
                          }}
                          className={`w-full flex items-center justify-between px-2.5 py-1.5 text-sm transition-colors rounded-md hover:bg-gray-50 dark:hover:bg-[#25262a] hover:text-[#4285F4] dark:hover:text-[#4285F4] ${sortOption === opt.id ? 'text-[#4285F4] font-medium' : 'text-gray-700 dark:text-gray-300'}`}
                        >
                          {opt.label}
                          {sortOption === opt.id && <Check className="w-4 h-4" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {token && (
              <button 
                onClick={() => setShowNewFolderModal(true)}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-[#4285F4] hover:bg-[#3367d6] rounded-lg transition-colors shadow-sm active:scale-95"
              >
                <FolderPlus className="w-4 h-4" />
                <span className="hidden sm:inline">{t('drive.new_folder') || 'New Folder'}</span>
              </button>
            )}
          </div>
          )}
        </div>
      </div>
        
      <div className="px-8 pb-6 pt-4 min-h-[calc(100%-140px)]">
        {activeTab === "Settings" ? (
          <div className="text-gray-500">Settings page coming soon...</div>
        ) : isLoading ? (
          <div className="flex flex-col items-center justify-center h-[50vh] text-[#4285F4]">
            <Loader2 className="animate-spin h-10 w-10 mb-4 stroke-[1.5]" />
            <span className="text-base font-medium">{t('loading', 'Loading...')}</span>
          </div>
        ) : items.length === 0 ? (
          <div className="text-gray-500 py-10 text-center">
            {t('drive.no_audio')}
          </div>
        ) : (
          <div className="flex flex-col relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const item = currentItems[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="pb-2"
                >
                <SongCard 
                  key={item.id}
                  item={item} 
                  onPlay={onPlay} 
                  onOpenFolder={onOpenFolder} 
                  token={token}
                  currentFolderId={currentFolderId}
                  currentFolderName={currentFolderName}
                  folderHistory={folderHistory}
                  isHighlighted={item.id === highlightedFileId?.id}
                  highlightTrigger={item.id === highlightedFileId?.id ? highlightedFileId.ts : undefined}
                  isPlaying={currentTrack?.id === item.id}
                  onRefresh={onRefresh}
                  onRemoveItem={onRemoveItem}
                  isSelectionMode={isSelectionMode}
                  isSelected={selectedIds.has(item.id)}
                  onToggleSelection={() => {
                    const next = new Set(selectedIds);
                    if (next.has(item.id)) {
                      next.delete(item.id);
                    } else {
                      next.add(item.id);
                    }
                    setSelectedIds(next);
                  }}
                  onEnableSelectionMode={() => {
                    setIsSelectionMode(true);
                    setSelectedIds(new Set([item.id]));
                  }}
                />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination removed - using Virtual Scrolling */}

      <BulkDeleteConfirmModal
        isOpen={showBulkDeleteConfirm}
        onClose={() => setShowBulkDeleteConfirm(false)}
        onConfirm={handleBulkDelete}
        isOperating={isBulkOperating}
        selectedCount={selectedIds.size}
      />

      <NewFolderModal
        isOpen={showNewFolderModal}
        onClose={() => setShowNewFolderModal(false)}
        onCreate={handleCreateFolder}
        isCreating={isCreating}
      />
    </main>
  );
}
