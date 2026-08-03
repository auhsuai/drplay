import { captureError } from './errorLog';

const MAX_CONCURRENT = 3;
const PREFETCH_TIMEOUT_MS = 15000;
// 512 KiB window; Range byte offsets are zero-indexed and end-inclusive
// (MDN Range header), so end = PREFETCH_RANGE_BYTES - 1.
const PREFETCH_RANGE_BYTES = 512 * 1024;

const abortControllers = new Map<string, AbortController>();

function touch(url: string, controller: AbortController): void {
  abortControllers.delete(url);
  abortControllers.set(url, controller);
}

function evictOldest(): void {
  const oldest = abortControllers.keys().next().value;
  if (oldest === undefined) return;
  abortControllers.get(oldest)?.abort();
  abortControllers.delete(oldest);
}

function classifyError(err: unknown): 'timeout' | 'aborted' | 'network' | 'unknown' {
  if (err instanceof DOMException) {
    if (err.name === 'TimeoutError') return 'timeout';
    if (err.name === 'AbortError') return 'aborted';
  }
  if (err instanceof TypeError) return 'network';
  return 'unknown';
}

export function prefetchNextTrackAudio(streamUrl: string): void {
  if (!streamUrl || abortControllers.has(streamUrl)) return;
  if (abortControllers.size >= MAX_CONCURRENT) {
    evictOldest();
  }

  const controller = new AbortController();
  touch(streamUrl, controller);

  fetch(streamUrl, {
    headers: { Range: `bytes=0-${PREFETCH_RANGE_BYTES - 1}` },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(PREFETCH_TIMEOUT_MS)]),
  })
    .then((response) => {
      if (!response.ok) return;
      const logCancelError = (err: unknown) => {
        captureError({
          level: 'warn',
          source: 'nextTrackPrefetcher',
          message: `Prefetch body cancel failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      };
      try {
        void response.body?.cancel().catch(logCancelError);
      } catch (err) {
        logCancelError(err);
      }
    })
    .catch((err: unknown) => {
      const kind = classifyError(err);
      captureError({
        level: 'warn',
        source: 'nextTrackPrefetcher',
        message: `Prefetch failed (${kind}): ${err instanceof Error ? err.message : String(err)}`,
      });
    })
    .finally(() => {
      abortControllers.delete(streamUrl);
    });
}

export function clearNextTrackPrefetches(): void {
  for (const [, controller] of abortControllers) {
    controller.abort();
  }
  abortControllers.clear();
}

export function getPendingPrefetchCount(): number {
  return abortControllers.size;
}
