import { useCallback, useEffect, useRef, useState } from "react";
import { Heart } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  isFavorite,
  addFavorite,
  removeFavorite,
  FAVORITES_UPDATED_EVENT,
} from "../../utils/favorites";
import { captureError } from "../../utils/errorLog";
import type { Track } from "../../types";

const PLAYER_BAR_MODULE = "PlayerBar";

export interface LikeButtonProps {
  currentTrack: Track | null;
}

export function LikeButton({ currentTrack }: LikeButtonProps) {
  const { t } = useTranslation();
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
  // F3 fix: same cancelled-guard as the track-change effect above — an event
  // fired for track A can still be in flight when the user moves to track B;
  // without the guard its response lands on B and shows the WRONG liked
  // state (the fixed `() => false` stale-check applied A's result to B).
  useEffect(() => {
    let cancelled = false;
    const handleFavoritesUpdated = () => {
      if (!currentTrack) return;
      void checkFavorite(currentTrack.id, () => cancelled);
    };
    window.addEventListener(FAVORITES_UPDATED_EVENT, handleFavoritesUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(
        FAVORITES_UPDATED_EVENT,
        handleFavoritesUpdated,
      );
    };
  }, [currentTrack, checkFavorite]);

  const isFavoriteTogglingRef = useRef(false);
  const handleToggleFavorite = async () => {
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

  if (!currentTrack) return null;

  return (
    <button
      type="button"
      onClick={() => {
        void handleToggleFavorite();
      }}
      aria-label={
        isLiked ? t("player.remove_favorite") : t("player.add_favorite")
      }
      className={`transition-all duration-200 hover:scale-110 p-1 ${isLiked ? "text-brand-text" : "text-gray-400 hover:text-gray-900 dark:hover:text-white"}`}
    >
      <Heart className="w-6 h-6" fill={isLiked ? "currentColor" : "none"} />
    </button>
  );
}
