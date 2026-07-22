import React from "react";
import { useTranslation } from "react-i18next";
import {
  FolderPlus, Trash2, ArrowLeft, Loader2, Search, CheckSquare,
  Square, X, Check, FolderOutput,
} from "lucide-react";

interface ToolbarProps {
  isSelectionMode: boolean;
  selectedIds: Set<string>;
  filteredCount: number;
  hasHistory: boolean;
  folderHistory: { id: string; name: string }[];
  currentFolderName: string;
  searchQuery: string;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  sortOption: string;
  showSortMenu: boolean;
  isBulkOperating: boolean;
  token: string | null;
  onCancelSelection: () => void;
  onSelectAll: () => void;
  onSearchChange: (q: string) => void;
  onBack: () => void;
  onBreadcrumbClick: (id: string, name: string, index: number) => void;
  onSortChange?: (option: string) => void;
  onToggleSortMenu: () => void;
  onNewFolder: () => void;
  onBulkMove: () => void;
  onBulkDelete: () => void;
}

export function Toolbar({
  isSelectionMode,
  selectedIds,
  filteredCount,
  hasHistory,
  folderHistory,
  currentFolderName,
  searchQuery,
  searchInputRef,
  sortOption,
  showSortMenu,
  isBulkOperating,
  token,
  onCancelSelection,
  onSelectAll,
  onSearchChange,
  onBack,
  onBreadcrumbClick,
  onSortChange,
  onToggleSortMenu,
  onNewFolder,
  onBulkMove,
  onBulkDelete,
}: ToolbarProps) {
  const { t } = useTranslation();
  const isInitialMount = React.useRef(true);
  React.useEffect(() => { isInitialMount.current = false; }, []);

  const baseSortOption = sortOption.replace(' desc', '');
  const sortOptions = [
    { id: 'name', label: t('sort.name', 'A-Z') },
    { id: 'modifiedTime', label: t('sort.date', 'Ngày') },
    { id: 'size', label: t('sort.size', 'Kích thước') },
  ];
  const currentSortLabel = sortOptions.find(opt => opt.id === baseSortOption)?.label || t('drive.sort', 'Sort');

  return (
    <div className="sticky top-0 px-8 pt-8 pb-4 shrink-0 z-20 bg-white/95 dark:bg-[#121212]/95 shadow-[0_4px_20px_rgba(0,0,0,0.02)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.1)]">
      <div className="flex items-center justify-between">
        {isSelectionMode ? (
          <div className="flex items-center gap-2 text-sm font-medium animate-in fade-in slide-in-from-left-4 duration-300">
            <button onClick={onCancelSelection} className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors mr-2 shrink-0">
              <X className="w-5 h-5 text-gray-700 dark:text-gray-300" />
            </button>
            <span className="text-gray-900 dark:text-white px-2 py-1 font-semibold text-lg truncate">
              {t('drive.items_selected', '{{count}} mục đã chọn', { count: selectedIds.size })}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm font-medium">
            <button onClick={onBack} disabled={!hasHistory}
              className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent transition-colors mr-2 shrink-0">
              <ArrowLeft className="w-5 h-5 text-gray-700 dark:text-gray-300" />
            </button>
            {folderHistory.map((folder, index) => (
              <div key={folder.id} className="flex items-center">
                <span className="text-gray-400 mx-1">/</span>
                <button onClick={() => onBreadcrumbClick(folder.id, folder.name, index)}
                  className="text-gray-500 dark:text-gray-400 hover:text-[#4285F4] dark:hover:text-[#4285F4] hover:bg-[#4285F4]/5 px-2 py-1 rounded-md transition-colors truncate max-w-[150px]"
                  title={folder.name}>{folder.name}</button>
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
            <button onClick={onSelectAll}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-colors shadow-sm active:scale-95">
              {selectedIds.size === filteredCount ? <Square className="w-4 h-4" /> : <CheckSquare className="w-4 h-4" />}
              <span className="hidden sm:inline">{t('drive.select_all', 'Chọn tất cả')}</span>
            </button>
            <button onClick={onBulkMove} disabled={selectedIds.size === 0 || isBulkOperating}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-colors shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed">
              <FolderOutput className="w-4 h-4" />
              <span className="hidden sm:inline">{t('drive.bulk_move', 'Di chuyển')}</span>
            </button>
            <button onClick={onBulkDelete} disabled={selectedIds.size === 0 || isBulkOperating}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed">
              {isBulkOperating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              <span className="hidden sm:inline">{t('drive.delete', 'Xóa')}</span>
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 shrink-0">
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input ref={searchInputRef} type="text" placeholder={t('search_placeholder', 'Tìm kiếm...')}
                value={searchQuery} onChange={(e) => onSearchChange(e.target.value)}
                className="w-40 sm:w-56 pl-9 pr-3 py-1.5 text-sm font-medium bg-gray-100 dark:bg-[#1a1b1e] text-gray-900 dark:text-gray-100 rounded-lg outline-none focus:ring-2 focus:ring-[#4285F4]/50 border border-transparent focus:border-transparent transition-all placeholder:text-gray-400" />
              {searchQuery && (
                <button onClick={() => onSearchChange("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {token && (
              <div className="relative">
                <div onClick={onToggleSortMenu}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-all shadow-sm [&:active:not(:has(.arrow-btn:active))]:scale-95 cursor-pointer select-none">
                  <div className="arrow-btn p-1 -ml-1.5 rounded-md hover:bg-gray-200 dark:hover:bg-[#2e2f34] transition-transform active:scale-75 flex items-center justify-center"
                    onClick={(e) => { e.stopPropagation(); onSortChange?.(sortOption.endsWith(' desc') ? sortOption.replace(' desc', '') : sortOption + ' desc'); }}
                    title="Toggle Order">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 relative">
                      <style>{`@keyframes fillUp{from{clip-path:inset(100% 0 0 0)}to{clip-path:inset(0 0 0 0)}}@keyframes drainUp{from{clip-path:inset(0 0 0 0)}to{clip-path:inset(0 0 100% 0)}}@keyframes fillDown{from{clip-path:inset(0 0 100% 0)}to{clip-path:inset(0 0 0 0)}}@keyframes drainDown{from{clip-path:inset(0 0 0 0)}to{clip-path:inset(100% 0 0 0)}}.anim-fill-up{animation:fillUp 300ms ease-in-out forwards}.anim-drain-up{animation:drainUp 300ms ease-in-out forwards}.anim-fill-down{animation:fillDown 300ms ease-in-out forwards}.anim-drain-down{animation:drainDown 300ms ease-in-out forwards}`}</style>
                      <g className={`stroke-white ${isInitialMount.current ? (!sortOption.endsWith(' desc') ? 'opacity-0' : '') : (!sortOption.endsWith(' desc') ? 'anim-drain-up' : 'anim-fill-up')}`}><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/></g>
                      <g className={`stroke-[#4285F4] ${isInitialMount.current ? (!sortOption.endsWith(' desc') ? '' : 'opacity-0') : (!sortOption.endsWith(' desc') ? 'anim-fill-up' : 'anim-drain-up')}`}><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/></g>
                      <g className={`stroke-white ${isInitialMount.current ? (sortOption.endsWith(' desc') ? 'opacity-0' : '') : (sortOption.endsWith(' desc') ? 'anim-drain-down' : 'anim-fill-down')}`}><path d="m21 16-4 4-4-4"/><path d="M17 20V4"/></g>
                      <g className={`stroke-[#4285F4] ${isInitialMount.current ? (sortOption.endsWith(' desc') ? '' : 'opacity-0') : (sortOption.endsWith(' desc') ? 'anim-fill-down' : 'anim-drain-down')}`}><path d="m21 16-4 4-4-4"/><path d="M17 20V4"/></g>
                    </svg>
                  </div>
                  <div className="hidden sm:grid text-center pr-1">
                    <span className="col-start-1 row-start-1 visible place-self-center">{currentSortLabel}</span>
                    {sortOptions.map(opt => (<span key={opt.id} className="col-start-1 row-start-1 invisible pointer-events-none select-none" aria-hidden="true">{opt.label}</span>))}
                  </div>
                </div>
                {showSortMenu && (<>
                  <div className="fixed inset-0 z-40" onClick={onToggleSortMenu}></div>
                  <div className="absolute right-0 mt-2 w-32 bg-white dark:bg-[#1a1b1e] rounded-xl shadow-lg p-1.5 flex flex-col gap-0.5 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
                    {sortOptions.map((opt) => (
                      <button key={opt.id} onClick={() => { let newOpt = opt.id; if (opt.id === 'modifiedTime') newOpt = 'modifiedTime desc'; onSortChange?.(newOpt); onToggleSortMenu(); }}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 text-sm transition-colors rounded-md hover:bg-gray-50 dark:hover:bg-[#25262a] hover:text-[#4285F4] dark:hover:text-[#4285F4] ${baseSortOption === opt.id ? 'text-[#4285F4] font-medium' : 'text-gray-700 dark:text-gray-300'}`}>
                        {opt.label}{baseSortOption === opt.id && <Check className="w-4 h-4" />}
                      </button>
                    ))}
                  </div>
                </>)}
              </div>
            )}
            {token && (
              <button onClick={onNewFolder} className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-[#4285F4] hover:bg-[#3367d6] rounded-lg transition-colors shadow-sm active:scale-95">
                <FolderPlus className="w-4 h-4" /><span className="hidden sm:inline">{t('drive.new_folder') || 'New Folder'}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
