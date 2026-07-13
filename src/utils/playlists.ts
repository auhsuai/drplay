import { get, set } from 'idb-keyval';
import { Track } from '../App';
import { showErrorToast } from './simpleToast';

export interface Playlist {
  id: string;
  name: string;
  createdAt: number;
  tracks: Track[];
  coverImage?: string;
}

const BASE_PLAYLISTS_KEY = 'drplay_playlists';
const PLAYLIST_MODULE = "playlists";

// Derive a short, safe classification from an error's name/message ONLY.
// We never log the error object or its stack — those can leak file ids, user
// data, or (in theory) auth material into logs. Mirrors classifyDriveError.
function classifyPlaylistError(err: unknown): { name: string; message: string } {
  const name = err instanceof Error ? err.name : "unknown";
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown-error";
  return { name, message };
}

function getUserKey(baseKey: string) {
  const email = localStorage.getItem('drplay_current_user_email');
  return email ? `${baseKey}_${email}` : baseKey;
}

export async function getPlaylists(): Promise<Playlist[]> {
  try {
    const playlists = await get<Playlist[]>(getUserKey(BASE_PLAYLISTS_KEY));
    return playlists || [];
  } catch (e) {
    console.error(`[${PLAYLIST_MODULE}] get-failed`, classifyPlaylistError(e));
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
    console.error(`[${PLAYLIST_MODULE}] create-failed`, classifyPlaylistError(e));
    showErrorToast("Failed to create playlist");
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
    console.error(`[${PLAYLIST_MODULE}] delete-failed`, classifyPlaylistError(e));
    showErrorToast("Failed to delete playlist");
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
    console.error(`[${PLAYLIST_MODULE}] update-failed`, classifyPlaylistError(e));
    showErrorToast("Failed to update playlist");
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
    console.error(`[${PLAYLIST_MODULE}] add-track-failed`, classifyPlaylistError(e));
    showErrorToast("Failed to add track to playlist");
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
    console.error(`[${PLAYLIST_MODULE}] remove-track-failed`, classifyPlaylistError(e));
    showErrorToast("Failed to remove track from playlist");
  }
}

export async function getPlaylistById(id: string): Promise<Playlist | null> {
  const playlists = await getPlaylists();
  return playlists.find(p => p.id === id) || null;
}
