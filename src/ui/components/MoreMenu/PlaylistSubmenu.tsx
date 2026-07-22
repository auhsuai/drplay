import { useState } from "react";
import { Search, Music, ChevronRight, ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Track } from "../../../App";
import { Playlist } from "../../../utils/playlists";
import { addTrackToPlaylist } from "../../../utils/playlists";
import { showErrorToast } from "../../../utils/simpleToast";

interface PlaylistSubmenuProps {
  playlists: Playlist[];
  track?: Track;
  openLeft: boolean;
  onClose: () => void;
}

export function PlaylistSubmenu({ playlists, track, openLeft, onClose }: PlaylistSubmenuProps) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  const filtered = playlists.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()));
  const perPage = 5;
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const currentPlaylists = filtered.slice((currentPage - 1) * perPage, currentPage * perPage);

  const handleAdd = async (e: React.MouseEvent, playlistId: string) => {
    e.stopPropagation();
    if (track) {
      try {
        await addTrackToPlaylist(playlistId, track);
        onClose();
      } catch (err) {
        console.error("[MoreMenu] add-to-playlist: Failed", err);
        showErrorToast(t('menu.add_to_playlist_error') || "Failed to add to playlist");
      }
    }
  };

  return (
    <div className={`absolute bottom-0 ${openLeft ? 'right-full mr-3' : 'left-full ml-3'} w-64 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-lg p-1.5 z-50 flex flex-col animate-in fade-in zoom-in-95 duration-200 border border-transparent ring-0 outline-none`}>
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider whitespace-nowrap">
          {t('sidebar.playlists', 'Playlists')}
        </div>
        <div className="relative flex-1 max-w-[120px]">
          <Search className="w-3 h-3 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" />
          <input type="text" placeholder={t('search_placeholder', 'Search...')} value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
            className="w-full pl-6 pr-2 py-1 text-[10px] bg-gray-100 dark:bg-[#1c1d21] hover:bg-gray-200 dark:hover:bg-[#25262a] focus:bg-gray-200 dark:focus:bg-[#25262a] text-gray-900 dark:text-gray-100 rounded outline-none transition-all placeholder:text-gray-500"
            onClick={(e) => e.stopPropagation()} />
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        {filtered.length === 0 ? (
          <div className="px-3 py-3 text-sm text-gray-400 text-center italic">{t('menu.no_playlists')}</div>
        ) : currentPlaylists.map(p => (
          <button key={p.id} onClick={(e) => handleAdd(e, p.id)}
            className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group">
            <Music className="w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity" />
            <span className="truncate">{p.name}</span>
          </button>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="px-2 pt-2 pb-1 mt-1 border-t border-gray-100 dark:border-gray-800/60 flex items-center justify-center gap-4">
          <button onClick={(e) => { e.stopPropagation(); setCurrentPage(p => Math.max(1, p - 1)); }}
            disabled={currentPage === 1} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-[#33343a] disabled:opacity-30 transition-colors">
            <ChevronLeft className="w-4 h-4 text-gray-600 dark:text-gray-400" />
          </button>
          <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">{currentPage} / {totalPages}</span>
          <button onClick={(e) => { e.stopPropagation(); setCurrentPage(p => Math.min(totalPages, p + 1)); }}
            disabled={currentPage === totalPages} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-[#33343a] disabled:opacity-30 transition-colors">
            <ChevronRight className="w-4 h-4 text-gray-600 dark:text-gray-400" />
          </button>
        </div>
      )}
    </div>
  );
}
