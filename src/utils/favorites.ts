import { get, set } from 'idb-keyval';
import { Track } from '../App';

const BASE_FAVORITES_KEY = 'drplay_favorites';

function getUserKey(baseKey: string) {
  const email = localStorage.getItem('drplay_current_user_email');
  return email ? `${baseKey}_${email}` : baseKey;
}

export async function getFavorites(): Promise<Track[]> {
  try {
    const favorites = await get<Track[]>(getUserKey(BASE_FAVORITES_KEY));
    return favorites || [];
  } catch (e) {
    console.error("Failed to get favorites", e);
    return [];
  }
}

export async function addFavorite(track: Track): Promise<void> {
  try {
    const favorites = await getFavorites();
    if (!favorites.some(f => f.id === track.id)) {
      // Add to beginning of array
      favorites.unshift(track);
      await set(getUserKey(BASE_FAVORITES_KEY), favorites);
      // Dispatch custom event for UI updates
      window.dispatchEvent(new CustomEvent('favorites-updated'));
    }
  } catch (e) {
    console.error("Failed to add favorite", e);
  }
}

export async function removeFavorite(trackId: string): Promise<void> {
  try {
    const favorites = await getFavorites();
    const updated = favorites.filter(f => f.id !== trackId);
    await set(getUserKey(BASE_FAVORITES_KEY), updated);
    // Dispatch custom event for UI updates
    window.dispatchEvent(new CustomEvent('favorites-updated'));
  } catch (e) {
    console.error("Failed to remove favorite", e);
  }
}

export async function isFavorite(trackId: string): Promise<boolean> {
  try {
    const favorites = await getFavorites();
    return favorites.some(f => f.id === trackId);
  } catch (e) {
    return false;
  }
}
