import React, { useState } from "react";
import { Track, DriveItem } from "../../App";
import { FolderPlus, Trash2, ArrowLeft, Loader2, Search, CheckSquare, Square, X, Check, FolderOutput, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";
import { deleteFile, moveFile } from "../../utils/driveApi";

import { prefetchVisibleTracks, clearPrefetchedStreams } from "../../utils/streamPrefetcher";
import { clearNextTrackPrefetches } from "../../utils/nextTrackPrefetcher";
import { normalizeText } from "../../utils/normalizeText";
import { useCoverWindowing } from "../../hooks/useCoverWindowing";



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

import { createFolder } from '../../utils/driveApi';
import { db } from '../../db/db';
import { SongCard } from './components/SongCard';
import { BulkDeleteConfirmModal } from './components/BulkDeleteConfirmModal';
import { NewFolderModal } from './components/NewFolderModal';
import { showErrorToast } from '../../utils/simpleToast';

function useDebouncedLiveQuery<T>(
  querier: () => Promise<T>,
  deps: React.DependencyList,
  delayMs = 100
): T | undefined {
  const [result, setResult] = React.useState<T>();
  React.useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const data = await querier();
      if (!cancelled) setResult(data);
    }, delayMs);
    return () => { cancelled = true; clearTimeout(timer); };
  }, deps);
  return result;
}

