// Slice 2: asks the SW to warm its byte-cache for the next track
// (PREFETCH_TRACK in public/sw.js). Best-effort: no controller (SW not yet
// registered / non-secure context) is a no-op.
export function prefetchTrackInServiceWorker(fileId: string): void {
  try {
    const worker = navigator.serviceWorker.controller;
    if (!worker) return;
    worker.postMessage({ type: "PREFETCH_TRACK", fileId });
  } catch (err) {
    console.warn("SW prefetch postMessage failed", err);
  }
}

// Seeds the SW's total-size cache from Drive listing metadata
// (REMEMBER_TOTAL_SIZES in public/sw.js) so byte-cache serving works for
// files never streamed yet. The SW seeds fill-miss only and ignores invalid
// entries, so the caller may pass any parsed rows as-is. Same best-effort
// contract as prefetchTrackInServiceWorker: no controller is a no-op.
export function rememberTotalSizesInServiceWorker(
  entries: ReadonlyArray<{ fileId: string; size: number }>,
): void {
  if (entries.length === 0) return;
  try {
    const worker = navigator.serviceWorker.controller;
    if (!worker) return;
    worker.postMessage({ type: "REMEMBER_TOTAL_SIZES", entries: [...entries] });
  } catch (err) {
    console.warn("SW rememberTotalSizes postMessage failed", err);
  }
}
