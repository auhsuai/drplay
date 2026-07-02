import { get, set } from 'idb-keyval';
import { Track } from '../App';

export interface Playlist {
  id: string;
  name: string;
  createdAt: number;
  tracks: Track[];
  coverImage?: string;
}

const BASE_PLAYLISTS_KEY = 'drplay_playlists';

function getUserKey(baseKey: string) {
  const email = localStorage.getItem('drplay_current_user_email');
  return email ? `${baseKey}_${email}` : baseKey;
}

export async function getPlaylists(): Promise<Playlist[]> {
  try {
    const playlists = await get<Playlist[]>(getUserKey(BASE_PLAYLISTS_KEY));
    return playlists || [];
  } catch (e) {
    console.error("Failed to get playlists", e);
    return [];
  }
}

export async function createPlaylist(name: string): Promise<Playlist | null> {
  try {
    const playlists = await getPlaylists();
    const newPlaylist: Playlist = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      tracks: []
    };
    playlists.push(newPlaylist);
    await set(getUserKey(BASE_PLAYLISTS_KEY), playlists);
    window.dispatchEvent(new CustomEvent('playlists-updated'));
    return newPlaylist;
  } catch (e) {
    console.error("Failed to create playlist", e);
    return null;
  }
}

export async function deletePlaylist(id: string): Promise<void> {
  try {
    const playlists = await getPlaylists();
    const updated = playlists.filter(p => p.id !== id);
    await set(getUserKey(BASE_PLAYLISTS_KEY), updated);
    window.dispatchEvent(new CustomEvent('playlists-updated'));
  } catch (e) {
    console.error("Failed to delete playlist", e);
  }
}

export async function updatePlaylist(id: string, updates: Partial<Playlist>): Promise<Playlist | null> {
  try {
    const playlists = await getPlaylists();
    const index = playlists.findIndex(p => p.id === id);
    if (index !== -1) {
      playlists[index] = { ...playlists[index], ...updates };
      await set(getUserKey(BASE_PLAYLISTS_KEY), playlists);
      window.dispatchEvent(new CustomEvent('playlists-updated'));
      return playlists[index];
    }
    return null;
  } catch (e) {
    console.error("Failed to update playlist", e);
    return null;
  }
}

export async function addTrackToPlaylist(playlistId: string, track: Track): Promise<void> {
  try {
    const playlists = await getPlaylists();
    const playlist = playlists.find(p => p.id === playlistId);
    if (playlist) {
      if (!playlist.tracks.some(t => t.id === track.id)) {
        playlist.tracks.push(track);
        await set(getUserKey(BASE_PLAYLISTS_KEY), playlists);
        window.dispatchEvent(new CustomEvent('playlists-updated'));
      }
    }
  } catch (e) {
    console.error("Failed to add track to playlist", e);
  }
}

export async function removeTrackFromPlaylist(playlistId: string, trackId: string): Promise<void> {
  try {
    const playlists = await getPlaylists();
    const playlist = playlists.find(p => p.id === playlistId);
    if (playlist) {
      playlist.tracks = playlist.tracks.filter(t => t.id !== trackId);
      await set(getUserKey(BASE_PLAYLISTS_KEY), playlists);
      window.dispatchEvent(new CustomEvent('playlists-updated'));
    }
  } catch (e) {
    console.error("Failed to remove track from playlist", e);
  }
}

export async function getPlaylistById(id: string): Promise<Playlist | null> {
  const playlists = await getPlaylists();
  return playlists.find(p => p.id === id) || null;
}
