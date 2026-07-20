import { useEffect, useRef, useState } from 'react';
import { getTrackMetadata } from '../utils/metadata';

export const PREFETCH_MARGIN_SLOW = 3;

const COVER_MODULE = 'useCoverWindowing';

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

    for (const item of items) {
      if (!item || item.isFolder) continue;

      const current = coversRef.current.get(item.id);
      if (current !== undefined) continue;

      const controller = abortFor(item.id);
      const signal = controller.signal;

      getTrackMetadata(
        item.id,
        token,
        item.trackInfo?.size,
        item.trackInfo?.originalName,
        signal,
      )
        .then((metadata) => {
          if (generation !== generationRef.current) return;
          if (signal.aborted) return;
          inFlightAbortRef.current.delete(item.id);
          let url: string | null = null;
          if (metadata.coverUrl) {
            url = metadata.coverUrl;
          } else if (metadata.pictureData && metadata.pictureFormat) {
            const existingBlob = blobUrlsRef.current.get(item.id);
            if (existingBlob) URL.revokeObjectURL(existingBlob);
            const blob = new Blob([new Uint8Array(metadata.pictureData)], { type: metadata.pictureFormat });
            url = URL.createObjectURL(blob);
            blobUrlsRef.current.set(item.id, url);
          }
          setCovers((prev) => {
            const next = new Map(prev);
            next.set(item.id, url);
            return next;
          });
        })
        .catch((err) => {
          if (generation !== generationRef.current) return;
          if (signal.aborted) return;
          inFlightAbortRef.current.delete(item.id);
          const { name, message } = classifyCoverError(err);
          console.warn(
            `[${COVER_MODULE}] cover-fetch-failed`, { id: item.id, name, message },
          );
          setCovers((prev) => {
            const next = new Map(prev);
            next.set(item.id, null);
            return next;
          });
        });
    }

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
    return () => {
      controllers.forEach((c) => c.abort());
      controllers.clear();
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current.clear();
    };
  }, []);

  return covers;
}
