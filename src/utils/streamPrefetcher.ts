import { invoke } from "@tauri-apps/api/core";

const prefetchedStreams = new Map<string, string>();
const MAX_CACHE = 200; // ~40KB max (200 bytes/URL for signed stream URLs)

export function getPrefetchedStreamUrl(fileId: string): string | undefined {
  return prefetchedStreams.get(fileId);
}

// Exported so it can be tested directly (see streamPrefetcher.test.ts) --
// this is the app's one real concurrency-limiter implementation. A prior
// test file (metadata.concurrency.test.ts, removed in this audit pass)
// exercised an unrelated, hand-rolled `ConcurrencyQueue` class defined
// inline in the test itself -- it never imported from any production
// module, so it provided zero real coverage of this function.
export async function runWithConcurrencyLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
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

export async function prefetchVisibleTracks(trackIds: string[]) {
  const uncached = trackIds.filter(id => id && !prefetchedStreams.has(id));
  if (uncached.length === 0) return;

  await runWithConcurrencyLimit(uncached, 5, async (id) => {
    try {
      const url = await invoke<string>("get_stream_url", { fileId: id });
      if (typeof url === "string" && url.length > 0) {
        cacheSet(id, url);
      }
    } catch (error) {
      let kind: "timeout" | "network" | "unknown" = "unknown";
      if (error instanceof Error && /timeout/i.test(error.message)) kind = "timeout";
      else if (error instanceof Error && /network|fetch|connection/i.test(error.message)) kind = "network";
      console.warn("[streamPrefetcher] prefetch failed", { fileId: id, kind, error });
    }
  });
}

export function clearPrefetchedStreams() {
  prefetchedStreams.clear();
}
