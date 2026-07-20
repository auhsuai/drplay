// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTrackMetadata, clearAllMetadataCache } from './metadata';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('idb-keyval', () => ({
  get: vi.fn(() => Promise.resolve(undefined)),
  set: vi.fn(() => Promise.resolve()),
  del: vi.fn(() => Promise.resolve()),
}));

const { invoke } = await import('@tauri-apps/api/core');

describe('getTrackMetadata caching', () => {
  beforeEach(() => {
    clearAllMetadataCache();
    vi.mocked(invoke).mockReset();
  });

  it('returns cached metadata on second call without invoking IPC', async () => {
    vi.mocked(invoke).mockResolvedValue({
      id: '123',
      title: 'Real Title',
      artist: 'Real Artist',
      album: '',
      duration: 200,
      has_cover: true,
      file_type: 'audio/mpeg',
    });

    // First call: goes to IPC.
    const r1 = await getTrackMetadata('file-1', 'tok', 1000, 'song.mp3');
    expect(r1.title).toBe('Real Title');
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    // Second call same fileId: should return from memory cache, NO IPC.
    vi.mocked(invoke).mockClear();
    const r2 = await getTrackMetadata('file-1', 'tok', 1000, 'song.mp3');
    expect(r2.title).toBe('Real Title');
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });
});