export const MainContent = React.memo(function MainContent({ 
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
  const isInitialMount = React.useRef(true);
  React.useEffect(() => {
    isInitialMount.current = false;
  }, []);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkMoveScreen, setShowBulkMoveScreen] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [isBulkOperating, setIsBulkOperating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const mainRef = React.useRef<HTMLElement>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Reset highlight and search on folder change
  React.useEffect(() => {
    setSearchQuery("");
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

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        if (document.activeElement === searchInputRef.current) {
          searchInputRef.current?.blur();
          setSearchQuery("");
        } else {
          searchInputRef.current?.focus();
        }
      }
      if (e.key === 'Escape' && document.activeElement === searchInputRef.current) {
        searchInputRef.current?.blur();
        setSearchQuery("");
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
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

  const allFiles = useDebouncedLiveQuery(async () => {
    if (!searchQuery) return undefined;
    const files = await db.files.toArray();
    return files.map(f => ({
      id: f.id,
      parentId: f.parentId,
      name: f.name,
      isFolder: f.isFolder,
      size: f.size,
      modifiedTime: f.modifiedTime,
    }));
  }, [searchQuery], 100);

  const parentMap = React.useMemo(() => {
    if (!allFiles) return new Map<string, string>();
    const map = new Map<string, string>();
    allFiles.forEach(f => map.set(f.id, f.parentId));
    return map;
  }, [allFiles]);

  const globalSearchItemsRaw = React.useMemo(() => {
    if (!searchQuery || !allFiles) return [];
    const query = normalizeText(searchQuery);

    const matches = allFiles.filter(f => normalizeText(f.name).includes(query));

    if (!currentFolderId || currentFolderId === 'root' || currentFolderId === '') {
      return matches;
    }

    return matches.filter(f => {
      let current: string | undefined = f.parentId;
      while (current) {
        if (current === currentFolderId) return true;
        current = parentMap.get(current);
      }
      return false;
    });
  }, [searchQuery, allFiles, currentFolderId, parentMap]);

  const globalSearchItems = React.useMemo(() => {
    if (!globalSearchItemsRaw) return [];
    
    const mapped = globalSearchItemsRaw.map(file => {
      const title = file.isFolder ? file.name : file.name.replace(/\.[^/.]+$/, "");
      return {
        id: file.id,
        title,
        isFolder: file.isFolder,
        size: file.size,
        modifiedTime: file.modifiedTime,
        trackInfo: file.isFolder ? undefined : {
          id: file.id,
          title,
          artist: "",
          streamUrl: "",
          size: file.size,
          originalName: file.name,
          parentId: file.parentId,
          parentName: "Search Result",
        }
      };
    });
    
    return mapped.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.title.localeCompare(b.title, undefined, { numeric: true });
    });
  }, [globalSearchItemsRaw]);

  const filteredItems = searchQuery ? globalSearchItems : items;

  const totalPages = Math.ceil(filteredItems.length / PAGE_SIZE);
  const displayItems = React.useMemo(
    () => filteredItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filteredItems, page, PAGE_SIZE]
  );

  React.useEffect(() => {
    if (highlightedFileId && filteredItems.length > 0) {
      const index = filteredItems.findIndex(item => item.id === highlightedFileId.id);
      if (index !== -1) {
        const targetPage = Math.floor(index / PAGE_SIZE);
        if (targetPage !== page) {
          setPage(targetPage);
        }
      }
    }
  }, [highlightedFileId, filteredItems, page, PAGE_SIZE]);

  React.useEffect(() => {
    clearPrefetchedStreams();
    clearNextTrackPrefetches();
  }, [currentFolderId]);

  React.useEffect(() => {
    const trackIds = displayItems.filter(i => !i.isFolder && i.trackInfo?.id).map(i => i.trackInfo!.id);
    prefetchVisibleTracks(trackIds);
  }, [displayItems]);

  const covers = useCoverWindowing({ items: displayItems, token });

  const handlePlay = React.useCallback((t: Track) => {
    const queue = displayItems.filter(f => !f.isFolder && f.trackInfo).map(f => f.trackInfo!);
    onPlay(t, queue);
  }, [displayItems, onPlay]);

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
      console.error("[MainContent] create-folder: Failed to create folder", e);
      showErrorToast(t('drive.create_folder_error') || "Failed to create folder");
      throw e;
    } finally {
      setIsCreating(false);
    }
  };

  const handleBulkDelete = async () => {
    if (!token || selectedIds.size === 0) return;
    
    const itemsToDelete = Array.from(selectedIds);
    
    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setShowBulkDeleteConfirm(false);

    setIsBulkOperating(true);
    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    try {
      for (const id of itemsToDelete) {
        try {
          await deleteFile(token, id);
          deletedIds.push(id);
        } catch (e) {
          failedIds.push(id);
          console.error(`[MainContent] bulk-delete: Failed to delete item ${id}`, e);
        }
      }
      if (deletedIds.length > 0) {
        await db.files.bulkDelete(deletedIds);
        if (onRemoveItem) deletedIds.forEach(id => onRemoveItem(id));
      }
      if (failedIds.length > 0) {
        showErrorToast(t('drive.delete_error') || "Failed to delete one or more items.");
      }
    } catch (e) {
      console.error("[MainContent] bulk-delete: Unexpected error during bulk delete", e);
      showErrorToast(t('drive.delete_error') || "Failed to delete one or more items.");
    } finally {
      setIsBulkOperating(false);
    }
  };

  const handleBulkMove = async (destinationFolderId: string) => {
    if (!token || selectedIds.size === 0) return;
    
    const itemsToMove = Array.from(selectedIds);

    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setShowBulkMoveScreen(false);

    setIsBulkOperating(true);
    const movedIds: string[] = [];
    const failedIds: string[] = [];
    try {
      for (const id of itemsToMove) {
        try {
          await moveFile(token, id, currentFolderId, destinationFolderId);
          movedIds.push(id);
        } catch (e) {
          failedIds.push(id);
          console.error(`[MainContent] bulk-move: Failed to move item ${id}`, e);
        }
      }
      for (const id of movedIds) {
        await db.files.update(id, { parentId: destinationFolderId });
      }
      if (onRemoveItem && movedIds.length > 0) movedIds.forEach(id => onRemoveItem(id));
      if (failedIds.length > 0) {
        showErrorToast(t('drive.move_error') || "Failed to move one or more items.");
      }
    } catch (e) {
      console.error("[MainContent] bulk-move: Unexpected error during bulk move", e);
      showErrorToast(t('drive.move_error') || "Failed to move one or more items.");
    } finally {
      setIsBulkOperating(false);
    }
  };

  const baseSortOption = sortOption.replace(' desc', '');
  const sortOptions = [
    { id: 'name', label: t('sort.name', 'A-Z') },
    { id: 'modifiedTime', label: t('sort.date', 'Ngày') },
    { id: 'size', label: t('sort.size', 'Kích thước') },
  ];
  const currentSortLabel = sortOptions.find(opt => opt.id === baseSortOption)?.label || t('drive.sort', 'Sort');

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
                  setSelectedIds(prev => {
                    if (prev.size === filteredItems.length) {
                      return new Set();
                    } else {
                      return new Set(filteredItems.map(i => i.id));
                    }
                  });
                }}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-colors shadow-sm active:scale-95"
              >
                {selectedIds.size === filteredItems.length ? <Square className="w-4 h-4" /> : <CheckSquare className="w-4 h-4" />}
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
            <div className="flex items-center gap-3 shrink-0">
            {/* Search Input */}
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                ref={searchInputRef}
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
                <div
                  onClick={() => setShowSortMenu(!showSortMenu)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-all shadow-sm [&:active:not(:has(.arrow-btn:active))]:scale-95 cursor-pointer select-none"
                >
                  <div 
                    className="arrow-btn p-1 -ml-1.5 rounded-md hover:bg-gray-200 dark:hover:bg-[#2e2f34] transition-transform active:scale-75 flex items-center justify-center"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (sortOption.endsWith(' desc')) {
                        onSortChange?.(sortOption.replace(' desc', ''));
                      } else {
                        onSortChange?.(sortOption + ' desc');
                      }
                    }}
                    title="Toggle Order"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 relative">
                      <style>
                        {`
                          @keyframes fillUp { 
                            from { clip-path: inset(100% 0 0 0); } 
                            to { clip-path: inset(0 0 0 0); } 
                          }
                          @keyframes drainUp { 
                            from { clip-path: inset(0 0 0 0); } 
                            to { clip-path: inset(0 0 100% 0); } 
                          }
                          @keyframes fillDown { 
                            from { clip-path: inset(0 0 100% 0); } 
                            to { clip-path: inset(0 0 0 0); } 
                          }
                          @keyframes drainDown { 
                            from { clip-path: inset(0 0 0 0); } 
                            to { clip-path: inset(100% 0 0 0); } 
                          }
                          
                          .anim-fill-up { animation: fillUp 300ms ease-in-out forwards; }
                          .anim-drain-up { animation: drainUp 300ms ease-in-out forwards; }
                          .anim-fill-down { animation: fillDown 300ms ease-in-out forwards; }
                          .anim-drain-down { animation: drainDown 300ms ease-in-out forwards; }
                        `}
                      </style>
                      
                      {/* White UP Arrow (Inverse animated) */}
                      <g className={`stroke-white ${isInitialMount.current ? (!sortOption.endsWith(' desc') ? 'opacity-0' : '') : (!sortOption.endsWith(' desc') ? 'anim-drain-up' : 'anim-fill-up')}`}>
                        <path d="m3 8 4-4 4 4"/>
                        <path d="M7 4v16"/>
                      </g>

                      {/* Blue UP Arrow */}
                      <g className={`stroke-[#4285F4] ${isInitialMount.current ? (!sortOption.endsWith(' desc') ? '' : 'opacity-0') : (!sortOption.endsWith(' desc') ? 'anim-fill-up' : 'anim-drain-up')}`}>
                        <path d="m3 8 4-4 4 4"/>
                        <path d="M7 4v16"/>
                      </g>
                      
                      {/* White DOWN Arrow (Inverse animated) */}
                      <g className={`stroke-white ${isInitialMount.current ? (sortOption.endsWith(' desc') ? 'opacity-0' : '') : (sortOption.endsWith(' desc') ? 'anim-drain-down' : 'anim-fill-down')}`}>
                        <path d="m21 16-4 4-4-4"/>
                        <path d="M17 20V4"/>
                      </g>

                      {/* Blue DOWN Arrow */}
                      <g className={`stroke-[#4285F4] ${isInitialMount.current ? (sortOption.endsWith(' desc') ? '' : 'opacity-0') : (sortOption.endsWith(' desc') ? 'anim-fill-down' : 'anim-drain-down')}`}>
                        <path d="m21 16-4 4-4-4"/>
                        <path d="M17 20V4"/>
                      </g>
                    </svg>
                  </div>
                  <div className="hidden sm:grid text-center pr-1">
                    <span className="col-start-1 row-start-1 visible place-self-center">{currentSortLabel}</span>
                    {sortOptions.map(opt => (
                      <span key={opt.id} className="col-start-1 row-start-1 invisible pointer-events-none select-none" aria-hidden="true">
                        {opt.label}
                      </span>
                    ))}
                  </div>
                </div>

                {showSortMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowSortMenu(false)}></div>
                    <div className="absolute right-0 mt-2 w-32 bg-white dark:bg-[#1a1b1e] rounded-xl shadow-lg p-1.5 flex flex-col gap-0.5 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
                      {sortOptions.map((opt) => (
                        <button
                          key={opt.id}
                          onClick={() => {
                            let newOpt = opt.id;
                            if (opt.id === 'modifiedTime') newOpt = 'modifiedTime desc';
                            
                            onSortChange?.(newOpt);
                            setShowSortMenu(false);
                          }}
                          className={`w-full flex items-center justify-between px-2.5 py-1.5 text-sm transition-colors rounded-md hover:bg-gray-50 dark:hover:bg-[#25262a] hover:text-[#4285F4] dark:hover:text-[#4285F4] ${baseSortOption === opt.id ? 'text-[#4285F4] font-medium' : 'text-gray-700 dark:text-gray-300'}`}
                        >
                          {opt.label}
                          {baseSortOption === opt.id && <Check className="w-4 h-4" />}
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
        ) : filteredItems.length === 0 ? (
          <div className="text-gray-500 py-10 text-center">
            {searchQuery ? t('drive.no_search_results') : t('drive.no_audio')}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2 w-full">
              {displayItems.map((item) => (
                <SongCard 
                  key={item.id}
                  item={item}
                  coverUrl={covers.get(item.id) ?? undefined}
                  onPlay={handlePlay}
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
                    setSelectedIds(prev => {
                      const next = new Set(prev);
                      if (next.has(item.id)) {
                        next.delete(item.id);
                      } else {
                        next.add(item.id);
                      }
                      return next;
                    });
                  }}
                  onEnableSelectionMode={() => {
                    setIsSelectionMode(true);
                    setSelectedIds(new Set([item.id]));
                  }}
                  onBulkMoveClick={() => setShowBulkMoveScreen(true)}
                  onBulkDeleteClick={() => setShowBulkDeleteConfirm(true)}
                />
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 mt-6 pb-4">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="p-1 rounded hover:bg-gray-100 dark:hover:bg-[#33343a] disabled:opacity-30 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                </button>
                <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">
                  {page + 1} / {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="p-1 rounded hover:bg-gray-100 dark:hover:bg-[#33343a] disabled:opacity-30 transition-colors"
                >
                  <ChevronRight className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                </button>
              </div>
            )}
          </>
        )}
      </div>

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
});
