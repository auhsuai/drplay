import { useEffect, useRef, useState } from 'react';
import { getTrackMetadata } from '../utils/metadata';
import { runWithConcurrencyLimit } from '../utils/streamPrefetcher';

export const PREFETCH_MARGIN_SLOW = 3;

const COVER_MODULE = 'useCoverWindowing';
const COVER_CONCURRENCY = 5;
const BLOB_URL_CAP = 50;

export interface CoverWindowItem {
  id: string;
  isFolder?: boolean;
  trackInfo?: { size?: number; originalName?: string };
}

export interface UseCoverWindowingArgs {
  items: CoverWindowItem[];
  token: string | null;
}

function classifyCoverError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: 'UnknownError', message: String(err) };
}

export function useCoverWindowing({
  items,
  token,
}: UseCoverWindowingArgs): Map<string, string | null> {
  const [covers, setCovers] = useState<Map<string, string | null>>(new Map());
  const generationRef = useRef(0);
  const inFlightAbortRef = useRef<Map<string, AbortController>>(new Map());
  const blobUrlsRef = useRef<Map<string, string>>(new Map());
  const coversRef = useRef(covers);
  coversRef.current = covers;

  useEffect(() => {
    const generation = ++generationRef.current;

    if (!items || items.length === 0) {
      if (coversRef.current.size !== 0) setCovers(new Map());
      return;
    }

    if (!token) {
      if (coversRef.current.size !== 0) setCovers(new Map());
      return;
    }

    const abortFor = (id: string): AbortController => {
      const existing = inFlightAbortRef.current.get(id);
      if (existing) existing.abort();
      const controller = new AbortController();
      inFlightAbortRef.current.set(id, controller);
      return controller;
    };

    // LRU touch/insert into blobUrlsRef with a bounded cap. When the cap is
    // exceeded, the oldest entry is evicted and its object URL revoked so we
    // never leak object URLs (blobUrlsRef used to grow unbounded).
    const setBlobUrl = (id: string, url: string): void => {
      const map = blobUrlsRef.current;
      const prevUrl = map.get(id);
      if (prevUrl) {
        // Same id being refreshed: revoke the stale URL first.
        URL.revokeObjectURL(prevUrl);
        map.delete(id);
      }
      map.set(id, url);
      while (map.size > BLOB_URL_CAP) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        const oldestUrl = map.get(oldest);
        map.delete(oldest);
        if (oldestUrl) URL.revokeObjectURL(oldestUrl);
      }
    };

    // Only fetch items not already resolved (current === undefined), skipping
    // folders. Snapshot the pending set now so the concurrency loop is stable.
    const pending = items.filter((item) => {
      if (!item || item.isFolder) return false;
      return coversRef.current.get(item.id) === undefined;
    });

    if (pending.length === 0) {
      return () => {
        for (const item of items) {
          const controller = inFlightAbortRef.current.get(item.id);
          if (controller && !controller.signal.aborted) {
            controller.abort();
            inFlightAbortRef.current.delete(item.id);
          }
        }
      };
    }

    // Resolved results are collected here and flushed to state ONCE after all
    // fetches settle, instead of one setState (and one O(n) Map copy) per item.
    const resolved = new Map<string, string | null>();

    const fetchOne = async (item: CoverWindowItem): Promise<void> => {
      const controller = abortFor(item.id);
      const signal = controller.signal;

      try {
        const metadata = await getTrackMetadata(
          item.id,
          token,
          item.trackInfo?.size,
          item.trackInfo?.originalName,
          signal,
        );

        if (generation !== generationRef.current) return;
        if (signal.aborted) return;
        inFlightAbortRef.current.delete(item.id);

        let url: string | null = null;
        if (metadata.coverUrl) {
          url = metadata.coverUrl;
        } else if (metadata.pictureData && metadata.pictureFormat) {
          const blob = new Blob(
            [new Uint8Array(metadata.pictureData)],
            { type: metadata.pictureFormat },
          );
          url = URL.createObjectURL(blob);
          setBlobUrl(item.id, url);
        }
        resolved.set(item.id, url);
      } catch (err) {
        if (generation !== generationRef.current) return;
        if (signal.aborted) return;
        inFlightAbortRef.current.delete(item.id);
        const { name, message } = classifyCoverError(err);
        console.warn(
          `[${COVER_MODULE}] cover-fetch-failed`, { id: item.id, name, message },
        );
        resolved.set(item.id, null);
      }
    };

    // runWithConcurrencyLimit already uses Promise.allSettled internally, so a
    // single fetchOne throwing cannot reject the batch. Guard the flush again
    // in case the returned promise ever rejects.
    runWithConcurrencyLimit(pending, COVER_CONCURRENCY, fetchOne)
      .then(() => {
        if (generation !== generationRef.current) return;
        if (resolved.size === 0) return;
        setCovers((prev) => {
          const next = new Map(prev);
          for (const [id, url] of resolved) next.set(id, url);
          return next;
        });
      })
      .catch((err) => {
        const { name, message } = classifyCoverError(err);
        console.warn(
          `[${COVER_MODULE}] cover-batch-failed`, { name, message },
        );
      });

    return () => {
      for (const item of items) {
        const controller = inFlightAbortRef.current.get(item.id);
        if (controller && !controller.signal.aborted) {
          controller.abort();
          inFlightAbortRef.current.delete(item.id);
        }
      }
    };
  }, [items, token]);

  useEffect(() => {
    const controllers = inFlightAbortRef.current;
    const blobUrls = blobUrlsRef.current;
    return () => {
      controllers.forEach((c) => c.abort());
      controllers.clear();
      blobUrls.forEach((url) => URL.revokeObjectURL(url));
      blobUrls.clear();
    };
  }, []);

  return covers;
}
