import { get } from 'idb-keyval';
import { Track } from '../App';
import { db } from '../db/db';

const BASE_FAVORITES_KEY = 'drplay_favorites';
let migrationDone = false;

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
        console.log(`Migrated ${items.length} favorites to Dexie.`);
      }
      localStorage.setItem('drplay_favorites_migrated', 'true');
    }
  } catch (e) {
    console.error("Failed to migrate favorites", e);
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
    console.error("Failed to get favorites", e);
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
    console.error("Failed to add favorite", e);
  }
}

export async function removeFavorite(trackId: string): Promise<void> {
  await migrateOldFavorites();
  try {
    await db.favorites.delete(trackId);
    window.dispatchEvent(new CustomEvent('favorites-updated'));
  } catch (e) {
    console.error("Failed to remove favorite", e);
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
