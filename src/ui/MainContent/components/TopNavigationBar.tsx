import React from 'react';
import { ArrowLeft, X, Search, FolderPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SortDropdown } from '../../components/SortDropdown';

interface TopNavigationBarProps {
  isSelectionMode: boolean;
  selectedCount: number;
  onClearSelection: () => void;
  onBack: () => void;
  hasHistory: boolean;
  folderHistory: { id: string, name: string }[];
  currentFolderName: string;
  onBreadcrumbClick: (id: string, name: string, index: number) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  sortOption: string;
  onSortChange?: (option: string) => void;
  token: string | null;
  onNewFolderClick: () => void;
  isInitialMount: React.MutableRefObject<boolean>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

export function TopNavigationBar({
  isSelectionMode,
  selectedCount,
  onClearSelection,
  onBack,
  hasHistory,
  folderHistory,
  currentFolderName,
  onBreadcrumbClick,
  searchQuery,
  onSearchChange,
  sortOption,
  onSortChange,
  token,
  onNewFolderClick,
  isInitialMount,
  searchInputRef
}: TopNavigationBarProps) {
  const { t } = useTranslation();

  const sortOptions = [
    { id: 'name', label: t('sort.name', 'A-Z') },
    { id: 'modifiedTime', label: t('sort.date', 'Ngày'), defaultDesc: true },
    { id: 'size', label: t('sort.size', 'Kích thước') },
  ];

  return (
    <div className="flex items-center justify-between gap-4">
      {isSelectionMode ? (
        <div className="flex items-center gap-2 text-sm font-medium animate-in fade-in slide-in-from-left-4 duration-300 flex-1 min-w-0">
          <button
            onClick={onClearSelection}
            className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors mr-2 shrink-0"
          >
            <X className="w-5 h-5 text-gray-700 dark:text-gray-300" />
          </button>
          <span className="text-gray-900 dark:text-white px-2 py-1 font-semibold text-lg truncate">
            {t('drive.items_selected', '{{count}} mục đã chọn', { count: selectedCount })}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm font-medium flex-1 min-w-0">
          <button 
            onClick={onBack}
            disabled={!hasHistory}
            className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent transition-colors shrink-0"
          >
            <ArrowLeft className="w-5 h-5 text-gray-700 dark:text-gray-300" />
          </button>
          
          <div className="flex items-center overflow-x-auto whitespace-nowrap hide-scrollbar flex-1 min-w-0">
            {folderHistory.map((folder, index) => (
              <div key={folder.id} className="flex items-center shrink-0">
                <span className="text-gray-400 mx-1">/</span>
                <button 
                  onClick={() => onBreadcrumbClick(folder.id, folder.name, index)}
                  className="text-gray-500 dark:text-gray-400 hover:text-[#4285F4] transition-colors truncate max-w-[150px]"
                  title={folder.name}
                >
                  {folder.name}
                </button>
              </div>
            ))}
            <div className="flex items-center shrink-0">
              {folderHistory.length > 0 && <span className="text-gray-400 mx-1">/</span>}
              <span className="text-gray-900 dark:text-white px-2 py-1 font-semibold truncate max-w-[200px]" title={currentFolderName}>
                {currentFolderName}
              </span>
            </div>
          </div>
        </div>
      )}

      {!isSelectionMode && (
        <div className="flex items-center gap-3 shrink-0">
          {/* Search Input */}
          <div className="relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t('search_placeholder', 'Tìm kiếm...')}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-40 sm:w-56 pl-9 pr-3 py-1.5 text-sm font-medium bg-gray-100 dark:bg-[#1a1b1e] text-gray-900 dark:text-gray-100 rounded-lg outline-none focus:ring-2 focus:ring-[#4285F4]/50 border border-transparent focus:border-transparent transition-all placeholder:text-gray-400"
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Sort Dropdown */}
          {token && (
            <SortDropdown
              sortOption={sortOption}
              onSortChange={onSortChange}
              options={sortOptions}
              fallbackLabel={t('drive.sort', 'Sort')}
              isInitialMount={isInitialMount}
            />
          )}

          {token && (
            <button 
              onClick={onNewFolderClick}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-[#4285F4] hover:bg-[#3367d6] rounded-lg transition-colors shadow-sm active:scale-95"
            >
              <FolderPlus className="w-4 h-4" />
              <span className="hidden sm:inline">{t('drive.new_folder') || 'New Folder'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
