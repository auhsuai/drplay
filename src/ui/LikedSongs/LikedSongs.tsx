import React, { useEffect, useState, useRef } from 'react';
import { Play, Heart, Music } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Track } from '../../App';
import { getFavorites, removeFavorite } from '../../utils/favorites';
import { getTrackMetadata } from '../../utils/metadata';
import { showErrorToast } from '../../utils/simpleToast';
import { MoreMenu } from '../components/MoreMenu';
import { prefetchVisibleTracks } from '../../utils/streamPrefetcher';


interface LikedSongsProps {
  onPlay: (track: Track, context: Track[], startIndex?: number) => void;
  token: string | null;
  currentTrack?: Track | null;
}

export function LikedSongs({ onPlay, token, currentTrack }: LikedSongsProps) {
  const { t } = useTranslation();
  const [favorites, setFavorites] = useState<Track[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});

  useEffect(() => {
    loadFavorites().catch(err => console.error('[LikedSongs] Failed to load favorites', err));
    
    const handleUpdate = () => { loadFavorites().catch(err => console.error('[LikedSongs] Failed to load favorites', err)); };
    window.addEventListener('favorites-updated', handleUpdate);
    window.addEventListener('user-changed', handleUpdate);
    return () => {
      window.removeEventListener('favorites-updated', handleUpdate);
      window.removeEventListener('user-changed', handleUpdate);
    };
  }, []);

  const loadFavorites = async () => {
    try {
      const favs = await getFavorites();
      setFavorites(favs);
    } catch (e) {
      console.error("[LikedSongs] Failed to load favorites", e);
    }
  };

  useEffect(() => {
    const ids = favorites.map(t => t.id).filter(Boolean);
    if (ids.length > 0) prefetchVisibleTracks(ids);
  }, [favorites]);

  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const controller = new AbortController();
    
    // Load metadata/covers for favorites. Process in small batches of
    // COVER_CONCURRENCY so a large playlist doesn't spawn hundreds of Drive
    // requests at once (was: unlimited parallel via forEach).
    const COVER_CONCURRENCY = 5;
    const tracksToLoad = favorites.filter(track => !covers[track.id]);

    const loadBatch = async (batch: Track[]) => {
      await Promise.all(batch.map(track =>
        getTrackMetadata(track.id, token, track.size, track.originalName, controller.signal).then(metadata => {
          if (cancelled) return;
          if (metadata.coverUrl) {
            setCovers(prev => ({
              ...prev,
              [track.id]: metadata.coverUrl!
            }));
          } else if (metadata.pictureData && metadata.pictureFormat) {
            const blob = new Blob([new Uint8Array(metadata.pictureData)], { type: metadata.pictureFormat });
            const url = URL.createObjectURL(blob);
            if (cancelled) { URL.revokeObjectURL(url); return; }
            blobUrlsRef.current.push(url);
            setCovers(prev => ({
              ...prev,
              [track.id]: url
            }));
          }
        }).catch(err => console.warn('[LikedSongs] Failed to load cover metadata for track', track.id, err))
      ));
    };

    const run = async () => {
      for (let i = 0; i < tracksToLoad.length && !cancelled; i += COVER_CONCURRENCY) {
        await loadBatch(tracksToLoad.slice(i, i + COVER_CONCURRENCY));
      }
    };
    run().catch(err => console.error('[LikedSongs] Failed to load covers', err));

    return () => {
      cancelled = true;
      controller.abort();
      blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];
    };
  }, [favorites, token]);

  const handleUnlike = async (e: React.MouseEvent, trackId: string) => {
    e.stopPropagation();
    try {
      await removeFavorite(trackId);
    } catch (e) {
      showErrorToast(t('liked_songs.remove_failed') || 'Không thể xóa khỏi yêu thích, vui lòng thử lại.');
      console.error('[LikedSongs] Failed to remove favorite', trackId, e);
    }
  };

  return (
    <main className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto flex flex-col relative transition-colors duration-300">
      {/* Header Gradient */}
      <div className="h-64 bg-gradient-to-b from-[#5c4cf4] to-white dark:to-[#121212] flex items-end p-8 flex-shrink-0">
        <div className="flex items-end gap-6">
          <div className="w-48 h-48 bg-gradient-to-br from-[#4b3cce] to-[#8f82f7] shadow-2xl flex items-center justify-center text-white rounded-md">
            <Heart className="w-20 h-20" fill="currentColor" />
          </div>
          <div className="text-white dark:text-gray-100 mb-2">
            <p className="text-sm font-medium uppercase tracking-wider mb-2">{t('playlist_name')}</p>
            <h1 className="text-6xl font-bold mb-4 tracking-tight">{t('liked_songs.title')}</h1>
            <p className="text-sm font-medium opacity-80">
              {favorites.length} {favorites.length === 1 ? t('song') : t('songs')}
            </p>
          </div>
        </div>
      </div>

      {/* Action Bar */}
      <div className="px-8 py-6">
        <button 
          onClick={() => favorites.length > 0 && onPlay(favorites[0], favorites, 0)}
          className="w-14 h-14 bg-[#4285F4] hover:bg-blue-600 rounded-full flex items-center justify-center text-white shadow-lg transition-transform hover:scale-105 active:scale-95 disabled:opacity-50"
          disabled={favorites.length === 0}
        >
          <Play className="w-6 h-6 ml-1" fill="currentColor" />
        </button>
      </div>

      {/* Track List */}
      <div className="px-8 pb-24">
        {favorites.length === 0 ? (
          <div className="text-gray-500 dark:text-gray-400 text-center py-20">
            <Music className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <h3 className="text-xl font-medium mb-2">{t('liked_songs.empty_title')}</h3>
            <p className="text-sm">{t('liked_songs.empty_subtitle')}</p>
          </div>
        ) : (
          <div className="w-full">
            <div className="flex text-gray-500 text-[11px] pb-2 mb-2 px-2 uppercase tracking-widest font-bold">
              <div className="w-12 text-center">#</div>
              <div className="flex-1">{t('title')}</div>
              <div className="w-12"></div>
            </div>
            
            <div className="space-y-1">
              {favorites.map((track, index) => (
                <div 
                  key={track.id}
                  onClick={() => onPlay(track, favorites, index)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    window.dispatchEvent(new CustomEvent('locate-file', {
                      detail: { 
                        fileId: track.id,
                        parentId: track.parentId,
                        parentName: track.parentName
                      }
                    }));
                  }}
                  className={`flex items-center gap-4 p-2 rounded-lg group cursor-pointer transition-all active:scale-[0.99] ${
                    currentTrack?.id === track.id 
                      ? 'bg-gray-100 dark:bg-[#2A2A2A]' 
                      : 'hover:bg-gray-100 dark:hover:bg-[#2A2A2A]'
                  }`}
                >
                  <div className={`w-12 text-center text-sm ${currentTrack?.id === track.id ? 'text-[#4285F4] hidden group-hover:block' : 'text-gray-400 group-hover:hidden'}`}>
                    {currentTrack?.id === track.id ? <Music className="w-4 h-4 mx-auto" /> : index + 1}
                  </div>
                  <div className={`w-12 text-center items-center justify-center ${currentTrack?.id === track.id ? 'flex group-hover:hidden' : 'hidden group-hover:flex'}`}>
                    <Play className={`w-4 h-4 ${currentTrack?.id === track.id ? 'text-[#4285F4]' : 'text-gray-900 dark:text-white'}`} fill="currentColor" />
                  </div>
                  
                  <div className={`w-10 h-10 rounded-md flex items-center justify-center shrink-0 overflow-hidden ${currentTrack?.id === track.id ? 'bg-[#4285F4]/10 text-[#4285F4]' : 'bg-gray-200 dark:bg-gray-800'}`}>
                    {covers[track.id] ? (
                      <img src={covers[track.id]} alt="cover" loading="lazy" decoding="async" onError={() => setCovers((c) => { const n = { ...c }; delete n[track.id]; return n; })} className="w-full h-full object-cover" />
                    ) : (
                      <Music className={`w-5 h-5 ${currentTrack?.id === track.id ? 'text-[#4285F4]' : 'text-gray-400'}`} />
                    )}
                  </div>
                  
                  <div className="flex-1 min-w-0 flex flex-col justify-center">
                    <h4 className={`text-[15px] font-semibold truncate transition-colors leading-tight mb-0.5 ${currentTrack?.id === track.id ? 'text-[#4285F4]' : 'text-gray-900 dark:text-white group-hover:text-[#4285F4]'}`}>
                      {track.title}
                    </h4>
                    <p className="text-[13px] text-gray-500 truncate leading-tight">
                      {track.artist || t('unknown_artist')}
                    </p>
                  </div>
                  
                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={(e) => handleUnlike(e, track.id)}
                      className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-all text-[#4285F4] hover:scale-110"
                      title={t('menu.remove_from_liked')}
                    >
                      <Heart className="w-4 h-4" fill="currentColor" />
                    </button>
                    <MoreMenu track={track} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
