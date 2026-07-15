import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('idb-keyval', () => ({
  keys: vi.fn(),
  delMany: vi.fn(),
  clear: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { keys, delMany, clear } from 'idb-keyval';
import { invoke } from '@tauri-apps/api/core';
import { clearAppCache } from './cache';

const mockedKeys = vi.mocked(keys);
const mockedDelMany = vi.mocked(delMany);
const mockedClear = vi.mocked(clear);
const mockedInvoke = vi.mocked(invoke);

describe('clearAppCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes only cache keys, preserving playlists and history', async () => {
    mockedKeys.mockResolvedValue([
      'drplay_playlists_x@y',
      'drplay_recent_tracks_x@y',
      'metadata_abc',
      '__drplay_metadata_lru',
    ] as unknown as (string | number)[]);
    mockedDelMany.mockResolvedValue(undefined);
    mockedInvoke.mockResolvedValue(undefined);

    await clearAppCache();

    expect(mockedDelMany).toHaveBeenCalledTimes(1);
    expect(mockedDelMany).toHaveBeenCalledWith(['metadata_abc', '__drplay_metadata_lru']);
    expect(mockedClear).not.toHaveBeenCalled();
    expect(mockedInvoke).toHaveBeenCalledWith('clear_local_cache');
  });

  it('does not call clear even when store has only non-cache keys', async () => {
    mockedKeys.mockResolvedValue([
      'drplay_playlists_x@y',
      'drplay_recent_tracks_x@y',
    ] as unknown as (string | number)[]);
    mockedDelMany.mockResolvedValue(undefined);
    mockedInvoke.mockResolvedValue(undefined);

    await clearAppCache();

    expect(mockedDelMany).not.toHaveBeenCalled();
    expect(mockedClear).not.toHaveBeenCalled();
    expect(mockedInvoke).toHaveBeenCalledWith('clear_local_cache');
  });

  it('still invokes clear_local_cache when keys() fails', async () => {
    mockedKeys.mockRejectedValue(new Error('idb boom'));
    mockedInvoke.mockResolvedValue(undefined);

    await expect(clearAppCache()).rejects.toThrow('idb boom');

    expect(mockedClear).not.toHaveBeenCalled();
    expect(mockedDelMany).not.toHaveBeenCalled();
    expect(mockedInvoke).toHaveBeenCalledWith('clear_local_cache');
  });
});
