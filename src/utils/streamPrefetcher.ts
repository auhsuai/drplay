import { playableExtensionOf } from "./audioQuery";
import { IS_MOBILE } from "./platform";

const prefetchedStreams = new Map<string, string>();
export const DRIVE_STREAM_PREFIX = "/drive-stream/";
// Query param carrying the file extension to the SW proxy (sw.js never sees
// the file name — see buildStreamUrl below).
const EXT_QUERY_PARAM = "?ext=";
// cache URL strings ngắn (~30 chars/URL, ~128 bytes/entry gồm cả Map overhead
// — khớp PREFETCH_ENTRY_ESTIMATED_BYTES trong cache.ts), KHÔNG prefetch data —
// việc prefetch thật do nextTrackPrefetcher đảm nhiệm
const MAX_CACHE = 200;

// Single source of truth for every stream URL the app builds. The SW proxy
// (public/sw.js) overrides Drive's application/octet-stream Content-Type for
// playable files based on the ?ext= query param — the SW never sees the file
// name, so the extension MUST travel through the URL query.
export function buildStreamUrl(fileId: string, name?: string): string {
  const base = `${DRIVE_STREAM_PREFIX}${encodeURIComponent(fileId)}`;
  const ext = playableExtensionOf(name);
  return ext ? `${base}${EXT_QUERY_PARAM}${ext}` : base;
}

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

export function prefetchVisibleTracks(
  items: ReadonlyArray<{ id: string; originalName?: string }>,
): void {
  // Mobile (GATE branch B): the /drive-stream SW proxy is dead on Android —
  // URL strings would be cached for nothing (the native engine builds Drive
  // URLs itself). Desktop path unchanged.
  if (IS_MOBILE) return;
  for (const item of items) {
    if (item.id && !prefetchedStreams.has(item.id))
      cacheSet(item.id, buildStreamUrl(item.id, item.originalName));
  }
}

export function clearPrefetchedStreams() {
  prefetchedStreams.clear();
}

export function getPrefetchedStreamCount(): number {
  return prefetchedStreams.size;
}
