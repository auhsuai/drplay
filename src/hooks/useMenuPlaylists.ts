import { useState, useEffect } from 'react';
import { getPlaylists, addTrackToPlaylist, Playlist } from '../utils/playlists';
import { showErrorToast } from '../utils/simpleToast';
import { Track } from '../App';
import { TFunction } from 'i18next';

export function useMenuPlaylists(isMenuOpen: boolean, t: TFunction) {
  const [showPlaylistsSubmenu, setShowPlaylistsSubmenu] = useState(false);
  const [playlistSearchQuery, setPlaylistSearchQuery] = useState('');
  const [playlistCurrentPage, setPlaylistCurrentPage] = useState(1);
  const [playlistSubmenuOpenLeft, setPlaylistSubmenuOpenLeft] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);

  useEffect(() => {
    if (isMenuOpen) {
      getPlaylists().then(setPlaylists).catch((err: unknown) => console.error('[useMenuPlaylists] Failed to load playlists', err));
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
      } catch (err) {
        console.error("[useMenuPlaylists] add-to-playlist: Failed to add track to playlist", err);
        showErrorToast(t('menu.add_to_playlist_error', 'Failed to add to playlist'));
      }
    }
  };

  const handleToggleSubmenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    setPlaylistSubmenuOpenLeft(rect.right + 270 > window.innerWidth);
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
