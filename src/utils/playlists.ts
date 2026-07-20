import { db } from '../db/db';
import { Track } from '../App';
import { showErrorToast } from './simpleToast';

export interface Playlist {
  id: string;
  userEmail: string;
  name: string;
  createdAt: number;
  tracks: Track[];
  coverImage?: string;
}

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

function getUserEmail(): string {
  return localStorage.getItem('drplay_current_user_email') || 'default';
}

async function loadPlaylists(): Promise<Playlist[]> {
  const email = getUserEmail();
  const rows = await db.playlists.where('userEmail').equals(email).toArray();
  return rows.map(({ id, userEmail, name, createdAt, tracks, coverImage }) => ({
    id,
    userEmail,
    name,
    createdAt,
    tracks: tracks ?? [],
    coverImage
  }));
}

export async function getPlaylists(): Promise<Playlist[]> {
  try {
    return await loadPlaylists();
  } catch (e) {
    console.error(`[${PLAYLIST_MODULE}] get-failed`, classifyPlaylistError(e));
    return [];
  }
}

export async function createPlaylist(name: string): Promise<Playlist | null> {
  try {
    const email = getUserEmail();
    const newPlaylist: Playlist = {
      id: crypto.randomUUID(),
      userEmail: email,
      name,
      createdAt: Date.now(),
      tracks: []
    };
    await db.playlists.put(newPlaylist);
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
    await db.playlists.delete(id);
    window.dispatchEvent(new CustomEvent('playlists-updated'));
  } catch (e) {
    console.error(`[${PLAYLIST_MODULE}] delete-failed`, classifyPlaylistError(e));
    showErrorToast("Failed to delete playlist");
  }
}

export async function updatePlaylist(id: string, updates: Partial<Playlist>): Promise<Playlist | null> {
  try {
    const existing = await db.playlists.get(id);
    if (!existing) return null;
    const updated: Playlist = { ...existing, ...updates, id, userEmail: existing.userEmail };
    await db.playlists.put(updated);
    window.dispatchEvent(new CustomEvent('playlists-updated'));
    return updated;
  } catch (e) {
    console.error(`[${PLAYLIST_MODULE}] update-failed`, classifyPlaylistError(e));
    showErrorToast("Failed to update playlist");
    return null;
  }
}

export async function addTrackToPlaylist(playlistId: string, track: Track): Promise<void> {
  try {
    const playlist = await db.playlists.get(playlistId);
    if (playlist) {
      if (!playlist.tracks.some(t => t.id === track.id)) {
        playlist.tracks.push(track);
        await db.playlists.put(playlist);
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
    const playlist = await db.playlists.get(playlistId);
    if (playlist) {
      playlist.tracks = playlist.tracks.filter(t => t.id !== trackId);
      await db.playlists.put(playlist);
      window.dispatchEvent(new CustomEvent('playlists-updated'));
    }
  } catch (e) {
    console.error(`[${PLAYLIST_MODULE}] remove-track-failed`, classifyPlaylistError(e));
    showErrorToast("Failed to remove track from playlist");
  }
}

export async function getPlaylistById(id: string): Promise<Playlist | null> {
  try {
    const row = await db.playlists.get(id);
    if (!row) return null;
    return {
      id: row.id,
      userEmail: row.userEmail,
      name: row.name,
      createdAt: row.createdAt,
      tracks: row.tracks ?? [],
      coverImage: row.coverImage
    };
  } catch (e) {
    console.error(`[${PLAYLIST_MODULE}] get-by-id-failed`, classifyPlaylistError(e));
    return null;
  }
}
