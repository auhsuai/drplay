// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  clearAppCache,
  getCacheSizes,
  FILES_ROW_ESTIMATED_BYTES,
  PREFETCH_ENTRY_ESTIMATED_BYTES,
} from './cache';
import { captureError } from './errorLog';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('./errorLog', () => ({
  captureError: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  clearAllMetadataCacheMock: vi.fn(),
  metadataToArrayMock: vi.fn(),
  filesCountMock: vi.fn(),
  filesClearMock: vi.fn(),
  clearPrefetchedStreamsMock: vi.fn(),
  clearNextTrackPrefetchesMock: vi.fn(),
  streamCountMock: vi.fn(),
  pendingCountMock: vi.fn(),
}));

vi.mock('../db/db', () => ({
  db: {
    metadataCache: {
      where: vi.fn(() => ({
        startsWith: vi.fn(() => ({
          delete: mocks.deleteMock,
          toArray: mocks.metadataToArrayMock,
        })),
      })),
    },
    files: {
      count: mocks.filesCountMock,
      clear: mocks.filesClearMock,
    },
  },
}));

vi.mock('./metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./metadata')>();
  return { ...actual, clearAllMetadataCache: mocks.clearAllMetadataCacheMock };
});

vi.mock('./streamPrefetcher', () => ({
  clearPrefetchedStreams: mocks.clearPrefetchedStreamsMock,
  getPrefetchedStreamCount: mocks.streamCountMock,
}));

vi.mock('./nextTrackPrefetcher', () => ({
  clearNextTrackPrefetches: mocks.clearNextTrackPrefetchesMock,
  getPendingPrefetchCount: mocks.pendingCountMock,
}));

const invokeMock = vi.mocked(invoke);
const captureErrorMock = vi.mocked(captureError);

