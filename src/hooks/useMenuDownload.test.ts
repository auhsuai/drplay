// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MouseEvent } from 'react';
import type { TFunction } from 'i18next';
import type { Track } from '../App';
import { getValidToken } from '../utils/apiClient';
import { getEffectiveDownloadPath } from '../utils/downloadPath';
import { useMenuDownload } from './useMenuDownload';

vi.mock('../utils/apiClient', () => ({
  getValidToken: vi.fn(),
}));

vi.mock('../utils/downloadPath', () => ({
  getEffectiveDownloadPath: vi.fn(),
}));

const mockedGetValidToken = vi.mocked(getValidToken);
const mockedGetEffectiveDownloadPath = vi.mocked(getEffectiveDownloadPath);

const BLOB_URL = 'blob:mock-track-url';

// jsdom does NOT implement URL.createObjectURL / revokeObjectURL (both are
// undefined at runtime) — install observable spies once so the hook's blob URL
// lifecycle can be asserted.
beforeAll(() => {
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }
});

let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
let clickSpy: ReturnType<typeof vi.spyOn>;

// Minimal TFunction: return the Vietnamese fallback, matching how the hook
// calls t(key, fallback).
const t = ((_key: string, fallback?: string) => fallback ?? '') as unknown as TFunction;

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'file-123',
    title: 'Test Song',
    artist: 'Test Artist',
    streamUrl: 'https://example.com/test-song',
    originalName: 'test-song.mp3',
    ...overrides,
  };
}

async function runDownload(track: Track = makeTrack()) {
  const { result } = renderHook(() => useMenuDownload(t));
  act(() => {
    result.current.handleDownloadClick(
      { stopPropagation: () => {} } as unknown as MouseEvent,
      track,
      () => {}
    );
  });
  await act(async () => {
    await result.current.executeDownload();
  });
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockedGetValidToken.mockResolvedValue('test-token');
  mockedGetEffectiveDownloadPath.mockResolvedValue('C:\\Downloads');
  vi.spyOn(globalThis, 'fetch');
  createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue(BLOB_URL);
  revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useMenuDownload blob URL lifecycle', () => {
  it('does NOT revoke the object URL synchronously right after a.click() (B5 regression)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['audio-bytes']),
    } as unknown as Response);

    await runDownload();

    // The engine schedules the actual download on a later tick; revoking
    // synchronously after click() can free the URL before the download starts,
    // producing empty/corrupt files on some engines (MDN revokeObjectURL).
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
  });

  it('revokes the object URL exactly once after the 1000ms delay (B5 variant)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['audio-bytes']),
    } as unknown as Response);

    await runDownload();
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    await act(async () => {
      // Must match REVOKE_DELAY_MS in useMenuDownload.ts.
      vi.advanceTimersByTime(1000);
    });

    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith(BLOB_URL);
  });

  it('does not create/revoke a blob URL and does not crash when the fetch fails (B5 variant)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await runDownload();

    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
    expect(result.current.downloadMessage).toContain('Tải xuống thất bại');
  });
});

describe('useMenuDownload abortable download', () => {
  it('passes an AbortSignal to the download fetch so it can be cancelled (regression: signal was missing)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['audio-bytes']),
    } as unknown as Response);

    await runDownload();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeDefined();
  });

  it('aborts the in-flight download when the component unmounts', async () => {
    // Never-settling fetch keeps the download "in flight" so the unmount
    // cleanup is the only thing that can stop it.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>(() => {})
    );

    const { result, unmount } = renderHook(() => useMenuDownload(t));
    act(() => {
      result.current.handleDownloadClick(
        { stopPropagation: () => {} } as unknown as MouseEvent,
        makeTrack(),
        () => {}
      );
    });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.executeDownload();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeDefined();
    expect(init?.signal?.aborted).toBe(false);

    unmount();

    expect(init?.signal?.aborted).toBe(true);
    void pending;
  });

  it('bounds the download with AbortSignal.timeout so a stalled server cannot hold the RAM buffer forever', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['audio-bytes']),
    } as unknown as Response);

    await runDownload();

    expect(timeoutSpy).toHaveBeenCalledWith(300_000);
  });

  it('does not surface a failure message when the download is deliberately aborted (AbortError)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('Aborted', 'AbortError')
    );

    const result = await runDownload();

    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
    expect(result.current.downloadMessage).toBeNull();
  });
});
