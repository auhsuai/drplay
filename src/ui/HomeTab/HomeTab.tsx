import { useEffect, useState, useRef, useMemo } from "react";
import { Track } from "../../App";
import { getTrackMetadata } from "../../utils/metadata";
import { getRecentlyPlayed, getHeavyRotation, getRandomDiscoveries, getMostVisitedFolders, FolderVisitEntry } from "../../utils/history";
import { getRecentlyAddedAudioFiles } from "../../utils/driveApi";
import { prefetchVisibleTracks } from "../../utils/streamPrefetcher";
import { Play, Music, Clock, Sparkles, ArrowLeft, MoreHorizontal, Search, ArrowUpDown, X, Check, Folder, Repeat, PlusCircle } from "lucide-react";
import greetingsData from "../../data/greetings.json";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SongCard } from "../MainContent/components/SongCard";

const GOOGLE_COLORS = ['#4285F4', '#EA4335', '#FBBC05', '#34A853'];

const getFillColor = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return GOOGLE_COLORS[Math.abs(hash) % GOOGLE_COLORS.length];
};

export function HomeTab({ onPlay, onOpenFolder, token, userProfile }: { 
  onPlay: (track: Track, contextQueue?: Track[]) => void, 
  onOpenFolder: (id: string, name: string) => void,
  token: string | null, 
  userProfile?: any 
}) {
  const { t, i18n } = useTranslation();
  const [recent, setRecent] = useState<Track[]>([]);
  const [heavy, setHeavy] = useState<Track[]>([]);
  const [discover, setDiscover] = useState<Track[]>([]);
  const [mostVisitedFolders, setMostVisitedFolders] = useState<FolderVisitEntry[]>([]);
  const [recentlyAdded, setRecentlyAdded] = useState<Track[]>([]);
  const [showFullRecent, setShowFullRecent] = useState(false);

  const { greeting, subtitle } = useMemo(() => {
    const hour = new Date().getHours();
    let timeKey: 'morning' | 'afternoon' | 'evening';
    let greetingText = '';
    
    if (hour < 12) {
      timeKey = 'morning';
      greetingText = t('home.good_morning', 'Good morning');
    } else if (hour < 18) {
      timeKey = 'afternoon';
      greetingText = t('home.good_afternoon', 'Good afternoon');
    } else {
      timeKey = 'evening';
      greetingText = t('home.good_evening', 'Good evening');
    }

    const visitCount = parseInt(sessionStorage.getItem('drplay_home_visit') || '0', 10);
    // Cycle: Time-specific -> General -> General -> Time-specific ...
    const isTimeSpecific = visitCount % 3 === 0;

    let possibleSubtitles = [];
    if (isTimeSpecific) {
      possibleSubtitles = (greetingsData as any)[timeKey];
    } else {
      possibleSubtitles = (greetingsData as any)['general'];
    }

    const randomObj = possibleSubtitles[Math.floor(Math.random() * possibleSubtitles.length)];
    const lang = i18n.language?.startsWith('vi') ? 'vi' : 'en';
    const randomSubtitle = randomObj[lang] || randomObj['en'];

    return { greeting: greetingText, subtitle: randomSubtitle };
  }, [t, i18n.language]);

  useEffect(() => {
    const visitCount = parseInt(sessionStorage.getItem('drplay_home_visit') || '0', 10);
    sessionStorage.setItem('drplay_home_visit', (visitCount + 1).toString());

    const loadData = async () => {
      setRecent(await getRecentlyPlayed());
      setHeavy(await getHeavyRotation());
      setDiscover(await getRandomDiscoveries());
      setMostVisitedFolders(await getMostVisitedFolders());

      if (token) {
        getRecentlyAddedAudioFiles(token).then(files => {
          const tracks = files.map(f => ({
            id: f.id,
            title: f.name,
            artist: "",
            streamUrl: "",
            originalName: f.name,
            size: f.size
          }));
          setRecentlyAdded(tracks);
        }).catch(err => console.warn('[HomeTab] Failed to load recently-added files from Drive', err));
      }
    };
    loadData().catch(err => console.error('[HomeTab] Failed to load home tab data', err));

    const handleUpdate = () => { loadData().catch(err => console.error('[HomeTab] Failed to load home tab data', err)); };
    window.addEventListener('recent-updated', handleUpdate);
    return () => window.removeEventListener('recent-updated', handleUpdate);
  }, []);

  useEffect(() => {
    const tracks = [...recent, ...heavy, ...discover, ...recentlyAdded];
    const ids = tracks.map(t => t.id).filter(Boolean);
    if (ids.length > 0) prefetchVisibleTracks(ids);
  }, [recent, heavy, discover, recentlyAdded]);

  if (showFullRecent) {
    return <FullRecentView recent={recent} onBack={() => setShowFullRecent(false)} onPlay={onPlay} token={token} />;
  }

  const quickAccess = recent.slice(0, 5);
  const discoverItems = discover.length > 0 ? discover : [];
  const heavyItems = heavy.length > 0 ? heavy.slice(0, 5) : [];

  return (
    <main className="flex-1 bg-white dark:bg-[#0A0A0A] overflow-y-auto custom-scrollbar transition-colors duration-300">
      <div className="max-w-6xl mx-auto p-8 pb-32">
        <header className="mb-10 mt-4 flex flex-col gap-1">
           <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
             {greeting}{userProfile?.name ? `, ${userProfile.name.split(' ')[0]}` : ''}
           </h2>
           <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
             {subtitle}
           </p>
        </header>
        
        {/* QUICK ACCESS: Sleek List View */}
        {quickAccess.length > 0 && (
          <div className="mb-12">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-2">
                <Clock className="w-4 h-4" />
                Recent Files
              </h3>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
              {quickAccess.map((track, index) => {
                const isOverlay = index === 4 && recent.length > 4;
                return (
                  <PremiumCard 
                    key={track.id} 
                    track={track} 
                    onPlay={() => isOverlay ? setShowFullRecent(true) : onPlay(track, quickAccess)} 
                    token={token} 
                    isOverlayBtn={isOverlay}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* RECENTLY ADDED TO DRIVE */}
        {recentlyAdded.length > 0 && (
          <div className="mb-12">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
              <PlusCircle className="w-4 h-4" />
              Recently Added to Drive
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
              {recentlyAdded.slice(0, 5).map(track => (
                <PremiumCard key={track.id} track={track} onPlay={() => onPlay(track, recentlyAdded)} token={token} />
              ))}
            </div>
          </div>
        )}

        {/* JUMP BACK IN: Most Visited Folders */}
        {mostVisitedFolders.length > 0 && (
          <div className="mb-12">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
              <Folder className="w-4 h-4" />
              Jump Back In
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {mostVisitedFolders.map(folder => (
                <div 
                  key={folder.id}
                  onClick={() => onOpenFolder(folder.id, folder.name)}
                  className="p-3.5 rounded-2xl transition-all duration-300 cursor-pointer flex items-center gap-4 active:scale-[0.98] group w-full bg-[#F8F9FA] dark:bg-[#202124] hover:bg-white dark:hover:bg-[#2a2b2f] hover:shadow-lg hover:shadow-black/5 hover:-translate-y-1"
                >
                  <div className="relative w-12 h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors bg-amber-100 dark:bg-amber-900/30 text-amber-500">
                    <Folder className="w-6 h-6" fill="currentColor" />
                  </div>
                  <div className="overflow-hidden flex-1 flex flex-col justify-center">
                    <h3 className="font-semibold text-[15px] transition-colors truncate leading-tight mb-0.5 text-gray-800 dark:text-gray-200 group-hover:text-[#4285F4]">
                      {folder.name}
                    </h3>
                    <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-gray-400 mt-0.5 min-w-0">
                      <span className="truncate">{t('drive.folders', 'Folders')}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* HEAVY ROTATION */}
        {heavyItems.length > 0 && (
          <div className="mb-12">
             <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
              <Repeat className="w-4 h-4" />
              Heavy Rotation
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
              {heavyItems.map(track => (
                <PremiumCard key={track.id} track={track} onPlay={() => onPlay(track, heavyItems)} token={token} />
              ))}
            </div>
          </div>
        )}

        {/* DISCOVER: Premium Cards */}
        {discoverItems.length > 0 && (
          <div className="mb-12">
             <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              {t('home.discover')}
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
              {discoverItems.map(track => (
                <PremiumCard key={track.id} track={track} onPlay={() => onPlay(track, discoverItems)} token={token} />
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}



function PremiumCard({ track, onPlay, token, isOverlayBtn }: { track: Track, onPlay: () => void, token: string | null, isOverlayBtn?: boolean }) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const fillColor = getFillColor(track.id);
  const { t } = useTranslation();
  
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let isMounted = true;
    let objectUrl: string | null = null;
    getTrackMetadata(track.id, token, track.size, track.originalName, controller.signal).then(meta => {
      if (!isMounted) return;
      if (meta.title) setTitle(meta.title);
      if (meta.artist) setArtist(meta.artist);
      if (meta.coverUrl) {
        setCoverUrl(meta.coverUrl);
      } else if (meta.pictureData && meta.pictureFormat) {
        const blob = new Blob([new Uint8Array(meta.pictureData)], { type: meta.pictureFormat });
        objectUrl = URL.createObjectURL(blob);
        setCoverUrl(objectUrl);
      }
    }).catch(err => console.warn('[HomeTab] Failed to load cover metadata for track', track.id, err));
    return () => { 
      isMounted = false; 
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [track.id, token]);
  
  return (
    <div 
      onClick={onPlay}
      className="group cursor-pointer active:scale-[0.98] transition-transform duration-200"
    >
      <div 
        className="w-full aspect-square rounded-2xl mb-4 relative overflow-hidden flex items-center justify-center shadow-sm"
        style={!coverUrl ? { background: fillColor } : undefined}
      >
        {coverUrl ? (
          <img src={coverUrl} loading="lazy" decoding="async" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" />
        ) : (
          <Music className="w-12 h-12 text-white/90 group-hover:scale-110 transition-transform duration-700" />
        )}
        
        {isOverlayBtn ? (
          <div className="absolute inset-0 bg-white/70 dark:bg-black/70 flex items-center justify-center opacity-80 group-hover:opacity-100 transition-opacity">
            <span className="font-bold text-gray-900 dark:text-white text-[15px] flex items-center gap-1">
              <MoreHorizontal className="w-5 h-5" /> {t('view_all', 'View All')}
            </span>
          </div>
        ) : (
          <div className="absolute bottom-3 right-3 w-11 h-11 bg-[#4285F4] hover:bg-[#3367d6] text-white rounded-full flex items-center justify-center shadow-lg shadow-black/20 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-300 hover:scale-105">
            <Play className="w-5 h-5 ml-1" fill="currentColor" />
          </div>
        )}
      </div>
      {!isOverlayBtn && (
        <div className="px-1">
          <h4 className="font-semibold text-gray-900 dark:text-gray-100 truncate text-sm mb-1">{title}</h4>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{artist || t('unknown_artist', 'Unknown Artist')}</p>
        </div>
      )}
    </div>
  );
}

function FullRecentView({ recent, onBack, onPlay, token }: { recent: Track[], onBack: () => void, onPlay: (track: Track, ctx: Track[]) => void, token: string | null }) {
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
    overscan: 10,
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
                  top: 0,
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
