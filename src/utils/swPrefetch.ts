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
