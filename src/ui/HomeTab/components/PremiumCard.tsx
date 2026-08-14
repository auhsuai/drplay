import { useState, useRef, useCallback } from "react";
import type { Track } from "../../../types";
import type { CachedMetadata } from "../../../utils/metadata";
import { Play, Music, Ellipsis } from "lucide-react";
import { useTranslation } from "react-i18next";
import { captureError } from "../../../utils/errorLog";
import {
  useTrackMetadata,
  TRACK_METADATA_DEBOUNCE_MS,
} from "../../../hooks/useTrackMetadata";
import { IS_MOBILE } from "../../../utils/platform";

const PREMIUM_CARD_MODULE = "PremiumCard";
const GOOGLE_COLORS = ["#4285F4", "#EA4335", "#FBBC05", "#34A853"];
export const getFillColor = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++)
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return GOOGLE_COLORS[Math.abs(hash) % GOOGLE_COLORS.length];
};

export function PremiumCard({
  track,
  onPlay,
  token,
  isOverlayBtn,
}: {
  track: Track;
  onPlay: () => void;
  token: string | null;
  isOverlayBtn?: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const fillColor = getFillColor(track.id);
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const { t } = useTranslation();

  const onMetadata = useCallback((metadata: CachedMetadata) => {
    // Truthy-guard: never overwrite the placeholder title/artist with empty
    // values from a metadata entry that lacks them.
    if (metadata.title) setTitle(metadata.title);
    if (metadata.artist) setArtist(metadata.artist);
  }, []);

  const onError = useCallback((error: unknown) => {
    void captureError({
      level: "warn",
      source: PREMIUM_CARD_MODULE,
      message: `metadata-load-failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }, []);

  const { coverUrl, setCoverUrl } = useTrackMetadata({
    fileId: track.id,
    token,
    size: track.size,
    originalName: track.originalName,
    enabled: !!token,
    // Debounce: scrolling a large library mounts many premium cards at once;
    // fetching metadata for every one immediately queues hundreds of range
    // requests behind the app-wide CONCURRENCY-3 semaphore (the same storm
    // that made metadata loads minutes-long). Fetch only for cards that stay
    // mounted 150ms — mirrors SongCard's debounce.
    debounceMs: TRACK_METADATA_DEBOUNCE_MS,
    imgRef,
    onMetadata,
    onError,
  });

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPlay();
        }
      }}
      className="group cursor-pointer active:scale-[0.98] transition-transform duration-200"
    >
      {/* Task 12: the cover IMAGE is gone on mobile (hook gated — coverUrl is
          always null there, so the tile only ever shows the static placeholder
          glyph; the "View all" overlay keeps working). The artist line is
          metadata-derived and hidden. Desktop untouched. */}
      <div
        style={!coverUrl ? { background: fillColor } : undefined}
        className="w-full aspect-square rounded-2xl mb-4 relative overflow-hidden flex items-center justify-center shadow-sm"
      >
        {coverUrl ? (
          <img
            ref={imgRef}
            src={coverUrl}
            alt={title}
            loading="lazy"
            decoding="async"
            onError={() => {
              setCoverUrl(null);
            }}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
          />
        ) : (
          <Music className="w-12 h-12 text-white opacity-80 group-hover:scale-110 transition-transform duration-700" />
        )}

        {isOverlayBtn ? (
          <div className="absolute inset-0 bg-white/70 dark:bg-black/70 flex items-center justify-center opacity-80 group-hover:opacity-100 transition-opacity">
            <span className="font-bold text-gray-900 dark:text-white text-[15px] flex items-center gap-1">
              <Ellipsis className="w-5 h-5" /> {t("view_all")}
            </span>
          </div>
        ) : (
          <div className="absolute bottom-3 right-3 w-11 h-11 bg-brand-primary hover:bg-brand-hover text-white rounded-full flex items-center justify-center shadow-lg shadow-black/20 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-300 hover:scale-105">
            <Play className="w-5 h-5 ml-1" fill="currentColor" />
          </div>
        )}
      </div>
      {!isOverlayBtn && (
        <div className="px-1">
          <h4 className="font-semibold text-gray-900 dark:text-gray-100 truncate text-sm mb-1">
            {title}
          </h4>
          {!IS_MOBILE && (
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {artist || t("unknown_artist")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
