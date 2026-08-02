const prefetchedStreams = new Map<string, string>();
const DRIVE_STREAM_PREFIX = '/drive-stream/';
const MAX_CACHE = 200; // cache URL string ngắn (~20 byte/URL), KHÔNG prefetch data — việc prefetch thật do nextTrackPrefetcher đảm nhiệm

export function getPrefetchedStreamUrl(fileId: string): string | undefined {
  return prefetchedStreams.get(fileId);
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

export function prefetchVisibleTracks(fileIds: string[]): void {
  for (const id of fileIds) {
    if (id && !prefetchedStreams.has(id)) cacheSet(id, `${DRIVE_STREAM_PREFIX}${id}`);
  }
}

export function clearPrefetchedStreams() {
  prefetchedStreams.clear();
}
