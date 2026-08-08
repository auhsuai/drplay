import { useState, useEffect, useRef } from "react";
import type { Track } from "../../../App";
import { getTrackMetadata } from "../../../utils/metadata";
import { buildCoverBlobUrl } from "../../../utils/coverStore";
import { Play, Music, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { captureError } from "../../../utils/errorLog";

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
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const fillColor = getFillColor(track.id);
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const { t } = useTranslation();

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let isMounted = true;
    // The cleanup touches the img element; capture it at setup so the
    // cleanup never reads the (possibly stale) ref.
    const imgElement = imgRef.current;
    getTrackMetadata(
      track.id,
      token,
      track.size,
      track.originalName,
      controller.signal,
    )
      .then((meta) => {
        if (!isMounted) return;
        if (meta.title) setTitle(meta.title);
        if (meta.artist) setArtist(meta.artist);
        // Fix G: Chromium/WebView2 rejects the drplay:// custom scheme at the
        // network stack (ERR_UNKNOWN_URL_SCHEME) before the Rust handler can
        // respond, so the cover renders straight from a blob URL built with
        // the thumb bytes metadata already parsed. A 204/error drops to the
        // icon through the img onError below.
        setCoverUrl(
          meta.pictureData
            ? buildCoverBlobUrl(meta.pictureData, meta.pictureFormat)
            : null,
        );
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return; // deliberate cleanup abort — not an error
        void captureError({
          level: "warn",
          source: PREMIUM_CARD_MODULE,
          message: `metadata-load-failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
    return () => {
      isMounted = false;
      controller.abort();
      if (imgElement) imgElement.src = "";
    };
  }, [track.id, token, track.size, track.originalName]);

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
              <MoreHorizontal className="w-5 h-5" /> {t("view_all")}
            </span>
          </div>
        ) : (
          <div className="absolute bottom-3 right-3 w-11 h-11 bg-[#4285F4] hover:bg-[#3367d6] text-white rounded-full flex items-center justify-center shadow-lg shadow-black/20 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-300 hover:scale-105">
            <Play className="w-5 h-5 ml-1" fill="currentColor" />
          </div>
        )}
      </div>
      {!isOverlayBtn && (
        <div className="px-1">
          <h4 className="font-semibold text-gray-900 dark:text-gray-100 truncate text-sm mb-1">
            {title}
          </h4>
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {artist || t("unknown_artist")}
          </p>
        </div>
      )}
    </div>
  );
}