beforeEach(() => {
  invokeMock.mockReset();
  captureErrorMock.mockReset();
  mocks.deleteMock.mockReset();
  mocks.clearAllMetadataCacheMock.mockReset();
  mocks.metadataToArrayMock.mockReset();
  mocks.filesCountMock.mockReset();
  mocks.filesClearMock.mockReset();
  mocks.clearPrefetchedStreamsMock.mockReset();
  mocks.clearNextTrackPrefetchesMock.mockReset();
  mocks.streamCountMock.mockReset();
  mocks.pendingCountMock.mockReset();

  mocks.deleteMock.mockResolvedValue(undefined);
  mocks.metadataToArrayMock.mockResolvedValue([]);
  mocks.filesCountMock.mockResolvedValue(0);
  mocks.filesClearMock.mockResolvedValue(undefined);
  mocks.clearPrefetchedStreamsMock.mockReturnValue(undefined);
  mocks.clearNextTrackPrefetchesMock.mockReturnValue(undefined);
  mocks.streamCountMock.mockReturnValue(0);
  mocks.pendingCountMock.mockReturnValue(0);
  invokeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clearAppCache', () => {
  it('rethrows the ORIGINAL Dexie error when localStorage.removeItem throws SecurityError', async () => {
    mocks.deleteMock.mockRejectedValue(new Error('dexie boom'));
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    await expect(clearAppCache()).rejects.toThrow('dexie boom');

    expect(captureErrorMock).toHaveBeenCalled();
    expect(
      captureErrorMock.mock.calls.some(([c]) => c.message.includes('clear-lru-key-failed'))
    ).toBe(true);
  });

  it('removes the LRU key, invokes clear_local_cache, and clears memory cache on happy path', async () => {
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');

    await expect(clearAppCache()).resolves.toBeUndefined();

    expect(removeItemSpy).toHaveBeenCalledWith('__drplay_metadata_lru');
    expect(invokeMock).toHaveBeenCalledWith('clear_local_cache');
    expect(mocks.clearAllMetadataCacheMock).toHaveBeenCalledTimes(1);
  });

  it('clears metadata even when the covers invoke fails, and throws an aggregate error', async () => {
    invokeMock.mockRejectedValue(new Error('ipc down'));

    await expect(clearAppCache()).rejects.toThrow('ipc down');

    expect(mocks.clearAllMetadataCacheMock).toHaveBeenCalledTimes(1);
    expect(
      captureErrorMock.mock.calls.some(([c]) => c.message.includes('clear_local_cache failed'))
    ).toBe(true);
  });

  it('clears only db.files when selected is [files]', async () => {
    await expect(clearAppCache(['files'])).resolves.toBeUndefined();

    expect(mocks.filesClearMock).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(mocks.clearPrefetchedStreamsMock).not.toHaveBeenCalled();
    expect(mocks.clearNextTrackPrefetchesMock).not.toHaveBeenCalled();
  });

  it('clears covers and thumbnails when selected is [covers]', async () => {
    await expect(clearAppCache(['covers'])).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith('clear_local_cache');
    expect(invokeMock).toHaveBeenCalledWith('clear_thumbnail_dir');
    expect(mocks.filesClearMock).not.toHaveBeenCalled();
    expect(mocks.deleteMock).not.toHaveBeenCalled();
  });

  it('clears prefetch state when selected is [prefetch]', async () => {
    await expect(clearAppCache(['prefetch'])).resolves.toBeUndefined();

    expect(mocks.clearPrefetchedStreamsMock).toHaveBeenCalledTimes(1);
    expect(mocks.clearNextTrackPrefetchesMock).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMock).not.toHaveBeenCalled();
    expect(mocks.filesClearMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('clears only metadata when selected is [metadata] (no files/covers/prefetch)', async () => {
    await expect(clearAppCache(['metadata'])).resolves.toBeUndefined();

    expect(mocks.deleteMock).toHaveBeenCalledTimes(1);
    expect(mocks.clearAllMetadataCacheMock).toHaveBeenCalledTimes(1);
    expect(mocks.filesClearMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(mocks.clearPrefetchedStreamsMock).not.toHaveBeenCalled();
    expect(mocks.clearNextTrackPrefetchesMock).not.toHaveBeenCalled();
  });

  it('clears every category when called with no arguments (default all)', async () => {
    await expect(clearAppCache()).resolves.toBeUndefined();

    expect(mocks.deleteMock).toHaveBeenCalledTimes(1);
    expect(mocks.clearAllMetadataCacheMock).toHaveBeenCalledTimes(1);
    expect(mocks.filesClearMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('clear_local_cache');
    expect(invokeMock).toHaveBeenCalledWith('clear_thumbnail_dir');
    expect(mocks.clearPrefetchedStreamsMock).toHaveBeenCalledTimes(1);
    expect(mocks.clearNextTrackPrefetchesMock).toHaveBeenCalledTimes(1);
  });
});

describe('getCacheSizes', () => {
  it('aggregates estimated bytes across all four categories', async () => {
    const entryA = { v: 2, data: { title: 'alpha' }, ts: 1 };
    const entryB = { v: 2, data: { title: 'beta' }, ts: 2 };
    mocks.metadataToArrayMock.mockResolvedValue([
      { key: 'metadata_a', entry: entryA },
      { key: 'metadata_b', entry: entryB },
    ]);
    mocks.filesCountMock.mockResolvedValue(100);
    invokeMock.mockResolvedValue({
      cover_cache_bytes: 10,
      etag_cache_bytes: 20,
      thumbnail_dir_bytes: 30,
    });
    mocks.streamCountMock.mockReturnValue(3);
    mocks.pendingCountMock.mockReturnValue(5);

    const sizes = await getCacheSizes();

    expect(sizes).toHaveLength(4);
    expect(sizes.map((s) => s.id)).toEqual(['metadata', 'files', 'covers', 'prefetch']);
    expect(sizes.map((s) => s.label)).toEqual([
      'Metadata cache',
      'File listing cache',
      'Covers & thumbnails',
      'Prefetched data',
    ]);
    expect(sizes[0].bytes).toBe(JSON.stringify(entryA).length + JSON.stringify(entryB).length);
    expect(sizes[1].bytes).toBe(100 * FILES_ROW_ESTIMATED_BYTES);
    expect(sizes[2].bytes).toBe(60);
    expect(sizes[3].bytes).toBe(8 * PREFETCH_ENTRY_ESTIMATED_BYTES);
  });

  it('returns 0 bytes for covers when get_cache_info rejects without breaking the list', async () => {
    mocks.metadataToArrayMock.mockResolvedValue([
      { key: 'metadata_a', entry: { v: 2, data: { title: 'alpha' }, ts: 1 } },
    ]);
    mocks.filesCountMock.mockResolvedValue(50);
    invokeMock.mockRejectedValue(new Error('ipc down'));
    mocks.streamCountMock.mockReturnValue(2);
    mocks.pendingCountMock.mockReturnValue(0);

    const sizes = await getCacheSizes();

    expect(sizes).toHaveLength(4);
    expect(sizes.find((s) => s.id === 'covers')!.bytes).toBe(0);
    expect(sizes.find((s) => s.id === 'files')!.bytes).toBe(50 * FILES_ROW_ESTIMATED_BYTES);
    expect(sizes.find((s) => s.id === 'metadata')!.bytes).toBeGreaterThan(0);
    expect(
      captureErrorMock.mock.calls.some(([c]) => c.message.includes('get-cache-size-covers'))
    ).toBe(true);
    expect(captureErrorMock.mock.calls.some(([c]) => c.level === 'warn')).toBe(true);
  });
});
