import { useState, useEffect } from 'react';
import { Track } from '../../../App';
import { getTrackMetadata } from '../../../utils/metadata';
import { Play, Music, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const GOOGLE_COLORS = ['#4285F4', '#EA4335', '#FBBC05', '#34A853'];
export const getFillColor = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return GOOGLE_COLORS[Math.abs(hash) % GOOGLE_COLORS.length];
};

export function PremiumCard({ track, onPlay, token, isOverlayBtn }: { track: Track, onPlay: () => void, token: string | null, isOverlayBtn?: boolean }) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const fillColor = getFillColor(track.id);
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
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
        style={!coverUrl ? { background: fillColor } : undefined}
        className="w-full aspect-square rounded-2xl mb-4 relative overflow-hidden flex items-center justify-center shadow-sm"
      >
        {coverUrl ? (
          <img src={coverUrl} loading="lazy" decoding="async" onError={() => setCoverUrl(null)} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" />
        ) : (
          <Music className="w-12 h-12 text-white opacity-80 group-hover:scale-110 transition-transform duration-700" />
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
