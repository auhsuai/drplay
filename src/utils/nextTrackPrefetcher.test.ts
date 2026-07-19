import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('nextTrackPrefetcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('should fetch first 512KB to warm proxy cache', async () => {
    const { prefetchNextTrackAudio } = await import('./nextTrackPrefetcher');
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-range': 'bytes 0-524287/10000000' }),
    });
    globalThis.fetch = mockFetch;

    prefetchNextTrackAudio('http://drplay.localhost/stream?id=test123&sig=abc');

    await new Promise(r => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalledWith(
      'http://drplay.localhost/stream?id=test123&sig=abc',
      expect.objectContaining({
        headers: { Range: 'bytes=0-524287' },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('should be no-op for already prefetched track', async () => {
    const { prefetchNextTrackAudio } = await import('./nextTrackPrefetcher');
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    prefetchNextTrackAudio('http://drplay.localhost/stream?id=test123&sig=abc');
    prefetchNextTrackAudio('http://drplay.localhost/stream?id=test123&sig=abc');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
