import { useCallback, useState } from "react";
import type { RefObject } from "react";
import type { DriveItem } from "../../../types";
import type { CachedMetadata } from "../../../utils/metadata";
import { captureError } from "../../../utils/errorLog";
import {
  useTrackMetadata,
  TRACK_METADATA_DEBOUNCE_MS,
} from "../../../hooks/useTrackMetadata";

const SONG_CARD_MODULE = "SongCard";

type SongCardMeta = {
  title: string;
  artist: string | null;
  duration: number;
  durationEstimated: boolean;
  size: number;
  loaded: boolean;
};

/**
 * SongCard-specific adapter over the shared useTrackMetadata lifecycle:
 * keeps the card-facing API (meta + coverUrl + clearCover) and the card-only
 * behaviors — isFolder guard, 150ms debounce, metadata-updated re-fetch and
 * the per-field setMeta equality check.
 */
export function useSongCardMetadata({
  item,
  token,
  imgRef,
}: {
  item: DriveItem;
  token?: string | null | undefined;
  imgRef: RefObject<HTMLImageElement | null>;
}): {
  meta: SongCardMeta;
  coverUrl: string | null;
  clearCover: () => void;
} {
  // loaded=true only after getTrackMetadata resolves, so the meta row (duration
  // • size) appears only for real metadata — the old size>0 guard also hid
  // legitimate 0-byte files, which must show "0 B" (formatBytes semantics).
  const [meta, setMeta] = useState<SongCardMeta>({
    title: item.title,
    artist: null,
    duration: 0,
    durationEstimated: false,
    size: 0,
    loaded: false,
  });

  const onMetadata = useCallback(
    (metadata: CachedMetadata) => {
      const newMeta: SongCardMeta = {
        title: metadata.title || item.title,
        artist: metadata.artist || null,
        duration: metadata.duration || 0,
        durationEstimated: metadata.durationEstimated,
        // Old cached placeholders (pre-fix) carry no size — fall back to
        // the Drive listing size so a failed metadata fetch never shows
        // "0 B" next to real sizes (a true 0-byte file keeps "0 B": ?? only
        // falls back on null/undefined, not on a real 0).
        size: metadata.size ?? item.trackInfo?.size ?? 0,
        loaded: true,
      };
      setMeta((prev) => {
        if (
          newMeta.title === prev.title &&
          newMeta.artist === prev.artist &&
          newMeta.duration === prev.duration &&
          newMeta.durationEstimated === prev.durationEstimated &&
          newMeta.size === prev.size &&
          newMeta.loaded === prev.loaded
        ) {
          return prev;
        }
        return newMeta;
      });
    },
    [item.title, item.trackInfo?.size],
  );

  const onError = useCallback(
    (error: unknown) => {
      void captureError({
        level: "warn",
        source: SONG_CARD_MODULE,
        message: `metadata-load-failed (fileId=${item.id}): ${error instanceof Error ? error.message : String(error)}`,
      });
    },
    [item.id],
  );

  const { coverUrl, setCoverUrl } = useTrackMetadata({
    fileId: item.id,
    token,
    size: item.trackInfo?.size,
    originalName: item.trackInfo?.originalName,
    enabled: !item.isFolder && !!token,
    debounceMs: TRACK_METADATA_DEBOUNCE_MS,
    listenMetadataUpdated: true,
    imgRef,
    thumbnailUrl: item.thumbnailLink,
    onMetadata,
    onError,
  });

  const clearCover = useCallback(() => {
    setCoverUrl(null);
  }, [setCoverUrl]);

  return { meta, coverUrl, clearCover };
}
