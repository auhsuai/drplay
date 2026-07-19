import { useEffect, useRef, useState } from 'react';
import { getTrackMetadata } from '../utils/metadata';

export const PREFETCH_MARGIN_SLOW = 3;
export const PREFETCH_MARGIN_MED = 6;
export const PREFETCH_MARGIN_FAST = 12;
export const VELOCITY_FAST_THRESHOLD = 100;
export const VELOCITY_MED_THRESHOLD = 40;
export const EVICT_MULTIPLIER = 2;

const COVER_MODULE = 'useCoverWindowing';

export interface CoverWindowItem {
  id: string;
  isFolder?: boolean;
}

export interface CoverWindowRange {
  start: number;
  end: number;
}

export interface UseCoverWindowingArgs {
  items: CoverWindowItem[];
  range: CoverWindowRange;
  token: string | null;
  dynamicMargin?: number;
}

function classifyCoverError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: 'UnknownError', message: String(err) };
}

/**
 * Windowed cover prefetch with scroll-velocity adaptive margin.
 *
 * - Prefetch window = visible range ± margin (margin from velocity hook).
 * - Evict window = visible range ± margin * EVICT_MULTIPLIER. Rows outside
 *   the evict window get their entry set to `null` (keep key, drop url) so the
 *   Map still reports "don't fetch" rather than "loading".
 * - Map value semantics: string = ready url, null = explicitly empty (folder
 *   / error / evicted), undefined (missing key) = still loading.
 */
export function useCoverWindowing({
  items,
  range,
  token,
  dynamicMargin = PREFETCH_MARGIN_SLOW,
}: UseCoverWindowingArgs): Map<string, string | null> {
  const [covers, setCovers] = useState<Map<string, string | null>>(new Map());
  const generationRef = useRef(0);
  const inFlightAbortRef = useRef<Map<string, AbortController>>(new Map());
  const coversRef = useRef(covers);
  coversRef.current = covers;

  useEffect(() => {
    const generation = ++generationRef.current;
    const margin = dynamicMargin;
    const evictMargin = margin * EVICT_MULTIPLIER;

    const { start, end } = range;
    // Guard: empty items -> empty map.
    if (!items || items.length === 0) {
      if (coversRef.current.size !== 0) setCovers(new Map());
      return;
    }

    // Guard: no token -> clearing covers (callers fall back to Music icon).
    if (!token) {
      if (coversRef.current.size !== 0) setCovers(new Map());
      return;
    }

    const prefetchStart = Math.max(0, start - margin);
    const prefetchEnd = Math.min(items.length - 1, end + margin);
    const evictStart = Math.max(0, start - evictMargin);
    const evictEnd = Math.min(items.length - 1, end + evictMargin);

    // Build evict set: rows outside evict window whose key currently holds a url.
    setCovers((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const [id, url] of prev.entries()) {
        const idx = items.findIndex((it) => it.id === id);
        const outside =
          idx === -1 || idx < evictStart || idx > evictEnd;
        if (outside && url !== null) {
          next.set(id, null);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    const abortFor = (id: string): AbortController => {
      const existing = inFlightAbortRef.current.get(id);
      if (existing) existing.abort();
      const controller = new AbortController();
      inFlightAbortRef.current.set(id, controller);
      return controller;
    };

    for (let i = prefetchStart; i <= prefetchEnd; i++) {
      const item = items[i];
      if (!item || item.isFolder) continue;

      const current = coversRef.current.get(item.id);
      // Skip if already resolved (url or explicit null) — avoid refetch storms.
      if (current !== undefined) continue;

      const controller = abortFor(item.id);
      const signal = controller.signal;

      getTrackMetadata(
        item.id,
        token,
        undefined,
        undefined,
        signal,
      )
        .then((metadata) => {
          if (generation !== generationRef.current) return;
          if (signal.aborted) return;
          inFlightAbortRef.current.delete(item.id);
          const url = metadata.coverUrl ?? null;
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
          // Fallback to Music icon: null, never leave as loading (undefined).
          setCovers((prev) => {
            const next = new Map(prev);
            next.set(item.id, null);
            return next;
          });
        });
    }

    return () => {
      // Abort in-flight requests for rows that leave the prefetch window only;
      // full cleanup happens on unmount / generation bump.
      for (let i = prefetchStart; i <= prefetchEnd; i++) {
        const item = items[i];
        if (!item) continue;
        const controller = inFlightAbortRef.current.get(item.id);
        if (controller && !controller.signal.aborted) {
          controller.abort();
          inFlightAbortRef.current.delete(item.id);
        }
      }
    };
  }, [items, range.start, range.end, token, dynamicMargin]);

  // Unmount: abort everything still in flight.
  useEffect(() => {
    const controllers = inFlightAbortRef.current;
    return () => {
      controllers.forEach((c) => c.abort());
      controllers.clear();
    };
  }, []);

  return covers;
}
