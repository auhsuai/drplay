import type { Track } from "../types";
import { db } from "../db/db";
import { showErrorToast } from "./simpleToast";
import { captureError } from "./errorLog";
import { DEFAULT_USER_EMAIL, getCurrentUserEmail } from "./storageKeys";
import i18n from "../i18n";

const FAV_MODULE = "favorites";

// Timing hazard (same window as proSyncManager.resolveWireUserEmail):
// USER_EMAIL_KEY lands only AFTER the best-effort userinfo fetch resolves and
// is removed on logout, so reads/writes during that window would hit the
// shared "default" bucket — the exact cross-account leak schema v7's
// [userEmail+id] key exists to prevent. Refuse the sentinel: reads return
// empty, writes are dropped (warn + user-visible toast).
function resolveRealUserEmail(): string | null {
  const email = getCurrentUserEmail();
  if (!email || email === DEFAULT_USER_EMAIL) return null;
  return email;
}

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

export async function getFavorites(): Promise<Track[]> {
  const email = resolveRealUserEmail();
  if (!email) {
    await captureError({
      level: "warn",
      source: FAV_MODULE,
      message: "get-skipped-no-email",
    });
    return [];
  }
  try {
    const favs = await db.favorites.where("userEmail").equals(email).toArray();
    // Sort descending by createdAt to simulate unshift
    return favs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch (e: unknown) {
    await captureError({
      level: "error",
      source: FAV_MODULE,
      message: `get-failed: ${classifyFavoriteError(e)}`,
    });
    return [];
  }
}

export async function addFavorite(track: Track): Promise<void> {
  const email = resolveRealUserEmail();
  if (!email) {
    await captureError({
      level: "warn",
      source: FAV_MODULE,
      message: "add-skipped-no-email",
    });
    showErrorToast(i18n.t("liked_songs.add_failed"));
    return;
  }
  try {
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
  const email = resolveRealUserEmail();
  if (!email) {
    await captureError({
      level: "warn",
      source: FAV_MODULE,
      message: "remove-skipped-no-email",
    });
    showErrorToast(i18n.t("liked_songs.remove_failed"));
    return;
  }
  try {
    // Compound PK [userEmail+id] (schema v7): delete only this user's row,
    // never another user's favorite of the same track.
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
  const email = resolveRealUserEmail();
  // No real email yet -> nothing can be favorited by this user. No captureError
  // here: pre-login a song grid calls this once per card, so a log would spam.
  if (!email) return false;
  try {
    // Compound PK [userEmail+id] (schema v7): must not report another user's
    // favorite of the same track as liked by the current user.
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
