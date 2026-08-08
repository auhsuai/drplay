import { Music, ChevronRight } from "lucide-react";
import type { Playlist } from "../../../utils/playlists";
import type { Track } from "../../../App";
import { PlaylistsSubmenu } from "./PlaylistsSubmenu";

interface AddToPlaylistItemProps {
  track?: Track | undefined;
  showPlaylistsSubmenu: boolean;
  playlistSearchQuery: string;
  setPlaylistSearchQuery: (q: string) => void;
  playlistCurrentPage: number;
  setPlaylistCurrentPage: (p: number | ((prev: number) => number)) => void;
  playlistSubmenuOpenLeft: boolean;
  playlists: Playlist[];
  handleAddToPlaylist: (
    e: React.MouseEvent,
    playlistId: string,
    track: Track | undefined,
    setIsOpen: (o: boolean) => void,
    onClose?: () => void,
  ) => Promise<void>;
  handleToggleSubmenu: (e: React.MouseEvent) => void;
  uploadingBlocked: (extraClass: string) => string;
  isTargetUploading: boolean;
  uploadBlockedTitle: string | undefined;
  setIsOpen: (open: boolean) => void;
  onClose?: (() => void) | undefined;
  t: import("i18next").TFunction;
}

export function AddToPlaylistItem({
  track,
  showPlaylistsSubmenu,
  playlistSearchQuery,
  setPlaylistSearchQuery,
  playlistCurrentPage,
  setPlaylistCurrentPage,
  playlistSubmenuOpenLeft,
  playlists,
  handleAddToPlaylist,
  handleToggleSubmenu,
  uploadingBlocked,
  isTargetUploading,
  uploadBlockedTitle,
  setIsOpen,
  onClose,
  t,
}: AddToPlaylistItemProps) {
  return (
    <>
      {track && (
        <div className="relative">
          <button
            onClick={handleToggleSubmenu}
            className={uploadingBlocked(
              "w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center justify-between group mb-1",
            )}
            disabled={isTargetUploading}
            title={uploadBlockedTitle}
          >
            <div className="flex items-center gap-2">
              <Music className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
              <span className="truncate">{t("menu.add_to_playlist")}</span>
            </div>
            <ChevronRight className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
          </button>

          <PlaylistsSubmenu
            showPlaylistsSubmenu={showPlaylistsSubmenu}
            playlistSearchQuery={playlistSearchQuery}
            setPlaylistSearchQuery={setPlaylistSearchQuery}
            playlistCurrentPage={playlistCurrentPage}
            setPlaylistCurrentPage={setPlaylistCurrentPage}
            playlistSubmenuOpenLeft={playlistSubmenuOpenLeft}
            playlists={playlists}
            onAddToPlaylist={(e, pId) => {
              void handleAddToPlaylist(e, pId, track, setIsOpen, onClose);
            }}
            t={t}
          />
        </div>
      )}
    </>
  );
}
