// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../../../App';
import type { CachedMetadata } from '../../../utils/metadata';
import { getTrackMetadata } from '../../../utils/metadata';
import { getPalette } from '../../../utils/color';
import { captureError } from '../../../utils/errorLog';
import { useNowPlayingMetadata } from './useNowPlayingMetadata';

vi.mock('../../../utils/metadata', () => ({
  getTrackMetadata: vi.fn(),
}));

vi.mock('../../../utils/color', () => ({
  getPalette: vi.fn(),
}));

vi.mock('../../../utils/errorLog', () => ({
  captureError: vi.fn(),
}));

const mockedGetTrackMetadata = vi.mocked(getTrackMetadata);
const mockedGetPalette = vi.mocked(getPalette);
const mockedCaptureError = vi.mocked(captureError);

const BLOB_URL = 'blob:mock-nowplaying-cover';

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

function metadataWithPicture(): CachedMetadata {
  return {
    title: 'Real Title',
    artist: 'Real Artist',
    duration: 0,
    durationEstimated: false,
    pictureData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    pictureDataFull: null,
    pictureFormat: 'image/png',
    v: 10,
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue(BLOB_URL);
  revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useNowPlayingMetadata blob URL lifecycle (race: async .then vs cleanup)', () => {
  it('does not create a blob URL after unmount and keeps create === revoke even when metadata resolves afterwards', async () => {
    let resolveMeta!: (m: CachedMetadata) => void;
    mockedGetTrackMetadata.mockReturnValue(
      new Promise<CachedMetadata>((r) => { resolveMeta = r; })
    );

    const { unmount } = renderHook(() => useNowPlayingMetadata(makeTrack(), 'token'));
    await flushMicrotasks();

    unmount();

    await act(async () => {
      resolveMeta(metadataWithPicture());
    });
    await flushMicrotasks();

    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(createObjectURLSpy.mock.calls.length).toBe(revokeObjectURLSpy.mock.calls.length);
  });

  it('revokes the blob URL exactly once even when the palette decode fails while the component stays mounted (leak: revoke only ever ran in cleanup)', async () => {
    mockedGetTrackMetadata.mockResolvedValue(metadataWithPicture());
    mockedGetPalette.mockRejectedValue(new Error('decode failed'));

    const { result } = renderHook(() => useNowPlayingMetadata(makeTrack(), 'token'));
    await flushMicrotasks();

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith(BLOB_URL);
    expect(result.current.coverUrl).toBe(BLOB_URL);
  });

  it('defers revocation until the palette decode settles (never revokes a URL the palette is still decoding)', async () => {
    let resolvePalette!: (colors: string[]) => void;
    mockedGetTrackMetadata.mockResolvedValue(metadataWithPicture());
    mockedGetPalette.mockReturnValue(
      new Promise<string[]>((r) => { resolvePalette = r; })
    );

    const { unmount } = renderHook(() => useNowPlayingMetadata(makeTrack(), 'token'));
    await flushMicrotasks();

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    unmount();

    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    await act(async () => {
      resolvePalette(['rgba(10,20,30,0.8)', 'rgba(1,2,3,0.8)']);
    });
    await flushMicrotasks();

    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith(BLOB_URL);
    expect(createObjectURLSpy.mock.calls.length).toBe(revokeObjectURLSpy.mock.calls.length);
  });

  it('rapid track switch: stale run creates no blob after cleanup, active run revokes exactly its own URL once after its palette settles', async () => {
    const metaResolvers: Array<(m: CachedMetadata) => void> = [];
    mockedGetTrackMetadata.mockImplementation(
      () => new Promise<CachedMetadata>((r) => { metaResolvers.push(r); })
    );
    const paletteResolvers: Array<(colors: string[]) => void> = [];
    mockedGetPalette.mockImplementation(
      () => new Promise<string[]>((r) => { paletteResolvers.push(r); })
    );

    const { result, rerender } = renderHook(
      ({ track }: { track: Track }) => useNowPlayingMetadata(track, 'token'),
      { initialProps: { track: makeTrack({ id: 'file-a' }) } }
    );
    await flushMicrotasks();

    rerender({ track: makeTrack({ id: 'file-b' }) });
    await flushMicrotasks();

    expect(metaResolvers).toHaveLength(2);

    await act(async () => {
      metaResolvers[0](metadataWithPicture());
      metaResolvers[1](metadataWithPicture());
    });
    await flushMicrotasks();

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(createObjectURLSpy).toHaveBeenCalledWith(expect.any(Blob));
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    await act(async () => {
      paletteResolvers[0](['rgba(1,1,1,0.8)', 'rgba(2,2,2,0.8)']);
    });
    await flushMicrotasks();

    expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith(BLOB_URL);
    expect(createObjectURLSpy.mock.calls.length).toBe(revokeObjectURLSpy.mock.calls.length);
    expect(result.current.coverUrl).toBe(BLOB_URL);
  });

  it('logs a warn via captureError with the module source when palette decoding fails', async () => {
    mockedGetTrackMetadata.mockResolvedValue(metadataWithPicture());
    mockedGetPalette.mockRejectedValue(new Error('decode failed'));

    renderHook(() => useNowPlayingMetadata(makeTrack(), 'token'));
    await flushMicrotasks();

    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'useNowPlayingMetadata',
        message: expect.stringContaining('palette-failed'),
      })
    );
  });

  it('does not log via captureError when metadata rejects with AbortError (cleanup abort is not an error)', async () => {
    mockedGetTrackMetadata.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    renderHook(() => useNowPlayingMetadata(makeTrack(), 'token'));
    await flushMicrotasks();

    expect(mockedCaptureError).not.toHaveBeenCalled();
  });
});
