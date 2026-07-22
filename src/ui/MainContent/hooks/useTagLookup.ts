import React, { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { captureError } from "../../../utils/errorLog";
import type { DriveItem } from "../../../App";
import type { DbTagMetadata } from "../components/SongCard";

interface UseTagLookupParams {
  currentItems: DriveItem[];
}

export function useTagLookup({ currentItems }: UseTagLookupParams) {
  const tagMetadataRef = useRef<Map<string, DbTagMetadata>>(new Map());
  const tagLookupAttemptedRef = useRef<Set<string>>(new Set());
  const [, forceTagRerender] = React.useState(0);

  React.useEffect(() => {
    const trackItems = currentItems.filter(
      (item) => !item.isFolder && item.trackInfo?.id && !tagLookupAttemptedRef.current.has(item.trackInfo.id)
    );
    if (trackItems.length === 0) return;

    let cancelled = false;
    const items = trackItems.map(item => ({
      id: item.trackInfo!.id,
      size: item.trackInfo!.size ?? 0,
      name: item.trackInfo!.originalName ?? 'audio.mp3',
    }));
    // Cache both hits and misses.
    items.forEach(({ id }) => tagLookupAttemptedRef.current.add(id));

    const invokeStartedAt = performance.now();
    invoke<Record<string, { title?: string; artist?: string; duration?: number }>>(
      'get_local_metadata_batch',
      { items }
    ).then(results => {
      const roundTripMs = Math.round(performance.now() - invokeStartedAt);
      const matchedCount = Object.values(results).filter(r => r?.title).length;
      if (roundTripMs > 150) {
        captureError({
          level: 'warn',
          source: 'MainContent/tag-lookup-batch',
          message: `get_local_metadata_batch round-trip took ${roundTripMs}ms for ${items.length} item(s) (${matchedCount} matched)`,
          kind: 'slow-ipc-roundtrip',
        });
      }
      let gotAny = false;
      for (const [id, data] of Object.entries(results)) {
        if (data?.title) {
          tagMetadataRef.current.set(id, {
            title: data.title,
            artist: data.artist || '',
            duration: data.duration || 0,
          });
          gotAny = true;
        }
      }
      if (gotAny && !cancelled) forceTagRerender(n => n + 1);
    }).catch(e => {
      items.forEach(({ id }) => tagLookupAttemptedRef.current.delete(id));
      console.warn('[MainContent] tag-lookup-batch-failed', { count: items.length, error: String(e) });
    });

    return () => { cancelled = true; };
  }, [currentItems]);

  return { tagMetadataRef };
}
