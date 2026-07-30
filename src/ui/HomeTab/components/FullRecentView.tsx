import { useState, useMemo, useRef, useEffect } from 'react';
import { Track } from '../../../App';
import { useTranslation } from 'react-i18next';
import { prefetchVisibleTracks } from '../../../utils/streamPrefetcher';
import { ArrowLeft, Search, ArrowUpDown, X, Check } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SongCard } from '../../MainContent/components/SongCard';

export function FullRecentView({ recent, onBack, onPlay, token }: { recent: Track[], onBack: () => void, onPlay: (track: Track, ctx: Track[]) => void, token: string | null }) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOption, setSortOption] = useState('recent');
  const [showSortMenu, setShowSortMenu] = useState(false);

  useEffect(() => {
    const ids = recent.map(t => t.id).filter(Boolean);
    if (ids.length > 0) prefetchVisibleTracks(ids);
  }, [recent]);
  
  const filteredItems = useMemo(() => {
    let items = [...recent].filter(item => 
      item.title.toLowerCase().includes(searchQuery.toLowerCase())
    );
    if (sortOption === 'recent_asc') {
      items.reverse();
    } else if (sortOption === 'name') {
      items.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sortOption === 'name desc') {
      items.sort((a, b) => b.title.localeCompare(a.title));
    }
    return items;
  }, [recent, searchQuery, sortOption]);

  const sortOptions = [
    { id: 'name', label: t('sort.name_asc', 'Tên (A-Z)') },
    { id: 'name desc', label: t('sort.name_desc', 'Tên (Z-A)') },
    { id: 'recent', label: t('sort.modified_desc', 'Mới nhất') },
    { id: 'recent_asc', label: t('sort.modified_asc', 'Cũ nhất') },
  ];
  const currentSortLabel = sortOptions.find(opt => opt.id === sortOption)?.label || 'Sort';

  const rowVirtualizer = useVirtualizer({
    count: filteredItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 92,
    overscan: 3,
  });

  return (
    <main className="flex-1 bg-white dark:bg-[#121212] overflow-hidden flex flex-col relative transition-colors duration-300 h-full">
      <div className="sticky top-0 px-8 pt-8 pb-4 shrink-0 z-20 bg-white/95 dark:bg-[#121212]/95 backdrop-blur-md shadow-[0_4px_20px_rgba(0,0,0,0.02)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.1)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <button 
              onClick={onBack}
              className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors mr-2 shrink-0"
            >
              <ArrowLeft className="w-5 h-5 text-gray-700 dark:text-gray-300" />
            </button>
            <div className="flex items-center gap-3">
              <span className="text-gray-900 dark:text-white px-2 py-1 font-semibold truncate max-w-[200px]" title="Recent Files">
                Recent Files
              </span>
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-[#202124] px-2.5 py-0.5 rounded-full">
                {filteredItems.length}
              </span>
            </div>
          </div>
          
          <div className="flex items-center gap-3 shrink-0">
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
                          setSortOption(opt.id);
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
          </div>
        </div>
      </div>
      
      <div ref={parentRef} className="flex-1 overflow-y-auto px-8 pt-4 pb-24 min-h-0 custom-scrollbar">
        <div className="flex flex-col relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const track = filteredItems[virtualRow.index];
            const driveItem = {
              id: track.id,
              title: track.title,
              isFolder: false,
              size: track.size,
              trackInfo: track
            };
            return (
              <div
                key={virtualRow.key}
                style={{
                  position: 'absolute',
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="pb-2"
              >
                <SongCard
                  item={driveItem as any}
                  onPlay={(t) => onPlay(t, filteredItems)}
                  onOpenFolder={() => {}}
                  token={token}
                  currentFolderId="recent"
                  currentFolderName="Recent"
                  folderHistory={[]}
                  onRefresh={() => {}}
                  hideMenu={true}
                />
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
