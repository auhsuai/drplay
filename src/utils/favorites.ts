import { get } from 'idb-keyval';
import { Track } from '../App';
import { db } from '../db/db';
import { showErrorToast } from './simpleToast';

const FAV_MODULE = "favorites";
const BASE_FAVORITES_KEY = 'drplay_favorites';
let migrationDone = false;

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

function getOldUserKey(baseKey: string) {
  const email = localStorage.getItem('drplay_current_user_email');
  return email ? `${baseKey}_${email}` : baseKey;
}

// Chuyển đổi dữ liệu cũ từ idb-keyval sang Dexie
async function migrateOldFavorites() {
  if (migrationDone) return;
  try {
    const hasMigrated = localStorage.getItem('drplay_favorites_migrated');
    if (!hasMigrated) {
      const email = getCurrentUserEmail();
      const oldFavorites = await get<Track[]>(getOldUserKey(BASE_FAVORITES_KEY));
      if (oldFavorites && oldFavorites.length > 0) {
        // Bulk put into Dexie
        const items = oldFavorites.map((track, index) => ({
          ...track,
          userEmail: email,
          createdAt: Date.now() - index // preserve order roughly
        }));
        await db.favorites.bulkPut(items);
        console.warn(`[favorites] Migrated ${items.length} favorites to Dexie.`);
      }
      localStorage.setItem('drplay_favorites_migrated', 'true');
    }
  } catch (e) {
    console.error(`[${FAV_MODULE}] migrate-failed`, classifyFavoriteError(e));
  } finally {
    migrationDone = true;
  }
}

export async function getFavorites(): Promise<Track[]> {
  await migrateOldFavorites();
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
  await migrateOldFavorites();
  try {
    const email = getCurrentUserEmail();
    const existing = await db.favorites.get(track.id);
    if (!existing) {
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
  await migrateOldFavorites();
  try {
    await db.favorites.delete(trackId);
    window.dispatchEvent(new CustomEvent('favorites-updated'));
  } catch (e) {
    console.error(`[${FAV_MODULE}] remove-failed`, classifyFavoriteError(e));
    showErrorToast('Không thể xóa khỏi yêu thích, vui lòng thử lại.');
  }
}

export async function isFavorite(trackId: string): Promise<boolean> {
  await migrateOldFavorites();
  try {
    const fav = await db.favorites.get(trackId);
    return !!fav;
  } catch (e) {
    return false;
  }
}
