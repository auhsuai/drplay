import { useState, useEffect } from "react";
import type { Playlist } from "../utils/playlists";
import { getPlaylists, addTrackToPlaylist } from "../utils/playlists";
import { showErrorToast } from "../utils/simpleToast";
import { captureError } from "../utils/errorLog";
import type { Track } from "../types";
import type { TFunction } from "i18next";

const SUBMENU_WIDTH = 270;

export function useMenuPlaylists(isMenuOpen: boolean, t: TFunction) {
  const [showPlaylistsSubmenu, setShowPlaylistsSubmenu] = useState(false);
  const [playlistSearchQuery, setPlaylistSearchQuery] = useState("");
  const [playlistCurrentPage, setPlaylistCurrentPage] = useState(1);
  const [playlistSubmenuOpenLeft, setPlaylistSubmenuOpenLeft] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);

  // Reset the submenu state during render (React 19 "adjusting state when
  // props change" pattern) instead of in an effect: closing the menu must
  // collapse the submenu, and closing the submenu must clear its search/page.
  const [prevMenuOpen, setPrevMenuOpen] = useState(isMenuOpen);
  if (!isMenuOpen && prevMenuOpen !== isMenuOpen) {
    setPrevMenuOpen(isMenuOpen);
    setShowPlaylistsSubmenu(false);
  }
  const [prevSubmenuOpen, setPrevSubmenuOpen] = useState(showPlaylistsSubmenu);
  if (!showPlaylistsSubmenu && prevSubmenuOpen !== showPlaylistsSubmenu) {
    setPrevSubmenuOpen(showPlaylistsSubmenu);
    setPlaylistSearchQuery("");
    setPlaylistCurrentPage(1);
  }

  useEffect(() => {
    let ignore = false;
    if (isMenuOpen) {
      getPlaylists()
        .then((data) => {
          if (!ignore) setPlaylists(data);
        })
        .catch(
          (err: unknown) =>
            void captureError({
              level: "error",
              source: "useMenuPlaylists",
              message: `Failed to load playlists: ${err instanceof Error ? err.message : String(err)}`,
            }),
        );
    }
    return () => {
      ignore = true;
    };
  }, [isMenuOpen]);

  const handleAddToPlaylist = async (
    e: React.MouseEvent,
    playlistId: string,
    track: Track | undefined,
    setIsOpen: (o: boolean) => void,
    onClose?: () => void,
  ) => {
    e.stopPropagation();
    if (track) {
      try {
        await addTrackToPlaylist(playlistId, track);
        setIsOpen(false);
        onClose?.();
      } catch (err: unknown) {
        void captureError({
          level: "error",
          source: "useMenuPlaylists",
          message: `Failed to add track to playlist: ${err instanceof Error ? err.message : String(err)}`,
        });
        showErrorToast(t("menu.add_to_playlist_error"));
      }
    }
  };

  const handleToggleSubmenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    setPlaylistSubmenuOpenLeft(rect.right + SUBMENU_WIDTH > window.innerWidth);
    setShowPlaylistsSubmenu(!showPlaylistsSubmenu);
  };

  return {
    showPlaylistsSubmenu,
    setShowPlaylistsSubmenu,
    playlistSearchQuery,
    setPlaylistSearchQuery,
    playlistCurrentPage,
    setPlaylistCurrentPage,
    playlistSubmenuOpenLeft,
    playlists,
    handleAddToPlaylist,
    handleToggleSubmenu,
  };
}
