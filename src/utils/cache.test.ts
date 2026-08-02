// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { clearAppCache } from './cache';
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
}));

vi.mock('../db/db', () => ({
  db: {
    metadataCache: {
      where: vi.fn(() => ({
        startsWith: vi.fn(() => ({
          delete: mocks.deleteMock,
        })),
      })),
    },
  },
}));

vi.mock('./metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./metadata')>();
  return { ...actual, clearAllMetadataCache: mocks.clearAllMetadataCacheMock };
});

const invokeMock = vi.mocked(invoke);
const captureErrorMock = vi.mocked(captureError);

beforeEach(() => {
  invokeMock.mockReset();
  captureErrorMock.mockReset();
  mocks.deleteMock.mockReset();
  mocks.clearAllMetadataCacheMock.mockReset();
  mocks.deleteMock.mockResolvedValue(undefined);
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

  it('does not run clearAllMetadataCache when invoke fails, and rethrows the invoke error', async () => {
    invokeMock.mockRejectedValue(new Error('ipc down'));

    await expect(clearAppCache()).rejects.toThrow('ipc down');

    expect(mocks.clearAllMetadataCacheMock).not.toHaveBeenCalled();
    expect(
      captureErrorMock.mock.calls.some(([c]) => c.message.includes('clear_local_cache failed'))
    ).toBe(true);
  });
});
