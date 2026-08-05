import { useCallback, useEffect, useRef, useState } from "react";
import { Heart, Maximize2, Music } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MoreMenu } from "../components/MoreMenu";
import { isFavorite, addFavorite, removeFavorite } from "../../utils/favorites";
import { captureError } from "../../utils/errorLog";
import type { Track } from "../../types";

const PLAYER_BAR_MODULE = "PlayerBar";

export interface TrackInfoProps {
  currentTrack: Track | null;
  onExpandNowPlaying: () => void;
}

export function TrackInfo({
  currentTrack,
  onExpandNowPlaying,
}: TrackInfoProps) {
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
  useEffect(() => {
    const handleFavoritesUpdated = () => {
      if (!currentTrack) return;
      void checkFavorite(currentTrack.id, () => false);
    };
    window.addEventListener("favorites-updated", handleFavoritesUpdated);
    return () => {
      window.removeEventListener("favorites-updated", handleFavoritesUpdated);
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

  const realTitle = currentTrack?.title || t("player.no_track");
  const realArtist = currentTrack?.artist || t("unknown_artist");

  return (
    <div className="flex items-center w-[30%] min-w-[140px] sm:min-w-[180px] justify-start pr-2">
      <div
        role="button"
        tabIndex={0}
        className="flex items-center gap-2 sm:gap-4 cursor-pointer group py-1.5 pl-1.5 pr-2 sm:pr-4 -ml-1.5 rounded-xl hover:bg-gray-100 dark:hover:bg-[#2a2b2f] transition-colors min-w-0 flex-1 max-w-[320px]"
        onClick={() => {
          if (currentTrack) onExpandNowPlaying();
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && currentTrack) {
            e.preventDefault();
            onExpandNowPlaying();
          }
        }}
        title={t("player.view_now_playing")}
      >
        <div
          className={`relative w-12 h-12 rounded-lg shrink-0 transition-colors flex items-center justify-center overflow-hidden bg-gray-200 dark:bg-[#121212] text-gray-400`}
        >
          {currentTrack ? (
            <Music className="w-6 h-6 opacity-80 transition-transform duration-300 group-hover:scale-110" />
          ) : null}
          {currentTrack && (
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity duration-200">
              <Maximize2 className="w-5 h-5 text-white" />
            </div>
          )}
        </div>
        <div className="overflow-hidden flex-1">
          <h4 className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate group-hover:text-[#4285F4] transition-colors">
            {realTitle}
          </h4>
          <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis">
            <span className="truncate">{currentTrack ? realArtist : ""}</span>
          </p>
        </div>
      </div>
      {currentTrack && (
        <div className="hidden lg:flex items-center gap-1 shrink-0 ml-2">
          <button
            type="button"
            onClick={() => {
              void handleToggleFavorite();
            }}
            aria-label={
              isLiked ? t("player.remove_favorite") : t("player.add_favorite")
            }
            className={`transition-all duration-200 hover:scale-110 p-1 ${isLiked ? "text-[#4285F4]" : "text-gray-400 hover:text-gray-900 dark:hover:text-white"}`}
          >
            <Heart
              className="w-5 h-5"
              fill={isLiked ? "currentColor" : "none"}
            />
          </button>
          <MoreMenu track={currentTrack} isPlayerBarMode={true} />
        </div>
      )}
    </div>
  );
}
