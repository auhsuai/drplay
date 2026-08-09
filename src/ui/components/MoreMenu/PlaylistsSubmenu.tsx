import React from "react";
import { Search, Music, ChevronLeft, ChevronRight } from "lucide-react";
import type { Playlist } from "../../../utils/playlists";
import { matchesNormalized } from "../../../search/searchEngine";

interface PlaylistsSubmenuProps {
  showPlaylistsSubmenu: boolean;
  playlistSearchQuery: string;
  setPlaylistSearchQuery: (q: string) => void;
  playlistCurrentPage: number;
  setPlaylistCurrentPage: (p: number | ((prev: number) => number)) => void;
  playlistSubmenuOpenLeft: boolean;
  playlists: Playlist[];
  onAddToPlaylist: (e: React.MouseEvent, playlistId: string) => void;
  t: import("i18next").TFunction;
}

export function PlaylistsSubmenu({
  showPlaylistsSubmenu,
  playlistSearchQuery,
  setPlaylistSearchQuery,
  playlistCurrentPage,
  setPlaylistCurrentPage,
  playlistSubmenuOpenLeft,
  playlists,
  onAddToPlaylist,
  t,
}: PlaylistsSubmenuProps) {
  if (!showPlaylistsSubmenu) return null;

  // Why: matchesNormalized (normalizeText-based) makes search
  // diacritics-insensitive ("doi" finds "Đổi mới") and requires every token
  // (AND). It returns false for an empty query by contract, so keep the old
  // "empty query → show everything" behavior with an explicit guard.
  const queryActive = playlistSearchQuery.trim() !== "";
  const filteredPlaylists = playlists.filter(
    (p) => !queryActive || matchesNormalized(p.name, playlistSearchQuery),
  );
  const playlistsPerPage = 5;
  const playlistTotalPages = Math.max(
    1,
    Math.ceil(filteredPlaylists.length / playlistsPerPage),
  );
  const currentPlaylists = filteredPlaylists.slice(
    (playlistCurrentPage - 1) * playlistsPerPage,
    playlistCurrentPage * playlistsPerPage,
  );

  return (
    <div
      className={`absolute bottom-0 ${playlistSubmenuOpenLeft ? "right-full mr-3" : "left-full ml-3"} w-64 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-lg p-1.5 z-50 flex flex-col animate-in fade-in zoom-in-95 duration-200 border border-transparent ring-0 outline-none`}
    >
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider whitespace-nowrap">
          {t("sidebar.playlists")}
        </div>

        <div className="relative flex-1 max-w-[120px]">
          <Search className="w-3 h-3 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder={t("search_placeholder")}
            value={playlistSearchQuery}
            onChange={(e) => {
              setPlaylistSearchQuery(e.target.value);
              setPlaylistCurrentPage(1);
            }}
            className="w-full pl-6 pr-2 py-1 text-[10px] bg-gray-100 dark:bg-[#1c1d21] hover:bg-gray-200 dark:hover:bg-[#25262a] focus:bg-gray-200 dark:focus:bg-[#25262a] text-gray-900 dark:text-gray-100 rounded outline-none transition-all placeholder:text-gray-500"
            onClick={(e) => {
              e.stopPropagation();
            }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-0.5">
        {filteredPlaylists.length === 0 ? (
          <div className="px-3 py-3 text-sm text-gray-400 text-center italic">
            {t("menu.no_playlists")}
          </div>
        ) : (
          currentPlaylists.map((p) => (
            <button
              key={p.id}
              onClick={(e) => {
                onAddToPlaylist(e, p.id);
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-brand-primary rounded-md transition-all flex items-center gap-2 group"
            >
              <Music className="w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity" />
              <span className="truncate">{p.name}</span>
            </button>
          ))
        )}
      </div>

      {playlistTotalPages > 1 && (
        <div className="px-2 pt-2 pb-1 mt-1 border-t border-gray-100 dark:border-gray-800/60 flex items-center justify-center gap-4">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setPlaylistCurrentPage((prev) => Math.max(1, prev - 1));
            }}
            disabled={playlistCurrentPage === 1}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-[#33343a] disabled:opacity-30 transition-colors"
          >
            <ChevronLeft className="w-4 h-4 text-gray-600 dark:text-gray-400" />
          </button>
          <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">
            {playlistCurrentPage} / {playlistTotalPages}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setPlaylistCurrentPage((prev) =>
                Math.min(playlistTotalPages, prev + 1),
              );
            }}
            disabled={playlistCurrentPage === playlistTotalPages}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-[#33343a] disabled:opacity-30 transition-colors"
          >
            <ChevronRight className="w-4 h-4 text-gray-600 dark:text-gray-400" />
          </button>
        </div>
      )}
    </div>
  );
}
