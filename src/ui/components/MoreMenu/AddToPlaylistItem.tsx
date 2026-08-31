import { Music, ChevronRight } from "lucide-react";
import type { Playlist } from "../../../utils/playlists";
import type { Track } from "../../../types";
import { IS_MOBILE } from "../../../utils/platform";
import { menuItemBaseClass, menuItemIconClass } from "./constants";
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
  /** Mobile (IS_MOBILE) only: opens the standalone picker modal instead of
   *  the nested submenu, which clips off-screen near the player bar edge. */
  onOpenPicker: () => void;
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
  onOpenPicker,
  t,
}: AddToPlaylistItemProps) {
  return (
    <>
      {track && (
        <div className="relative">
          <button
            onClick={IS_MOBILE ? onOpenPicker : handleToggleSubmenu}
            className={uploadingBlocked(
              // Why the appended utility: this row pins the chevron right with
              // justify-between, unlike the shared base's gap-2. With exactly
              // two flex children justify-between fully absorbs the gap, so
              // the desktop render is pixel-identical to the previous
              // hand-rolled string.
              `${menuItemBaseClass(IS_MOBILE)} justify-between`,
            )}
            disabled={isTargetUploading}
            title={uploadBlockedTitle}
          >
            <div className="flex items-center gap-2">
              <Music className={menuItemIconClass(IS_MOBILE)} />
              <span className="truncate">{t("menu.add_to_playlist")}</span>
            </div>
            <ChevronRight className={menuItemIconClass(IS_MOBILE)} />
          </button>

          {/* Desktop-only: the nested popup clips off-screen on mobile, where
              the standalone picker modal replaces it entirely. */}
          {!IS_MOBILE && (
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
          )}
        </div>
      )}
    </>
  );
}
