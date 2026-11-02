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
// Mirrors V_PLACEHOLDER (constants.ts). Any v below it is a real parse — the
// same rule searchEngine.isRealCacheEntry uses, so the UI and the search
// index can never disagree about what counts as real metadata.
const V_PLACEHOLDER = 9;

type SongCardMeta = {
  artist: string | null;
  duration: number;
  durationEstimated: boolean;
  /**
   * True only when REAL metadata resolved. A placeholder (v:9 / provisional)
   * still resolves so the card can render the filename — but it is NOT a
   * completed load, so the duration slot must not claim one.
   */
  loaded: boolean;
  /** Explicit lifecycle outcome (undefined for legacy cached rows). */
  outcome: CachedMetadata["outcome"] | undefined;
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
  /** Re-fetch this card in place (no remount); cache hits stay free. */
  retry: () => void;
} {
  const [meta, setMeta] = useState<SongCardMeta>({
    artist: null,
    duration: 0,
    durationEstimated: false,
    loaded: false,
    outcome: undefined,
  });

  const onMetadata = useCallback(
    (metadata: CachedMetadata) => {
      // A placeholder is an entry at/past V_PLACEHOLDER (v:9); every real
      // parse carries v:8. Legacy/partial fixtures without a `v` are treated
      // as real (the previous behavior), since only the placeholder marker
      // means "this is not usable metadata".
      const isPlaceholder =
        typeof metadata.v === "number" && metadata.v >= V_PLACEHOLDER;
      const newMeta: SongCardMeta = {
        artist: metadata.artist || null,
        duration: metadata.duration || 0,
        durationEstimated: metadata.durationEstimated,
        loaded: !isPlaceholder,
        outcome: metadata.outcome,
      };
      setMeta((prev) => {
        if (
          newMeta.artist === prev.artist &&
          newMeta.duration === prev.duration &&
          newMeta.durationEstimated === prev.durationEstimated &&
          newMeta.loaded === prev.loaded &&
          newMeta.outcome === prev.outcome
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

  const { coverUrl, setCoverUrl, retry } = useTrackMetadata({
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

  return { meta, coverUrl, clearCover, retry };
}
