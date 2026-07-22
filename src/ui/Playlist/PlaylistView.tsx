import React, { useState, useEffect, useRef } from "react";
import { Track } from "../../App";
import { Music, Play, X, Trash2, Camera } from "lucide-react";
import { getPlaylistById, removeTrackFromPlaylist, deletePlaylist, updatePlaylist, Playlist } from "../../utils/playlists";
import { ImageCropperModal } from "../components/ImageCropperModal";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { showErrorToast } from "../../utils/simpleToast";
import { prefetchVisibleTracks } from "../../utils/streamPrefetcher";


interface PlaylistViewProps {
  playlistId: string;
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  onDelete: () => void;
  currentTrack?: Track | null;
}

export function PlaylistView({ playlistId, onPlay, onDelete, currentTrack }: PlaylistViewProps) {
  const { t } = useTranslation();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isCropperOpen, setIsCropperOpen] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // `cancelled` is scoped to THIS effect instance (i.e. this specific
    // playlistId). If playlistId changes before an in-flight
    // getPlaylistById(oldId) resolves, that stale response must not
    // overwrite the new playlist's data -- and since `loadPlaylist` here
    // is also used as the 'playlists-updated'/'user-changed' listener (not
    // just the initial call), any invocation of THIS closure after
    // teardown (old event, arriving late) is guarded the same way.
    let cancelled = false;
    const loadPlaylist = async () => {
      try {
        const data = await getPlaylistById(playlistId);
        if (cancelled) return;
        setPlaylist(data);
      } catch (e) {
        if (cancelled) return;
        console.error("[PlaylistView] Failed to load playlist", e);
        showErrorToast(t('playlist.load_error') || "Failed to load playlist");
      }
    };
    loadPlaylist();
    window.addEventListener('playlists-updated', loadPlaylist);
    window.addEventListener('user-changed', loadPlaylist);
    return () => {
      cancelled = true;
      window.removeEventListener('playlists-updated', loadPlaylist);
      window.removeEventListener('user-changed', loadPlaylist);
    };
  }, [playlistId]);

  useEffect(() => {
    if (!playlist) return;
    const ids = playlist.tracks.map(t => t.id).filter(Boolean);
    if (ids.length > 0) prefetchVisibleTracks(ids);
  }, [playlist?.tracks]);

  const tracks = playlist?.tracks ?? [];

  const rowVirtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 3,
    // Fixed-height rows positioned via the `transform` computed below from
    // `virtualRow.start` -- no `measureElement` ref here, so this doesn't
    // get the full containerRef/elementsCache rewiring (see HomeTab.tsx for
    // the fuller rationale). `directDomUpdates` still gates `rerender()` to
    // only fire when the visible index range changes, which is a real win
    // on its own and doesn't touch item positioning.
    directDomUpdates: true,
  });

  if (!playlist) return null;

  const handleRemove = async (e: React.MouseEvent, trackId: string) => {
    e.stopPropagation();
    try {
      await removeTrackFromPlaylist(playlistId, trackId);
    } catch (err) {
      console.error("[PlaylistView] remove: Failed to remove track from playlist", err);
      showErrorToast(t('playlist.remove_error') || "Failed to remove track");
    }
  };

  const handleDelete = async () => {
    if (window.confirm(t("confirm_delete_playlist"))) {
      try {
        await deletePlaylist(playlistId);
        onDelete(); // Triggers tab change in App
      } catch (err) {
        console.error("[PlaylistView] delete: Failed to delete playlist", err);
        showErrorToast(t('playlist.delete_error') || "Failed to delete playlist");
      }
    }
  };

  const MAX_COVER_BYTES = 5 * 1024 * 1024;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      showErrorToast(t('playlist.cover_invalid_type') || "Please choose an image file");
      return;
    }
    if (file.size > MAX_COVER_BYTES) {
      showErrorToast(t('playlist.cover_too_large') || "Image must be 5 MB or smaller");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      setSelectedImage(event.target?.result as string);
      setIsCropperOpen(true);
    };
    reader.onerror = () => {
      console.error("[PlaylistView] FileReader failed to read cover image", { name: file.name, size: file.size });
      showErrorToast(t('playlist.cover_read_error') || "Failed to read the selected image");
    };
    reader.readAsDataURL(file);
  };

  const handleSaveCover = async (base64Img: string) => {
    setIsCropperOpen(false);
    setSelectedImage(null);
    try {
      const updated = await updatePlaylist(playlistId, { coverImage: base64Img });
      if (updated) {
        setPlaylist(updated);
      }
    } catch (err) {
      console.error("[PlaylistView] save-cover: Failed to update playlist cover", err);
      showErrorToast(t('playlist.cover_save_error') || "Failed to save cover image");
    }
  };

  return (
    <main ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain bg-white dark:bg-[#121212] flex flex-col relative transition-colors duration-300">
      {/* Header Gradient */}
      <div className="absolute top-0 left-0 right-0 h-80 bg-gradient-to-b from-[#4285F4]/40 to-transparent pointer-events-none opacity-50 dark:opacity-20" />
      
      <div className="relative z-10 px-8 pt-20 pb-8 flex items-end gap-6 flex-shrink-0">
        <div 
          className="relative w-48 h-48 rounded-xl shadow-2xl shrink-0 group overflow-hidden cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
        >
          {playlist.coverImage ? (
            <img src={playlist.coverImage} className="w-full h-full object-cover" alt={playlist.name} />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-[#4285F4] to-[#34A853] flex items-center justify-center">
              <Music className="w-20 h-20 text-white opacity-80" />
            </div>
          )}
          
          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center transition-opacity duration-200">
            <Camera className="w-8 h-8 text-white mb-2" />
            <span className="text-white text-sm font-medium">{t('playlist.change_cover', 'Đổi ảnh bìa')}</span>
          </div>
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            accept="image/*" 
            className="hidden" 
          />
        </div>
        <div className="flex-1 pb-2">
          <span className="text-sm font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400">{t('playlist_name')}</span>
          <h1 className="text-5xl font-black mt-2 mb-6 text-gray-900 dark:text-white truncate" title={playlist.name}>
            {playlist.name}
          </h1>
          <div className="flex items-center gap-4 text-sm text-gray-600 dark:text-gray-300 font-medium">
            <span>{playlist.tracks.length} {playlist.tracks.length === 1 ? t('song') : t('songs')}</span>
            <button 
              onClick={handleDelete}
              className="text-red-500 hover:text-red-600 flex items-center gap-1 transition-colors"
            >
              <Trash2 className="w-4 h-4" /> {t('delete')}
            </button>
          </div>
        </div>
      </div>

      <div className="px-8 pb-24 flex-1 min-h-0">
        {tracks.length > 0 && (
          <button 
            onClick={() => onPlay(tracks[0])}
            className="w-14 h-14 bg-[#4285F4] rounded-full flex items-center justify-center text-white hover:scale-105 hover:bg-blue-600 transition-all shadow-lg mb-8 flex-shrink-0"
          >
            <Play className="w-7 h-7 fill-current ml-1" />
          </button>
        )}

        {tracks.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <Music className="w-16 h-16 mx-auto mb-4 opacity-20" />
            <h3 className="text-xl font-medium text-gray-700 dark:text-gray-300">{t('playlist.empty_state_title')}</h3>
            <p className="mt-2 text-sm">{t('playlist.empty_state_subtitle')}</p>
          </div>
        ) : (
          <div className="flex flex-col relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px`, contain: 'strict' }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const track = tracks[virtualRow.index];
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
                >
                  <div 
                    onClick={() => onPlay(track, tracks)}
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
                    <div className={`w-8 text-center text-sm ${currentTrack?.id === track.id ? 'text-[#4285F4] hidden group-hover:block' : 'text-gray-400 group-hover:hidden'}`}>
                      {currentTrack?.id === track.id ? <Music className="w-4 h-4 mx-auto" /> : virtualRow.index + 1}
                    </div>
                    <div className={`w-8 text-center items-center justify-center ${currentTrack?.id === track.id ? 'flex group-hover:hidden' : 'hidden group-hover:flex'}`}>
                      <Play className={`w-4 h-4 ${currentTrack?.id === track.id ? 'text-[#4285F4]' : 'text-gray-900 dark:text-white'}`} fill="currentColor" />
                    </div>
                    
                    <div className={`w-10 h-10 rounded-md flex items-center justify-center shrink-0 overflow-hidden ${currentTrack?.id === track.id ? 'bg-[#4285F4]/10 text-[#4285F4]' : 'bg-gray-200 dark:bg-gray-800'}`}>
                       <Music className={`w-5 h-5 ${currentTrack?.id === track.id ? 'text-[#4285F4]' : 'text-gray-400'}`} />
                    </div>
                    
                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                      <h4 className={`text-[15px] font-semibold truncate transition-colors leading-tight mb-0.5 ${currentTrack?.id === track.id ? 'text-[#4285F4]' : 'text-gray-900 dark:text-white group-hover:text-[#4285F4]'}`}>
                        {track.title}
                      </h4>
                    </div>
                    
                    <button 
                      onClick={(e) => handleRemove(e, track.id)}
                      className="opacity-0 group-hover:opacity-100 p-2 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full transition-all text-gray-400 hover:text-red-500"
                      title={t('remove_from_playlist')}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      
      {isCropperOpen && selectedImage && (
        <ImageCropperModal
          imageSrc={selectedImage}
          onClose={() => {
            setIsCropperOpen(false);
            setSelectedImage(null);
          }}
          onSave={handleSaveCover}
        />
      )}
    </main>
  );
}
