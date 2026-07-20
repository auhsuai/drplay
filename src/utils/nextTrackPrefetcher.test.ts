import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  prefetchNextTrackAudio,
  clearNextTrackPrefetches,
} from './nextTrackPrefetcher';

describe('nextTrackPrefetcher LRU', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearNextTrackPrefetches();
  });

  it('evicts the least-recently-used track when over capacity', async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));

    const urls = ['a', 'b', 'c', 'd'].map((u) => `https://x/${u}`);
    urls.forEach((u) => prefetchNextTrackAudio(u));

    // 4 fetches attempted; capacity 3 -> oldest 'a' aborted exactly once
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('does not refetch an in-flight url', () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    const url = 'https://x/dup';
    prefetchNextTrackAudio(url);
    prefetchNextTrackAudio(url);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('classifies and logs fetch failures without full url', async () => {
    const err = new TypeError('Failed to fetch');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(err);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    prefetchNextTrackAudio('https://x/secret-token-1234567890');
    await new Promise((r) => setTimeout(r, 0));

    expect(warnSpy).toHaveBeenCalled();
    const logged = warnSpy.mock.calls[0][1] as { url: string; kind: string };
    expect(logged.url.length).toBeLessThanOrEqual(17);
    expect(logged.url).not.toContain('secret-token-1234567890');
    expect(['timeout', 'network', 'unknown']).toContain(logged.kind);

    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
