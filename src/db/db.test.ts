import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { db } from './db';
import { get as kvGet, set as kvSet } from './kv';
import { runStorageMigration } from './storage';

describe('Dexie storage schema', () => {
  it('exposes typed tables and kv helper', async () => {
    await kvSet('drplay_buffer_seconds', 1400);
    expect(await kvGet('drplay_buffer_seconds')).toBe(1400);
    expect(db.playlists).toBeDefined();
    expect(db.recentTracks).toBeDefined();
    expect(db.metadataCache).toBeDefined();
  });
  it('runStorageMigration is idempotent and safe with empty idb', async () => {
    await runStorageMigration();
    await runStorageMigration();
  });
});
