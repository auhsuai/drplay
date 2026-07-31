import { useState, useEffect } from 'react';
import { getPlaylists, addTrackToPlaylist, Playlist } from '../utils/playlists';
import { showErrorToast } from '../utils/simpleToast';
import { captureError } from '../utils/errorLog';
import { Track } from '../App';
import { TFunction } from 'i18next';

const SUBMENU_WIDTH = 270;

export function useMenuPlaylists(isMenuOpen: boolean, t: TFunction) {
  const [showPlaylistsSubmenu, setShowPlaylistsSubmenu] = useState(false);
  const [playlistSearchQuery, setPlaylistSearchQuery] = useState('');
  const [playlistCurrentPage, setPlaylistCurrentPage] = useState(1);
  const [playlistSubmenuOpenLeft, setPlaylistSubmenuOpenLeft] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);

  useEffect(() => {
    if (isMenuOpen) {
      getPlaylists().then(setPlaylists).catch((err: unknown) => captureError({ level: 'error', source: 'useMenuPlaylists', message: `Failed to load playlists: ${err instanceof Error ? err.message : String(err)}` }));
    } else {
      setShowPlaylistsSubmenu(false);
    }
  }, [isMenuOpen]);

  useEffect(() => {
    if (!showPlaylistsSubmenu) {
      setPlaylistSearchQuery("");
      setPlaylistCurrentPage(1);
    }
  }, [showPlaylistsSubmenu]);

  const handleAddToPlaylist = async (
    e: React.MouseEvent,
    playlistId: string,
    track: Track | undefined,
    setIsOpen: (o: boolean) => void,
    onClose?: () => void
  ) => {
    e.stopPropagation();
    if (track) {
      try {
        await addTrackToPlaylist(playlistId, track);
        setIsOpen(false);
        onClose?.();
      } catch (err: unknown) {
        captureError({ level: 'error', source: 'useMenuPlaylists', message: `Failed to add track to playlist: ${err instanceof Error ? err.message : String(err)}` });
        showErrorToast(t('menu.add_to_playlist_error', 'Failed to add to playlist'));
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
    handleToggleSubmenu
  };
}
