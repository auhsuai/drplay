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
  artist: string | null;
  duration: number;
  durationEstimated: boolean;
  loaded: boolean;
};

/**
 * SongCard-specific adapter over the shared useTrackMetadata lifecycle:
 * keeps the card-facing API (meta + coverUrl + clearCover) and the card-only
 * behaviors — isFolder guard, 150ms debounce and the per-field setMeta
 * equality check.
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
  // loaded=true only after getTrackMetadata resolves, so the duration span
  // appears only for real metadata. (Size and title used to ride along here —
  // size moved to the dedicated Size column in SongCard, and the displayed
  // name is now the Drive filename (trackInfo.originalName), so the ID3 title
  // no longer drives the h3 and this hook no longer tracks it.)
  const [meta, setMeta] = useState<SongCardMeta>({
    artist: null,
    duration: 0,
    durationEstimated: false,
    loaded: false,
  });

  const onMetadata = useCallback(
    (metadata: CachedMetadata) => {
      const newMeta: SongCardMeta = {
        artist: metadata.artist || null,
        duration: metadata.duration || 0,
        durationEstimated: metadata.durationEstimated,
        loaded: true,
      };
      setMeta((prev) => {
        if (
          newMeta.artist === prev.artist &&
          newMeta.duration === prev.duration &&
          newMeta.durationEstimated === prev.durationEstimated &&
          newMeta.loaded === prev.loaded
        ) {
          return prev;
        }
        return newMeta;
      });
    },
    // Deliberately no [item.title]: nothing in this hook reads the title
    // anymore, and SongCard's display name comes from the listing item.
    [],
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
    imgRef,
    onMetadata,
    onError,
  });

  const clearCover = useCallback(() => {
    setCoverUrl(null);
  }, [setCoverUrl]);

  return { meta, coverUrl, clearCover };
}
