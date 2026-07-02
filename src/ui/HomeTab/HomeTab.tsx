import { useEffect, useState } from "react";
import { Track } from "../../App";
import { getTrackMetadata } from "../../utils/metadata";
import { getRecentlyPlayed, getHeavyRotation, getRandomDiscoveries } from "../../utils/history";
import { Play, Music, Clock, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

const GOOGLE_COLORS = ['#4285F4', '#EA4335', '#FBBC05', '#34A853'];

const getFillColor = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return GOOGLE_COLORS[Math.abs(hash) % GOOGLE_COLORS.length];
};

export function HomeTab({ onPlay, token }: { onPlay: (track: Track, contextQueue?: Track[]) => void, token: string | null }) {
  const { t } = useTranslation();
  const [recent, setRecent] = useState<Track[]>([]);
  const [heavy, setHeavy] = useState<Track[]>([]);
  const [discover, setDiscover] = useState<Track[]>([]);

  useEffect(() => {
    const loadData = async () => {
      setRecent(await getRecentlyPlayed());
      setHeavy(await getHeavyRotation());
      setDiscover(await getRandomDiscoveries());
    };
    loadData();
  }, []);

  const quickAccess = recent.slice(0, 6);
  // For diversity, if discover is empty, use heavy
  const discoverItems = discover.length > 0 ? discover : heavy;

  return (
    <main className="flex-1 bg-white dark:bg-[#0A0A0A] overflow-y-auto custom-scrollbar transition-colors duration-300">
      <div className="max-w-6xl mx-auto p-8 pb-32">
        <header className="mb-10 mt-4 flex items-center justify-between">
           <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
             {t('home.good_morning')}
           </h2>
        </header>
        
        {/* QUICK ACCESS: Sleek List View */}
        {quickAccess.length > 0 && (
          <div className="mb-12">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Recent Files
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {quickAccess.map(track => (
                <ListCard key={track.id} track={track} onPlay={() => onPlay(track, quickAccess)} token={token} />
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

function ListCard({ track, onPlay, token }: { track: Track, onPlay: () => void, token: string | null }) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [title, setTitle] = useState(track.title);
  const fillColor = getFillColor(track.id);
  
  useEffect(() => {
    if (!token) return;
    let isMounted = true;
    getTrackMetadata(track.id, token, track.size, track.originalName).then(meta => {
      if (!isMounted) return;
      if (meta.title) setTitle(meta.title);
      if (meta.coverUrl) {
        setCoverUrl(meta.coverUrl);
      } else if (meta.pictureData && meta.pictureFormat) {
        const blob = new Blob([new Uint8Array(meta.pictureData)], { type: meta.pictureFormat });
        setCoverUrl(URL.createObjectURL(blob));
      }
    });
    return () => { isMounted = false; };
  }, [track.id, token]);
  
  return (
    <div 
      onClick={onPlay}
      className="group flex items-center gap-4 p-3 rounded-xl hover:bg-gray-100 dark:hover:bg-[#1A1A1A] cursor-pointer transition-colors duration-200 active:scale-[0.98]"
    >
      <div 
        className="w-14 h-14 rounded-lg shrink-0 overflow-hidden flex items-center justify-center relative shadow-sm"
        style={!coverUrl ? { background: fillColor } : undefined}
      >
        {coverUrl ? <img src={coverUrl.startsWith('http://127') ? coverUrl + '&thumb=true' : coverUrl} loading="lazy" decoding="async" className="w-full h-full object-cover" /> : <Music className="w-6 h-6 text-white/90" />}
        <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
           <Play className="w-5 h-5 text-white ml-1" fill="currentColor" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-gray-900 dark:text-gray-100 truncate text-sm">{title}</p>
      </div>
    </div>
  );
}

function PremiumCard({ track, onPlay, token }: { track: Track, onPlay: () => void, token: string | null }) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const fillColor = getFillColor(track.id);
  
  useEffect(() => {
    if (!token) return;
    let isMounted = true;
    getTrackMetadata(track.id, token, track.size, track.originalName).then(meta => {
      if (!isMounted) return;
      if (meta.title) setTitle(meta.title);
      if (meta.artist) setArtist(meta.artist);
      if (meta.coverUrl) {
        setCoverUrl(meta.coverUrl);
      } else if (meta.pictureData && meta.pictureFormat) {
        const blob = new Blob([new Uint8Array(meta.pictureData)], { type: meta.pictureFormat });
        setCoverUrl(URL.createObjectURL(blob));
      }
    });
    return () => { isMounted = false; };
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
          <img src={coverUrl.startsWith('http://127') ? coverUrl + '&thumb=true' : coverUrl} loading="lazy" decoding="async" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" />
        ) : (
          <Music className="w-12 h-12 text-white/90 group-hover:scale-110 transition-transform duration-700" />
        )}
        <div className="absolute bottom-3 right-3 w-11 h-11 bg-black dark:bg-white text-white dark:text-black rounded-full flex items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-300">
          <Play className="w-5 h-5 ml-1" fill="currentColor" />
        </div>
      </div>
      <div className="px-1">
        <h4 className="font-semibold text-gray-900 dark:text-gray-100 truncate text-sm mb-1">{title}</h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{artist || "Unknown Artist"}</p>
      </div>
    </div>
  );
}
