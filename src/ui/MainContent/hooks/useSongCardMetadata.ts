import React, { useState } from "react";
import type { DriveItem } from "../../../types";
import { getTrackMetadata } from "../../../utils/metadata";
import { buildCoverBlobUrl } from "../../../utils/coverStore";
import { captureError } from "../../../utils/errorLog";

const SONG_CARD_MODULE = "SongCard";

type SongCardMeta = {
  title: string;
  artist: string | null;
  duration: number;
  durationEstimated: boolean;
  size: number;
  loaded: boolean;
};

export function useSongCardMetadata({
  item,
  token,
  imgRef,
}: {
  item: DriveItem;
  token?: string | null | undefined;
  imgRef: React.RefObject<HTMLImageElement | null>;
}): {
  meta: SongCardMeta;
  coverUrl: string | null;
  clearCover: () => void;
} {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
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

  React.useEffect(() => {
    if (item.isFolder || !token) return;

    const controller = new AbortController();
    let isMounted = true;
    // The metadata effect cleanup touches the img element; capture it at
    // setup so the cleanup never reads the (possibly stale) ref
    // (react-hooks/exhaustive-deps ref-cleanup rule).
    const imgElement = imgRef.current;

    const fetchMetadata = async () => {
      try {
        const metadata = await getTrackMetadata(
          item.id,
          token,
          item.trackInfo?.size,
          item.trackInfo?.originalName,
          controller.signal,
        );
        if (!isMounted) return;
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

        // Fix G: Chromium/WebView2 rejects the drplay:// custom scheme at the
        // network stack (ERR_UNKNOWN_URL_SCHEME) before the Rust handler can
        // respond, so the cover renders straight from a blob URL built with
        // the picture bytes metadata already parsed — no failed <img> cycle
        // and no scheme round-trip. A missing picture keeps the icon.
        // Full (≤1000px) bytes win over the 256px thumb — the grid cards
        // must show the sharp cover, not the blurry placeholder-sized one.
        const coverBytes = metadata.pictureDataFull ?? metadata.pictureData;
        setCoverUrl(
          coverBytes
            ? buildCoverBlobUrl(coverBytes, metadata.pictureFormat)
            : null,
        );
      } catch (e) {
        if (controller.signal.aborted) return; // deliberate cleanup abort — not an error (MDN AbortController)
        void captureError({
          level: "warn",
          source: SONG_CARD_MODULE,
          message: `metadata-load-failed (fileId=${item.id}): ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    };

    const timerId = setTimeout(() => {
      void fetchMetadata();
    }, 150); // Debounce: only fetch if card is visible for 150ms (avoids IPC spam when scrolling fast)

    const handleMetadataUpdated = (e: Event) => {
      // detail is typed | null because a CustomEvent constructed without
      // the detail option defaults to null at runtime.
      const customEvent = e as CustomEvent<{ fileId?: string } | null>;
      if (customEvent.detail?.fileId === item.id) {
        void fetchMetadata();
      }
    };

    window.addEventListener("metadata-updated", handleMetadataUpdated);

    return () => {
      isMounted = false;
      clearTimeout(timerId);
      controller.abort();
      if (imgElement) {
        imgElement.src = "";
      }
      window.removeEventListener("metadata-updated", handleMetadataUpdated);
    };
  }, [
    item.id,
    token,
    item.isFolder,
    item.title,
    item.trackInfo?.originalName,
    item.trackInfo?.size,
  ]);

  const clearCover = () => {
    setCoverUrl(null);
  };

  return { meta, coverUrl, clearCover };
}
