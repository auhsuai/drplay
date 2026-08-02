import type { Track } from '../types';
import { db } from '../db/db';
import { showErrorToast } from './simpleToast';
import { captureError } from './errorLog';

const FAV_MODULE = "favorites";
const DEFAULT_USER_EMAIL = 'default';
const TOKEN_KEY_EMAIL = 'drplay_current_user_email';

// Classify a favorites persistence error for observability. Returns name +
// message only — never the error object/stack, which can leak track data.
function classifyFavoriteError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message}`;
}

function getCurrentUserEmail() {
  return localStorage.getItem(TOKEN_KEY_EMAIL) || DEFAULT_USER_EMAIL;
}

export async function getFavorites(): Promise<Track[]> {
  try {
    const email = getCurrentUserEmail();
    const favs = await db.favorites.where('userEmail').equals(email).toArray();
    // Sort descending by createdAt to simulate unshift
    return favs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch (e: unknown) {
    captureError({
      level: 'error',
      source: FAV_MODULE,
      message: `get-failed: ${classifyFavoriteError(e)}`,
    });
    return [];
  }
}

export async function addFavorite(track: Track): Promise<void> {
  try {
    const email = getCurrentUserEmail();
    await db.transaction('rw', db.favorites, async () => {
      const existing = await db.favorites.get(track.id);
      if (!existing) {
        await db.favorites.put({
          ...track,
          userEmail: email,
          createdAt: Date.now()
        });
        window.dispatchEvent(new CustomEvent('favorites-updated'));
      }
    });
  } catch (e: unknown) {
    captureError({
      level: 'error',
      source: FAV_MODULE,
      message: `add-failed: ${classifyFavoriteError(e)}`,
    });
    showErrorToast('Không thể thêm vào yêu thích, vui lòng thử lại.');
  }
}

export async function removeFavorite(trackId: string): Promise<void> {
  try {
    await db.favorites.delete(trackId);
    window.dispatchEvent(new CustomEvent('favorites-updated'));
  } catch (e: unknown) {
    captureError({
      level: 'error',
      source: FAV_MODULE,
      message: `remove-failed: ${classifyFavoriteError(e)}`,
    });
    showErrorToast('Không thể xóa khỏi yêu thích, vui lòng thử lại.');
  }
}

export async function isFavorite(trackId: string): Promise<boolean> {
  try {
    const fav = await db.favorites.get(trackId);
    return !!fav;
  } catch (e: unknown) {
    captureError({
      level: 'warn',
      source: FAV_MODULE,
      message: `is-fav-failed: ${classifyFavoriteError(e)}`,
    });
    return false;
  }
}
