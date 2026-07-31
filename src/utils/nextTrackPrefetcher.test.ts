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

describe('nextTrackPrefetcher body release (#7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearNextTrackPrefetches();
  });

  it('#7 cancels the prefetch response body exactly once', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, body } as unknown as Response);

    prefetchNextTrackAudio('https://x/warm');
    await new Promise((r) => setTimeout(r, 0));

    expect(cancel).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  it('#7 does not cancel the body when response is not ok', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({
        ok: false,
        status: 404,
        body,
      } as unknown as Response);

    prefetchNextTrackAudio('https://x/missing');
    await new Promise((r) => setTimeout(r, 0));

    expect(cancel).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('#7 does not crash when response body is null', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, body: null } as unknown as Response);

    prefetchNextTrackAudio('https://x/empty-body');
    await new Promise((r) => setTimeout(r, 0));

    expect(warnSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('#7 logs with truncated url and does not crash when cancel fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'));
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, body } as unknown as Response);

    prefetchNextTrackAudio('https://x/cancel-fail');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    const [message, payload] = warnSpy.mock.calls[0] as [string, { url: string }];
    expect(message).toContain('prefetch-body-cancel-fail');
    expect(payload.url.length).toBeLessThanOrEqual(17);
    expect(payload.url).not.toContain('cancel-fail');

    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
