import { useEffect, useRef } from 'react';
import { invoke } from "@tauri-apps/api/core";
import { DriveItem } from "../App";
import { cachePrefetchedStream } from "../utils/streamPrefetcher";
import { cacheTrackMetadata } from "../utils/metadata";

export function useCoverPrefetch(currentItems: DriveItem[]) {
  const coverUrlsRef = useRef<Map<string, string>>(new Map());
  const predecodedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const trackIds = currentItems
      .filter(i => !i.isFolder && i.trackInfo?.id && !coverUrlsRef.current.has(i.trackInfo.id))
      .map(i => i.trackInfo!.id);
    if (trackIds.length === 0) return;
    
    performance.mark('cover-batch-start');
    const controller = new AbortController();

    async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
      const executing = new Set<Promise<void>>();
      for (const item of items) {
        if (controller.signal.aborted) break;
        const p = fn(item).finally(() => executing.delete(p));
        executing.add(p);
        if (executing.size >= limit) {
          await Promise.race(executing);
        }
      }
      await Promise.allSettled(executing);
    }

    const trackItems = trackIds.map(id => currentItems.find(i => i.trackInfo?.id === id)).filter(Boolean) as typeof currentItems;
    
    runWithConcurrency(trackItems, 6, async (item) => {
      const id = item.trackInfo!.id;
      try {
        const data = await invoke<any>('get_track_data', {
          fileId: id,
          size: item.trackInfo!.size ?? 0,
          name: item.trackInfo!.originalName ?? 'audio.mp3',
        });
        if (controller.signal.aborted) return;
        if (data?.stream_url) {
          cachePrefetchedStream(id, data.stream_url);
        }
        if (data?.metadata?.id) {
          const m = data.metadata;
          cacheTrackMetadata(id, {
            title: m.title || item.trackInfo!.title,
            artist: m.artist || 'Unknown Artist',
            duration: m.duration || 0,
            durationEstimated: !m.duration,
            pictureData: null,
            pictureDataFull: null,
            dbId: m.id,
            coverUrl: m.has_cover ? `http://drplay.localhost/cover?id=${m.id}&thumb=true&v=2` : undefined,
            size: item.trackInfo!.size ?? 0,
            v: 10,
          });
        }
        if (!data?.metadata?.has_cover || !data?.metadata?.id) return;
        const url = coverUrlsRef.current.get(id) || `http://drplay.localhost/cover?id=${data.metadata.id}&thumb=true&v=2`;
        coverUrlsRef.current.set(id, url);
        if (!predecodedRef.current.has(url)) {
          predecodedRef.current.add(url);
          const img = new Image();
          img.decoding = 'async';
          img.src = url;
          img.decode().catch(() => {});
        }
      } catch (e) {
        console.warn('[CoverPrefetch] fetch-failed', { fileId: id, error: String(e) });
      }
    }).catch(() => {});
    
    performance.mark('cover-batch-end');
    performance.measure('cover-batch', 'cover-batch-start', 'cover-batch-end');

    return () => controller.abort();
  }, [currentItems]);

  return coverUrlsRef;
}
