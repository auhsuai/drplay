import { useCallback, useEffect, useRef, useState } from "react";
import { Heart, Maximize2, Music } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MoreMenu } from "../components/MoreMenu";
import { isFavorite, addFavorite, removeFavorite } from "../../utils/favorites";
import { V_PLACEHOLDER, UNKNOWN_ARTIST } from "../../utils/metadata";
import type { CachedMetadata } from "../../utils/metadata";
import { useAuthStore } from "../../store/authStore";
import { usePlayerStore } from "../../store/playerStore";
import { captureError } from "../../utils/errorLog";
import { useTrackMetadata } from "../../hooks/useTrackMetadata";
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
  const coverImgRef = useRef<HTMLImageElement>(null);
  // Parsed tags shown in the bar. PlayerBar is memoized with a comparator that
  // treats two tracks with the same id as equal, so a store-side title/artist
  // update (new object, same id) never reaches this component through the
  // props. TrackInfo therefore owns its own enriched display values: they
  // fall back to the currentTrack prop until real metadata arrives, then the
  // local state drives the text (store updates still go out for the
  // media-session / now-playing consumers).
  const [displayTitle, setDisplayTitle] = useState<string | null>(null);
  const [displayArtist, setDisplayArtist] = useState<string | null>(null);

  // The player bar displays tags straight off the store's currentTrack, but
  // several play sources hand over a track before its tags exist (HomeTab
  // recently-added plays title=filename/artist="", search hits, session
  // restore) — the fetched metadata was only ever used for the cover. Once a
  // REAL entry (v < V_PLACEHOLDER) arrives, fold the parsed title/artist into
  // the store (same updater pattern usePlayer uses for restoreDuration) so
  // the bar (and useMediaSession, which reads the store) shows the real tags.
  // Guards: a placeholder entry (filename title, "Unknown Artist") never
  // writes; the updater returns prev unchanged when nothing actually differs,
  // so a store update cannot retrigger this effect into a loop.
  const applyMetadataTags = useCallback((metadata: CachedMetadata) => {
    // A real entry always carries its cache version (8) — placeholder entries
    // carry V_PLACEHOLDER (9) and must not touch the display or the store. A
    // non-numeric v (undefined in some tests) is equally untrusted: comparing
    // `undefined >= V_PLACEHOLDER` is false, which would wrongly apply.
    if (typeof metadata.v !== "number" || metadata.v >= V_PLACEHOLDER) return;
    // Enrich the local display first — the memoized PlayerBar never passes a
    // same-id store update down as a prop (see the state comment above), so
    // this local state is what actually repaints the bar. React bails out on
    // equal values, so a repeat call is a no-op render-wise.
    if (metadata.title) setDisplayTitle(metadata.title);
    if (metadata.artist && metadata.artist !== UNKNOWN_ARTIST) {
      setDisplayArtist(metadata.artist);
    }
    usePlayerStore.getState().setCurrentTrack((prev) => {
      if (!prev) return prev;
      const title =
        metadata.title && metadata.title !== prev.title
          ? metadata.title
          : prev.title;
      const artist =
        metadata.artist &&
        metadata.artist !== UNKNOWN_ARTIST &&
        metadata.artist !== prev.artist
          ? metadata.artist
          : prev.artist;
      if (title === prev.title && artist === prev.artist) return prev;
      return { ...prev, title, artist };
    });
  }, []);

  // Cover: fetch metadata once per track (no debounce — only one track plays)
  // and render the FULL (≤1000px) picture when present, thumb as fallback
  // (parity with useNowPlayingMetadata and the cards). No picture keeps the
  // Music icon. The track box carries no token prop, so it reads the store
  // (the login gate mounts the player only after auth, so the token is
  // already set by the time the first track renders).
  const authToken = useAuthStore.getState().accessToken;
  const onCoverError = useCallback(
    (error: unknown) => {
      // onError only fires while the fetch effect is enabled, i.e. when
      // currentTrack is non-null — the ?? "" keeps the template literal
      // lint-clean without ever changing the reachable message.
      const trackId = currentTrack?.id ?? "";
      void captureError({
        level: "warn",
        source: PLAYER_BAR_MODULE,
        message: `cover-metadata-failed (trackId=${trackId}): ${error instanceof Error ? error.message : String(error)}`,
      });
    },
    [currentTrack?.id],
  );

  const { coverUrl, setCoverUrl } = useTrackMetadata({
    fileId: currentTrack?.id ?? null,
    token: authToken,
    size: currentTrack?.size,
    originalName: currentTrack?.originalName,
    enabled: !!currentTrack && !!authToken,
    imgRef: coverImgRef,
    onMetadata: applyMetadataTags,
    onError: onCoverError,
  });

  // Reset the liked flag when the track goes away (the heart only renders
  // while a track exists, so this is a defensive reset on the null track).
  // Done during render (React "adjusting state during render" pattern) so no
  // setState happens synchronously inside an effect.
  const prevTrackIdRef = useRef<string | undefined>(undefined);
  if (currentTrack?.id !== prevTrackIdRef.current) {
    prevTrackIdRef.current = currentTrack?.id;
    if (!currentTrack && isLiked) setIsLiked(false);
    // A new track must never show the previous one's cover even for a frame:
    // the cover effect below re-fetches it asynchronously.
    setCoverUrl(null);
    // Drop the previous track's parsed tags; the display falls back to the
    // new track's prop values until its own metadata arrives.
    setDisplayTitle(null);
    setDisplayArtist(null);
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

  const realTitle =
    (displayTitle ?? currentTrack?.title) || t("player.no_track");
  const realArtist =
    (displayArtist ?? currentTrack?.artist) || t("unknown_artist");

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
          {currentTrack && coverUrl ? (
            <img
              ref={coverImgRef}
              src={coverUrl}
              alt={realTitle}
              onError={() => {
                // The src is already a blob URL built from the picture
                // bytes — an error here means those bytes are corrupt, so
                // drop to the Music icon (no retry chain exists anymore).
                setCoverUrl(null);
              }}
              className="w-full h-full object-cover"
            />
          ) : currentTrack ? (
            <Music className="w-6 h-6 opacity-80 transition-transform duration-300 group-hover:scale-110" />
          ) : null}
          {currentTrack && (
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity duration-200">
              <Maximize2 className="w-5 h-5 text-white" />
            </div>
          )}
        </div>
        <div className="overflow-hidden flex-1">
          <h4 className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate group-hover:text-brand-primary transition-colors">
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
            className={`transition-all duration-200 hover:scale-110 p-1 ${isLiked ? "text-brand-primary" : "text-gray-400 hover:text-gray-900 dark:hover:text-white"}`}
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
