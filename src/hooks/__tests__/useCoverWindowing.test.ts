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
      useCoverWindowing({ items: [], token: 'tok' }),
    );
    expect(result.current.size).toBe(0);
  });

  it('returns empty map when token is null (does not fetch)', () => {
    const items = makeItems(5);
    const { result } = renderHook(() =>
      useCoverWindowing({ items, token: null }),
    );
    expect(result.current.size).toBe(0);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('fetches covers for all items', async () => {
    const items = makeItems(5);
    const { result } = renderHook(() =>
      useCoverWindowing({ items, token: 'tok' }),
    );

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(5));

    expect(hasCall('t0')).toBe(true);
    expect(hasCall('t4')).toBe(true);

    await waitFor(() => {
      expect(result.current.size).toBe(5);
      expect(result.current.get('t0')).toBe('url-t0');
      expect(result.current.get('t4')).toBe('url-t4');
    });
  });

  it('skips isFolder items', async () => {
    const items: CoverWindowItem[] = [
      { id: 'f1', isFolder: true },
      { id: 't0', isFolder: false },
    ];
    renderHook(() =>
      useCoverWindowing({ items, token: 'tok' }),
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
      useCoverWindowing({ items, token: 'tok' }),
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
    useCoverWindowing({ items, token: 'tok' }),
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
    useCoverWindowing({ items, token: 'tok' }),
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
      ({ items }) => useCoverWindowing({ items, token: 'tok' }),
      { initialProps: { items } },
    );

    await waitFor(() => expect(hasCall('t0')).toBe(true));

    // Change items so t0 leaves the set; resolution of the old promise
    // must NOT write into the map (generation guard).
    rerender({ items: makeItems(3).slice(3) });
    await waitFor(() => expect(hasCall('t3')).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });

    // t0 may or may not be in map, but if present it must NOT be the STALE value.
    expect(result.current.get('t0')).not.toBe('STALE');
  });
});
