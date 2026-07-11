import React, { useState, useEffect } from "react";
import { Track } from "../../App";
import { Music, Play, X, Trash2, Camera } from "lucide-react";
import { getPlaylistById, removeTrackFromPlaylist, deletePlaylist, updatePlaylist, Playlist } from "../../utils/playlists";
import { ImageCropperModal } from "../components/ImageCropperModal";
import { useTranslation } from "react-i18next";


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

  const loadPlaylist = async () => {
    try {
      const data = await getPlaylistById(playlistId);
      setPlaylist(data);
    } catch (e) {
      console.error("Failed to load playlist", e);
    }
  };

  useEffect(() => {
    loadPlaylist().catch(console.error);
    window.addEventListener('playlists-updated', loadPlaylist);
    window.addEventListener('user-changed', loadPlaylist);
    return () => {
      window.removeEventListener('playlists-updated', loadPlaylist);
      window.removeEventListener('user-changed', loadPlaylist);
    };
  }, [playlistId]);

  if (!playlist) return null;

  const handleRemove = async (e: React.MouseEvent, trackId: string) => {
    e.stopPropagation();
    await removeTrackFromPlaylist(playlistId, trackId);
  };

  const handleDelete = async () => {
    if (window.confirm(t("confirm_delete_playlist"))) {
      await deletePlaylist(playlistId);
      onDelete(); // Triggers tab change in App
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setSelectedImage(event.target?.result as string);
        setIsCropperOpen(true);
      };
      reader.readAsDataURL(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleSaveCover = async (base64Img: string) => {
    setIsCropperOpen(false);
    setSelectedImage(null);
    const updated = await updatePlaylist(playlistId, { coverImage: base64Img });
    if (updated) {
      setPlaylist(updated);
    }
  };

  return (
    <main className="flex-1 overflow-y-auto bg-white dark:bg-[#121212] flex flex-col relative transition-colors duration-300">
      {/* Header Gradient */}
      <div className="absolute top-0 left-0 right-0 h-80 bg-gradient-to-b from-[#4285F4]/40 to-transparent pointer-events-none opacity-50 dark:opacity-20" />
      
      <div className="relative z-10 px-8 pt-20 pb-8 flex items-end gap-6">
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

      <div className="p-8">
        {playlist.tracks.length > 0 && (
          <button 
            onClick={() => onPlay(playlist.tracks[0])}
            className="w-14 h-14 bg-[#4285F4] rounded-full flex items-center justify-center text-white hover:scale-105 hover:bg-blue-600 transition-all shadow-lg mb-8"
          >
            <Play className="w-7 h-7 fill-current ml-1" />
          </button>
        )}

        <div className="space-y-2">
          {playlist.tracks.map((track, index) => (
            <div 
              key={track.id}
              onClick={() => onPlay(track, playlist.tracks)}
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
                {currentTrack?.id === track.id ? <Music className="w-4 h-4 mx-auto" /> : index + 1}
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
                <p className="text-[13px] text-gray-500 truncate leading-tight">{t('unknown_artist')}</p>
              </div>
              
              <button 
                onClick={(e) => handleRemove(e, track.id)}
                className="opacity-0 group-hover:opacity-100 p-2 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full transition-all text-gray-400 hover:text-red-500"
                title={t('remove_from_playlist')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}

          {playlist.tracks.length === 0 && (
            <div className="text-center py-20 text-gray-500">
              <Music className="w-16 h-16 mx-auto mb-4 opacity-20" />
              <h3 className="text-xl font-medium text-gray-700 dark:text-gray-300">{t('playlist.empty_state_title')}</h3>
              <p className="mt-2 text-sm">{t('playlist.empty_state_subtitle')}</p>
            </div>
          )}
        </div>
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
