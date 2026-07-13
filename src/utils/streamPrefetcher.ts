import { invoke } from "@tauri-apps/api/core";

const prefetchedStreams = new Map<string, string>();
const MAX_CACHE = 200;

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

function evictIfNeeded() {
  if (prefetchedStreams.size >= MAX_CACHE) {
    const keysToDelete = [...prefetchedStreams.keys()].slice(0, Math.floor(MAX_CACHE / 3));
    for (const key of keysToDelete) {
      prefetchedStreams.delete(key);
    }
  }
}

export async function prefetchVisibleTracks(trackIds: string[]) {
  const uncached = trackIds.filter(id => id && !prefetchedStreams.has(id));
  if (uncached.length === 0) return;

  await runWithConcurrencyLimit(uncached, 6, async (id) => {
    try {
      const url = await invoke<string>("get_stream_url", { fileId: id });
      if (typeof url === "string" && url.length > 0) {
        evictIfNeeded();
        prefetchedStreams.set(id, url);
      }
    } catch {
      // Silently fail; will fetch on demand
    }
  });
}

export function clearPrefetchedStreams() {
  prefetchedStreams.clear();
}
