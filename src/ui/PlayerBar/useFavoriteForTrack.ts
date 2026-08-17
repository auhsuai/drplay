import { useCallback, useEffect, useRef, useState } from "react";
import {
  isFavorite,
  addFavorite,
  removeFavorite,
  FAVORITES_UPDATED_EVENT,
} from "../../utils/favorites";
import { captureError } from "../../utils/errorLog";
import type { Track } from "../../types";

const PLAYER_BAR_MODULE = "PlayerBar";

// Row reorder (2026-08-17): the mobile PlayerBar row puts MoreMenu at PlayerBar
// level (title → -5s/play/+5s → More options), but the favorite state used to
// live inside TrackInfo (which keeps the desktop heart). Extracted verbatim so
// both TrackInfo (desktop heart) and PlayerBar (mobile MoreMenu) share the
// exact same check/toggle logic — no behavior change.
export function useFavoriteForTrack(currentTrack: Track | null) {
  const [isLiked, setIsLiked] = useState(false);

  // Reset the liked flag when the track goes away (the heart only renders
  // while a track exists, so this is a defensive reset on the null track).
  // Done during render (React "adjusting state during render" pattern) so no
  // setState happens synchronously inside an effect.
  const prevTrackIdRef = useRef<string | undefined>(undefined);
  if (currentTrack?.id !== prevTrackIdRef.current) {
    prevTrackIdRef.current = currentTrack?.id;
    if (!currentTrack && isLiked) setIsLiked(false);
  }

  // Shared favorite-status check: re-reads the stored status for a track id
  // and applies it, unless the requesting scope went stale (track changed /
  // component unmounted) while the check was in flight.
  const checkFavorite = useCallback(
    async (trackId: string, isStale: () => boolean) => {
      try {
        const liked = await isFavorite(trackId);
        if (!isStale()) setIsLiked(liked);
      } catch (e: unknown) {
        void captureError({
          level: "warn",
          source: PLAYER_BAR_MODULE,
          message: `check-favorite-failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [],
  );

  // Check favorite status whenever the current track changes
  useEffect(() => {
    if (!currentTrack) return;
    let cancelled = false;
    void (async () => {
      await checkFavorite(currentTrack.id, () => cancelled);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentTrack, checkFavorite]);

  // Re-check the current track when favorites change elsewhere (favorites.ts
  // dispatches `favorites-updated` on add/remove), so the heart never shows a
  // stale state while the same track keeps playing.
  useEffect(() => {
    const handleFavoritesUpdated = () => {
      if (!currentTrack) return;
      void checkFavorite(currentTrack.id, () => false);
    };
    window.addEventListener(FAVORITES_UPDATED_EVENT, handleFavoritesUpdated);
    return () => {
      window.removeEventListener(
        FAVORITES_UPDATED_EVENT,
        handleFavoritesUpdated,
      );
    };
  }, [currentTrack, checkFavorite]);

  const isFavoriteTogglingRef = useRef(false);
  const toggleFavorite = async () => {
    if (!currentTrack || isFavoriteTogglingRef.current) return;
    isFavoriteTogglingRef.current = true;
    try {
      if (isLiked) {
        await removeFavorite(currentTrack.id);
      } else {
        await addFavorite(currentTrack);
      }
      setIsLiked(!isLiked);
    } catch (e: unknown) {
      void captureError({
        level: "error",
        source: PLAYER_BAR_MODULE,
        message: `toggle-favorite-failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      isFavoriteTogglingRef.current = false;
    }
  };

  return { isLiked, toggleFavorite };
}
