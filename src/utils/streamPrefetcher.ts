import { captureError } from './errorLog';

const prefetchedStreams = new Map<string, string>();
const MAX_CACHE = 200; // ~40KB max (200 bytes/URL for signed stream URLs)

export function getPrefetchedStreamUrl(fileId: string): string | undefined {
  return prefetchedStreams.get(fileId);
}

async function runWithConcurrencyLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const results: Promise<void>[] = [];
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const p = fn(item).finally(() => executing.delete(p));
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.allSettled(results);
}

function cacheSet(fileId: string, url: string) {
  if (prefetchedStreams.has(fileId)) prefetchedStreams.delete(fileId);
  prefetchedStreams.set(fileId, url);
  while (prefetchedStreams.size > MAX_CACHE) {
    const oldest = prefetchedStreams.keys().next().value;
    if (oldest === undefined) break;
    prefetchedStreams.delete(oldest);
  }
}

export function cachePrefetchedStream(fileId: string, url: string): void {
  cacheSet(fileId, url);
}

export async function prefetchVisibleTracks(trackIds: string[]) {
  const uncached = trackIds.filter(id => id && !prefetchedStreams.has(id));
  if (uncached.length === 0) return;

  await runWithConcurrencyLimit(uncached, 5, async (id) => {
    try {
      // Vì đã bỏ proxy, ta gán trực tiếp URL ảo
      const url = `/drive-stream/${id}`;
      cacheSet(id, url);
    } catch (error: unknown) {
      captureError({ level: 'warn', source: 'streamPrefetcher', message: `Prefetch failed for ${id}: ${error instanceof Error ? error.message : String(error)}` });
    }
  });
}

export function clearPrefetchedStreams() {
  prefetchedStreams.clear();
}
