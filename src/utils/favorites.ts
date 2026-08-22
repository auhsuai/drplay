import type { Track } from "../types";
import { db } from "../db/db";
import { showErrorToast } from "./simpleToast";
import { captureError } from "./errorLog";
import { getCurrentUserEmail } from "./storageKeys";
import i18n from "../i18n";

const FAV_MODULE = "favorites";

// Broadcast on add/remove favorite so listeners (player bar heart, liked
// songs list) can re-read the persisted state.
export const FAVORITES_UPDATED_EVENT = "favorites-updated";

// Classify a favorites persistence error for observability. Returns name +
// message only — never the error object/stack, which can leak track data.
function classifyFavoriteError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message}`;
}

// Propagates read failures to the caller (no catch-all): a swallowed error
// resolving [] made the LikedSongs screen show "No liked songs yet" after a
// DB failure as if the user had nothing saved.
export async function getFavorites(): Promise<Track[]> {
  const email = getCurrentUserEmail();
  const favs = await db.favorites.where("userEmail").equals(email).toArray();
  // Sort descending by createdAt to simulate unshift
  return favs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function addFavorite(track: Track): Promise<void> {
  try {
    const email = getCurrentUserEmail();
    await db.transaction("rw", db.favorites, async () => {
      // Compound PK [userEmail+id] (schema v7): guard must not see another
      // user's favorite of the same track as "already exists".
      const existing = await db.favorites.get([email, track.id]);
      if (!existing) {
        await db.favorites.put({
          ...track,
          userEmail: email,
          createdAt: Date.now(),
        });
        window.dispatchEvent(new CustomEvent(FAVORITES_UPDATED_EVENT));
      }
    });
  } catch (e: unknown) {
    await captureError({
      level: "error",
      source: FAV_MODULE,
      message: `add-failed: ${classifyFavoriteError(e)}`,
    });
    showErrorToast(i18n.t("liked_songs.add_failed"));
  }
}

export async function removeFavorite(trackId: string): Promise<void> {
  try {
    // Compound PK [userEmail+id] (schema v7): delete only this user's row,
    // never another user's favorite of the same track.
    const email = getCurrentUserEmail();
    await db.favorites.delete([email, trackId]);
    window.dispatchEvent(new CustomEvent(FAVORITES_UPDATED_EVENT));
  } catch (e: unknown) {
    await captureError({
      level: "error",
      source: FAV_MODULE,
      message: `remove-failed: ${classifyFavoriteError(e)}`,
    });
    showErrorToast(i18n.t("liked_songs.remove_failed"));
  }
}

export async function isFavorite(trackId: string): Promise<boolean> {
  try {
    // Compound PK [userEmail+id] (schema v7): must not report another user's
    // favorite of the same track as liked by the current user.
    const email = getCurrentUserEmail();
    const fav = await db.favorites.get([email, trackId]);
    return !!fav;
  } catch (e: unknown) {
    await captureError({
      level: "warn",
      source: FAV_MODULE,
      message: `is-fav-failed: ${classifyFavoriteError(e)}`,
    });
    return false;
  }
}
