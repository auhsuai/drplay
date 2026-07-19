// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import { useCoverWindowing } from '../useCoverWindowing';
import type { CoverWindowItem } from '../useCoverWindowing';

// jsdom lacks URL.createObjectURL and Blob; polyfill them for pictureData tests.
if (typeof URL.createObjectURL === 'undefined') {
  const blobUrlMap = new Map<string, Blob>();
  let counter = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:mock/${++counter}`;
    blobUrlMap.set(url, blob);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    blobUrlMap.delete(url);
  });
}
if (typeof Blob === 'undefined') {
  (globalThis as any).Blob = class Blob {
    constructor(public parts: any[], public options?: any) {}
  };
}

vi.mock('../../utils/metadata', () => ({
  getTrackMetadata: vi.fn(),
}));

import { getTrackMetadata } from '../../utils/metadata';

const mockedFetch = vi.mocked(getTrackMetadata);

function makeItems(n: number): CoverWindowItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `t${i}`, isFolder: false }));
}

function hasCall(id: string): boolean {
  return mockedFetch.mock.calls.some((c) => c[0] === id && c[1] === 'tok');
}

describe('useCoverWindowing', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockImplementation((id: string) =>
      Promise.resolve({ coverUrl: `url-${id}`, pictureData: null, pictureFormat: undefined }) as never,
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('returns empty map when items is empty', () => {
    const { result } = renderHook(() =>
      useCoverWindowing({ items: [], range: { start: 0, end: 0 }, token: 'tok' }),
    );
    expect(result.current.size).toBe(0);
  });

  it('returns empty map when token is null (does not fetch)', () => {
    const items = makeItems(5);
    const { result } = renderHook(() =>
      useCoverWindowing({ items, range: { start: 0, end: 2 }, token: null }),
    );
    expect(result.current.size).toBe(0);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('prefetches exactly the prefetch window (range ± margin) and not beyond', async () => {
    const items = makeItems(20);
    const margin = 3;
    const { result } = renderHook(() =>
      useCoverWindowing({ items, range: { start: 5, end: 7 }, token: 'tok', dynamicMargin: margin }),
    );

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(9));

    expect(hasCall('t2')).toBe(true);
    expect(hasCall('t10')).toBe(true);
    expect(hasCall('t1')).toBe(false);
    expect(hasCall('t11')).toBe(false);

    await waitFor(() => {
      expect(result.current.size).toBe(9);
      expect(result.current.get('t5')).toBe('url-t5');
    });
  });

  it('sets null for rows outside evict window', async () => {
    const items = makeItems(40);
    const margin = 3;
    const { result, rerender } = renderHook(
      ({ range }) => useCoverWindowing({ items, range, token: 'tok', dynamicMargin: margin }),
      { initialProps: { range: { start: 10, end: 12 } } },
    );

    // Initial prefetch window = [7,15]
    await waitFor(() => expect(hasCall('t7')).toBe(true));
    await waitFor(() => expect(hasCall('t15')).toBe(true));
    expect(mockedFetch).toHaveBeenCalledTimes(9);
    await waitFor(() => {
      expect(result.current.get('t10')).toBe('url-t10');
    });

    // Scroll far away: range [30,32]; evict window [24,38]; row t10 (idx10)
    // was fetched but now sits outside evict window -> must be evicted to null.
    mockedFetch.mockClear();
    rerender({ range: { start: 30, end: 32 } });

    await waitFor(() => {
      expect(result.current.has('t10')).toBe(true);
      expect(result.current.get('t10')).toBeNull();
    });
    // New window [27,35] fetched
    await waitFor(() => expect(hasCall('t27')).toBe(true));
    await waitFor(() => expect(hasCall('t35')).toBe(true));
  });

  it('skips isFolder items', async () => {
    const items: CoverWindowItem[] = [
      { id: 'f1', isFolder: true },
      { id: 't0', isFolder: false },
    ];
    renderHook(() =>
      useCoverWindowing({ items, range: { start: 0, end: 1 }, token: 'tok' }),
    );
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    expect(hasCall('t0')).toBe(true);
    expect(hasCall('f1')).toBe(false);
  });

  it('sets null on fetch error (Music fallback)', async () => {
    mockedFetch.mockImplementation((id: string) =>
      (id === 't1' ? Promise.reject(new Error('boom')) : Promise.resolve({ coverUrl: `url-${id}` })) as never,
    );
    const items = makeItems(3);
    const { result } = renderHook(() =>
      useCoverWindowing({ items, range: { start: 0, end: 2 }, token: 'tok' }),
    );
    await waitFor(() => {
      expect(result.current.get('t1')).toBeNull();
    });
    await waitFor(() => {
      expect(result.current.get('t0')).toBe('url-t0');
    });
  });

  it('falls back to pictureData when coverUrl is absent (creates blob URL)', async () => {
  mockedFetch.mockImplementation((_id: string) =>
    Promise.resolve({ coverUrl: undefined, pictureData: new Uint8Array([137, 80, 78, 71]), pictureFormat: 'image/png' }) as never,
  );
  const items = makeItems(3);
  const { result } = renderHook(() =>
    useCoverWindowing({ items, range: { start: 0, end: 2 }, token: 'tok' }),
  );
  await waitFor(() => {
    const url = result.current.get('t0');
    expect(url).not.toBeNull();
    expect(url).toMatch(/^blob:/);
  });
});

it('passes trackInfo.size and trackInfo.originalName to getTrackMetadata when available', async () => {
  const items: CoverWindowItem[] = [
    { id: 't0', isFolder: false, trackInfo: { size: 12345, originalName: 'song.mp3' } },
    { id: 't1', isFolder: false },
  ];
  renderHook(() =>
    useCoverWindowing({ items, range: { start: 0, end: 1 }, token: 'tok' }),
  );
  await waitFor(() => {
    expect(mockedFetch).toHaveBeenCalledWith('t0', 'tok', 12345, 'song.mp3', expect.any(Object));
    expect(mockedFetch).toHaveBeenCalledWith('t1', 'tok', undefined, undefined, expect.any(Object));
  });
});

it('guards against race: latest generation wins, no stale writes', async () => {
    const items = makeItems(6);
    mockedFetch.mockImplementation((id: string) =>
      (id === 't0'
        ? new Promise((resolve) => setTimeout(() => resolve({ coverUrl: 'STALE' }), 300))
        : Promise.resolve({ coverUrl: `url-${id}` })) as never,
    );

    const { result, rerender } = renderHook(
      ({ range }) => useCoverWindowing({ items, range, token: 'tok' }),
      { initialProps: { range: { start: 0, end: 2 } } },
    );

    await waitFor(() => expect(hasCall('t0')).toBe(true));

    // Move range so t0 leaves prefetch window; resolution of the old promise
    // must NOT write into the map (generation guard).
    rerender({ range: { start: 4, end: 5 } });
    await waitFor(() => expect(hasCall('t4')).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });

    // t0 may or may not be in map, but if present it must NOT be the STALE value.
    expect(result.current.get('t0')).not.toBe('STALE');
  });
});
