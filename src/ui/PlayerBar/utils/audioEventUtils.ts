export function waitForAudioEvent(
  audio: HTMLAudioElement,
  event: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      audio.removeEventListener(event, handler);
      resolve();
    };
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      audio.removeEventListener(event, handler);
      reject(signal?.reason || new DOMException('Aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      audio.removeEventListener(event, handler);
      reject(new Error(`Timeout waiting for ${event} after ${timeoutMs}ms`));
    }, timeoutMs);
    audio.addEventListener(event, handler);
  });
}
