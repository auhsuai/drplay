import { useState, useEffect } from "react";
import type { Playlist } from "../utils/playlists";
import { getPlaylists, addTrackToPlaylist } from "../utils/playlists";
import type { Track } from "../types";
import type { TFunction } from "i18next";

const SUBMENU_WIDTH = 270;

export function useMenuPlaylists(
  isMenuOpen: boolean,
  // Kept in the public signature for MoreMenu's call site; the hook itself no
  // longer needs it (addTrackToPlaylist owns its failure feedback, B14-3).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _t: TFunction,
) {
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
      // getPlaylists never rejects (it catches, logs and returns []).
      void getPlaylists().then((data) => {
        if (!ignore) setPlaylists(data);
      });
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
      const ok = await addTrackToPlaylist(playlistId, track);
      if (!ok) return;
      setIsOpen(false);
      onClose?.();
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
