const warmingTracks = new Set<string>();
const MAX_CONCURRENT = 3;
const abortControllers = new Map<string, AbortController>();

export function prefetchNextTrackAudio(streamUrl: string): void {
  if (!streamUrl || warmingTracks.has(streamUrl)) return;
  if (warmingTracks.size >= MAX_CONCURRENT) {
    const first = warmingTracks.values().next().value;
    if (first) {
      abortControllers.get(first)?.abort();
      abortControllers.delete(first);
      warmingTracks.delete(first);
    }
  }

  warmingTracks.add(streamUrl);
  const controller = new AbortController();
  abortControllers.set(streamUrl, controller);
  const timeout = setTimeout(() => controller.abort(), 15000);

  fetch(streamUrl, {
    headers: { Range: 'bytes=0-524287' },
    signal: controller.signal,
  })
    .catch((err) => { console.warn('[nextTrackPrefetcher] prefetch-fail', err); })
    .finally(() => {
      clearTimeout(timeout);
      warmingTracks.delete(streamUrl);
      abortControllers.delete(streamUrl);
    });
}

export function clearNextTrackPrefetches(): void {
  for (const [url, controller] of abortControllers) {
    controller.abort();
  }
  abortControllers.clear();
  warmingTracks.clear();
}
