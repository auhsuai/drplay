import { captureError } from './errorLog';

const MAX_CONCURRENT = 3;
const PREFETCH_TIMEOUT_MS = 15000;

const abortControllers = new Map<string, AbortController>();
const timeouts = new Map<string, ReturnType<typeof setTimeout>>();

function touch(url: string, controller: AbortController): void {
  abortControllers.delete(url);
  abortControllers.set(url, controller);
}

function evictOldest(): void {
  const oldest = abortControllers.keys().next().value;
  if (oldest === undefined) return;
  abortControllers.get(oldest)?.abort();
  abortControllers.delete(oldest);
  const t = timeouts.get(oldest);
  if (t !== undefined) {
    clearTimeout(t);
    timeouts.delete(oldest);
  }
}

function classifyError(err: unknown): 'timeout' | 'network' | 'unknown' {
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|abort|aborted/i.test(message)) return 'timeout';
  if (/network|fetch|failed|econn|enotfound|ECONNRESET/i.test(message)) return 'network';
  return 'unknown';
}

export function prefetchNextTrackAudio(streamUrl: string): void {
  if (!streamUrl || abortControllers.has(streamUrl)) return;
  if (abortControllers.size >= MAX_CONCURRENT) {
    evictOldest();
  }

  const controller = new AbortController();
  touch(streamUrl, controller);
  const timeout = setTimeout(() => controller.abort(), PREFETCH_TIMEOUT_MS);
  timeouts.set(streamUrl, timeout);

  fetch(streamUrl, {
    headers: { Range: 'bytes=0-524287' },
    signal: controller.signal,
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
      clearTimeout(timeouts.get(streamUrl));
      timeouts.delete(streamUrl);
      abortControllers.delete(streamUrl);
    });
}

export function clearNextTrackPrefetches(): void {
  for (const [, controller] of abortControllers) {
    controller.abort();
  }
  abortControllers.clear();
  for (const t of timeouts.values()) {
    clearTimeout(t);
  }
  timeouts.clear();
}
