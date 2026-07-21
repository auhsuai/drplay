import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep the module hermetic: never touch Dexie or the Tauri host in this unit test.
vi.mock('../db/db', () => ({
  db: { metadataCache: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

import {
  getTrackMetadata,
  registerMetadataFetch,
  makePlaceholderMetadata,
  clearAllMetadataCache,
  type CachedMetadata,
} from './metadata';
import { invoke } from '@tauri-apps/api/core';

function fakeMeta(over: Partial<CachedMetadata> = {}): CachedMetadata {
  return {
    title: 'Song',
    artist: 'Artist',
    duration: 10,
    durationEstimated: false,
    pictureData: null,
    pictureDataFull: null,
    v: 10,
    ...over,
  };
}

describe('metadata dedup layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllMetadataCache();
  });

  it('makePlaceholderMetadata strips the extension and marks the track unscanned (v:9)', () => {
    const ph = makePlaceholderMetadata('My Track.flac', 1234);
    expect(ph.title).toBe('My Track');
    expect(ph.artist).toBe('Unknown Artist');
    expect(ph.v).toBe(9);
    expect(ph.size).toBe(1234);
  });

  it('getTrackMetadata awaits a registered batch claim instead of firing its own IPC', async () => {
    const claimed = fakeMeta({ title: 'FromBatch' });
    const registered = registerMetadataFetch('idA', Promise.resolve(claimed));
    expect(registered).toBe(true);

    const got = await getTrackMetadata('idA', 'tok', 0, 'idA.mp3');

    // The card must have deduped against the batch's claim — no get_local_metadata IPC.
    expect(got.title).toBe('FromBatch');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('registerMetadataFetch refuses to double-claim an id already in flight', () => {
    const first = registerMetadataFetch('idB', Promise.resolve(fakeMeta()));
    const second = registerMetadataFetch('idB', Promise.resolve(fakeMeta()));
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
