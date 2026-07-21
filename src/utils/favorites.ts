import { Track } from '../App';
import { db } from '../db/db';
import { showErrorToast } from './simpleToast';

const FAV_MODULE = "favorites";

// Classify a favorites persistence error for observability. Returns name +
// message only — never the error object/stack, which can leak track data.
function classifyFavoriteError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message}`;
}

function getCurrentUserEmail() {
  return localStorage.getItem('drplay_current_user_email') || 'default';
}

export async function getFavorites(): Promise<Track[]> {
  try {
    const email = getCurrentUserEmail();
    const favs = await db.favorites.where('userEmail').equals(email).toArray();
    // Sort descending by createdAt to simulate unshift
    return favs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch (e) {
    console.error(`[${FAV_MODULE}] get-failed`, classifyFavoriteError(e));
    return [];
  }
}

export async function addFavorite(track: Track): Promise<void> {
  try {
    const email = getCurrentUserEmail();
    const existing = await db.favorites.get(track.id);
    // `favorites` is keyed by track id alone (not a compound [id+userEmail]
    // key), so a raw `.get(track.id)` can return ANOTHER user's row for the
    // same track id (e.g. a file shared across two Google accounts on this
    // device). Only treat it as "already favorited" if it belongs to the
    // CURRENT user — otherwise this silently no-ops the current user's own
    // like action because the id looked taken.
    if (!existing || existing.userEmail !== email) {
      await db.favorites.put({
        ...track,
        userEmail: email,
        createdAt: Date.now()
      });
      window.dispatchEvent(new CustomEvent('favorites-updated'));
    }
  } catch (e) {
    console.error(`[${FAV_MODULE}] add-failed`, classifyFavoriteError(e));
    showErrorToast('Không thể thêm vào yêu thích, vui lòng thử lại.');
  }
}

export async function removeFavorite(trackId: string): Promise<void> {
  try {
    const email = getCurrentUserEmail();
    const existing = await db.favorites.get(trackId);
    // Same non-compound-key issue as addFavorite: only delete the row if it
    // actually belongs to the current user, otherwise one account's "unlike"
    // action could permanently delete a different account's favorite.
    if (existing && existing.userEmail === email) {
      await db.favorites.delete(trackId);
      window.dispatchEvent(new CustomEvent('favorites-updated'));
    }
  } catch (e) {
    console.error(`[${FAV_MODULE}] remove-failed`, classifyFavoriteError(e));
    showErrorToast('Không thể xóa khỏi yêu thích, vui lòng thử lại.');
  }
}

export async function isFavorite(trackId: string): Promise<boolean> {
  try {
    const email = getCurrentUserEmail();
    const fav = await db.favorites.get(trackId);
    // Only report "favorited" if the stored row belongs to the current
    // user — otherwise User B's UI would show a heart filled in for a
    // track only User A ever favorited.
    return !!fav && fav.userEmail === email;
  } catch (e) {
    return false;
  }
}
