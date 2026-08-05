import { db } from "../db/db";
import type { Track } from "../types";
import { showErrorToast } from "./simpleToast";
import { captureError } from "./errorLog";
import { getCurrentUserEmail } from "./storageKeys";
import i18n from "../i18n";

export interface Playlist {
  id: string;
  userEmail: string;
  name: string;
  createdAt: number;
  tracks: Track[];
  coverImage?: string | undefined;
}

const PLAYLIST_MODULE = "playlists";

// Derive a short, safe classification from an error's name/message ONLY.
// We never log the error object or its stack — those can leak file ids, user
// data, or (in theory) auth material into logs. Local persistence (IndexedDB)
// errors — semantic twin of classifyFavoriteError (favorites.ts), NOT Drive's
// classifyDriveError (HTTP).
function classifyPlaylistError(err: unknown): {
  name: string;
  message: string;
} {
  const name = err instanceof Error ? err.name : "unknown";
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown-error";
  return { name, message };
}

// The Playlist interface claims tracks is always present, but rows written
// before the field existed lack it at runtime — this helper surfaces the true
// shape so the ?? normalizer below is checked (and lint-visible).
function getPlaylistTracks(p: Playlist): Track[] | undefined {
  return p.tracks;
}

async function loadPlaylists(): Promise<Playlist[]> {
  const email = getCurrentUserEmail();
  const rows = await db.playlists.where("userEmail").equals(email).toArray();
  return rows.map((row) => ({
    id: row.id,
    userEmail: row.userEmail,
    name: row.name,
    createdAt: row.createdAt,
    tracks: getPlaylistTracks(row) ?? [],
    coverImage: row.coverImage,
  }));
}

export async function getPlaylists(): Promise<Playlist[]> {
  try {
    return await loadPlaylists();
  } catch (e: unknown) {
    const { name, message } = classifyPlaylistError(e);
    await captureError({
      level: "error",
      source: PLAYLIST_MODULE,
      message: `get-failed: ${name}: ${message}`,
    });
    return [];
  }
}

export async function createPlaylist(name: string): Promise<Playlist | null> {
  try {
    const email = getCurrentUserEmail();
    const newPlaylist: Playlist = {
      id: crypto.randomUUID(),
      userEmail: email,
      name,
      createdAt: Date.now(),
      tracks: [],
    };
    await db.playlists.put(newPlaylist);
    window.dispatchEvent(new CustomEvent("playlists-updated"));
    return newPlaylist;
  } catch (e: unknown) {
    const { name, message } = classifyPlaylistError(e);
    await captureError({
      level: "error",
      source: PLAYLIST_MODULE,
      message: `create-failed: ${name}: ${message}`,
    });
    showErrorToast(i18n.t("sidebar.create_playlist_error"));
    return null;
  }
}

export async function deletePlaylist(id: string): Promise<void> {
  try {
    await db.playlists.delete(id);
    window.dispatchEvent(new CustomEvent("playlists-updated"));
  } catch (e: unknown) {
    const { name, message } = classifyPlaylistError(e);
    await captureError({
      level: "error",
      source: PLAYLIST_MODULE,
      message: `delete-failed: ${name}: ${message}`,
    });
    showErrorToast(i18n.t("playlist.delete_error"));
  }
}

export async function updatePlaylist(
  id: string,
  updates: Partial<Playlist>,
): Promise<Playlist | null> {
  try {
    return await db.transaction("rw", db.playlists, async () => {
      const existing = await db.playlists.get(id);
      if (!existing) return null;
      const updated: Playlist = {
        ...existing,
        ...updates,
        id,
        userEmail: existing.userEmail,
      };
      await db.playlists.put(updated);
      window.dispatchEvent(new CustomEvent("playlists-updated"));
      // Return a clone — objects touched inside a transaction zone must not
      // be used after commit (IndexedDB structured-clone restriction).
      return { ...updated, tracks: [...updated.tracks] };
    });
  } catch (e: unknown) {
    const { name, message } = classifyPlaylistError(e);
    await captureError({
      level: "error",
      source: PLAYLIST_MODULE,
      message: `update-failed: ${name}: ${message}`,
    });
    showErrorToast(i18n.t("playlist.update_error"));
    return null;
  }
}

export async function addTrackToPlaylist(
  playlistId: string,
  track: Track,
): Promise<void> {
  try {
    await db.transaction("rw", db.playlists, async () => {
      const playlist = await db.playlists.get(playlistId);
      if (playlist) {
        if (!playlist.tracks.some((t) => t.id === track.id)) {
          playlist.tracks.push(track);
          await db.playlists.put(playlist);
          window.dispatchEvent(new CustomEvent("playlists-updated"));
        }
      }
    });
  } catch (e: unknown) {
    const { name, message } = classifyPlaylistError(e);
    await captureError({
      level: "error",
      source: PLAYLIST_MODULE,
      message: `add-track-failed: ${name}: ${message}`,
    });
    showErrorToast(i18n.t("playlist.add_track_error"));
  }
}

export async function removeTrackFromPlaylist(
  playlistId: string,
  trackId: string,
): Promise<void> {
  try {
    await db.transaction("rw", db.playlists, async () => {
      const playlist = await db.playlists.get(playlistId);
      if (playlist) {
        playlist.tracks = playlist.tracks.filter((t) => t.id !== trackId);
        await db.playlists.put(playlist);
        window.dispatchEvent(new CustomEvent("playlists-updated"));
      }
    });
  } catch (e: unknown) {
    const { name, message } = classifyPlaylistError(e);
    await captureError({
      level: "error",
      source: PLAYLIST_MODULE,
      message: `remove-track-failed: ${name}: ${message}`,
    });
    showErrorToast(i18n.t("playlist.remove_track_error"));
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
      tracks: getPlaylistTracks(row) ?? [],
      coverImage: row.coverImage,
    };
  } catch (e: unknown) {
    const { name, message } = classifyPlaylistError(e);
    await captureError({
      level: "error",
      source: PLAYLIST_MODULE,
      message: `get-by-id-failed: ${name}: ${message}`,
    });
    return null;
  }
}
