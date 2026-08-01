import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { db } from './db';
import { get as kvGet, set as kvSet, del as kvDel } from './kv';

describe('kv storage helper', () => {
  it('round-trips complex values through structured clone', async () => {
    const key = 'kv-roundtrip-complex';
    const value = {
      date: new Date('2026-01-15T10:30:00.000Z'),
      map: new Map<string, number>([['a', 1], ['b', 2]]),
      nested: { u: undefined, s: 'keep' },
    };
    await kvSet(key, value);
    expect(await kvGet<typeof value>(key)).toEqual(value);
  });

  it('returns undefined for missing keys', async () => {
    expect(await kvGet('kv-missing-key')).toBeUndefined();
  });

  it('del removes the value so get returns undefined', async () => {
    const key = 'kv-del-target';
    await kvSet(key, { v: 1 });
    expect(await kvGet(key)).toEqual({ v: 1 });
    await kvDel(key);
    expect(await kvGet(key)).toBeUndefined();
  });

  it('rethrows Dexie errors with name preserved (rethrow contract)', async () => {
    db.close();
    let caught: unknown;
    try {
      await kvGet('kv-after-close');
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toContain('Error');
  });
});
