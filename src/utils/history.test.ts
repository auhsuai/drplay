// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/db';
import {
  recordPlay,
  getRecentlyPlayed,
  getHeavyRotation,
  getRandomDiscoveries,
  recordFolderVisit,
  getMostVisitedFolders,
  PlayCountEntry,
  FolderVisitEntry,
} from './history';

const TRACK: any = { id: 't1', title: 'Song One', artist: 'Artist A', streamUrl: 'x' };
const TRACK2: any = { id: 't2', title: 'Song Two', artist: 'Artist B', streamUrl: 'y' };

function setUser(email: string | null) {
  if (email) localStorage.setItem('drplay_current_user_email', email);
  else localStorage.removeItem('drplay_current_user_email');
}

async function clearAll() {
  await db.recentTracks.clear();
  await db.playCounts.clear();
  await db.folderVisits.clear();
  await db.metadataCache.clear();
}

describe('history (Dexie-backed)', () => {
  beforeEach(async () => {
    setUser(null);
    await clearAll();
  });
  afterEach(async () => {
    await clearAll();
  });

  it('recordPlay adds to recent and increments play count', async () => {
    await recordPlay(TRACK);
    await recordPlay(TRACK);

    const recents = await getRecentlyPlayed();
    expect(recents).toHaveLength(1);
    expect(recents[0].id).toBe('t1');

    const heavy = await getHeavyRotation();
    expect(heavy).toHaveLength(1);
    expect((heavy[0] as any).id).toBe('t1');
  });

  it('recordPlay dedupes recents (newest first)', async () => {
    await recordPlay(TRACK);
    await recordPlay(TRACK2);
    await recordPlay(TRACK);

    const recents = await getRecentlyPlayed();
    expect(recents.map((t: any) => t.id)).toEqual(['t1', 't2']);
  });

  it('getHeavyRotation sorts by count desc and caps at 10', async () => {
    await recordPlay(TRACK2); // count 1
    await recordPlay(TRACK); // count 1
    await recordPlay(TRACK); // t1 count 2

    const heavy = await getHeavyRotation();
    expect((heavy[0] as any).id).toBe('t1');
    expect(heavy.length).toBeLessThanOrEqual(10);
  });

  it('getRandomDiscoveries reads metadataCache entries', async () => {
    await db.metadataCache.bulkPut([
      { key: 'metadata_a', entry: { version: 9, data: { v: 9 }, ts: 1 } },
      { key: 'metadata_b', entry: { version: 9, data: { v: 9 }, ts: 2 } },
      { key: 'metadata_c', entry: { version: 9, data: { v: 9 }, ts: 3 } },
    ]);

    const discoveries = await getRandomDiscoveries();
    expect(discoveries.length).toBeGreaterThan(0);
    const ids = discoveries.map((t: any) => t.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('recordFolderVisit tracks counts and name', async () => {
    await recordFolderVisit('f1', 'Folder One');
    await recordFolderVisit('f1', 'Folder One');
    await recordFolderVisit('f2', 'Folder Two');

    const visits = await getMostVisitedFolders();
    expect(visits).toHaveLength(2);
    expect(visits[0].id).toBe('f1');
    expect(visits[0].count).toBe(2);
    expect(visits[0].name).toBe('Folder One');
  });

  it('getMostVisitedFolders ignores root and caps at 4', async () => {
    await recordFolderVisit('root', 'Root');
    for (let i = 0; i < 6; i++) {
      await recordFolderVisit(`f${i}`, `Folder ${i}`);
    }
    const visits = await getMostVisitedFolders();
    expect(visits.find((v: FolderVisitEntry) => v.id === 'root')).toBeUndefined();
    expect(visits.length).toBeLessThanOrEqual(4);
  });

  it('isolates data per userEmail', async () => {
    setUser('a@x.com');
    await recordPlay(TRACK);
    setUser('b@x.com');
    await recordPlay(TRACK2);

    setUser('a@x.com');
    const aRecents = await getRecentlyPlayed();
    expect(aRecents.map((t: any) => t.id)).toEqual(['t1']);
    const aHeavy = await getHeavyRotation();
    expect(aHeavy.map((t: any) => t.id)).toEqual(['t1']);
  });

  it('respects PlayCountEntry/FolderVisitEntry shapes', async () => {
    await recordPlay(TRACK);
    const counts: PlayCountEntry[] = await db.playCounts.toArray().then((rows) =>
      rows.map((r) => ({ track: r.track, count: r.count }))
    );
    expect(counts[0].count).toBe(1);

    await recordFolderVisit('f1', 'X');
    const visits: FolderVisitEntry[] = await db.folderVisits.toArray().then((rows) =>
      rows.map((r) => ({ id: r.id, name: r.name, count: r.count, lastVisited: r.lastVisited }))
    );
    expect(visits[0].id).toBe('f1');
  });

  it('#9 regression: recordPlay prunes recentTracks to RECENT_CAP (1000) on write', async () => {
    const seeds: any[] = [];
    for (let i = 0; i < 1004; i++) {
      seeds.push({
        id: `seed_${i}`,
        track: { id: `seed_${i}`, title: `Seed ${i}`, artist: 'A', streamUrl: 'x' },
        userEmail: 'default',
        createdAt: 1_000_000 + i * 1000,
      });
    }
    await db.recentTracks.bulkPut(seeds);

    await recordPlay(TRACK);

    const count = await db.recentTracks.count();
    expect(count).toBeLessThanOrEqual(1000);
    expect(count).toBe(1000);

    const newest = await db.recentTracks.get(TRACK.id);
    expect(newest).toBeDefined();
    const oldest = await db.recentTracks.get('seed_0');
    expect(oldest).toBeUndefined();
  });

  it('#9 variant: small number of plays never loses data', async () => {
    for (let i = 0; i < 10; i++) {
      await recordPlay({ id: `t_${i}`, title: `Track ${i}`, artist: 'A', streamUrl: 'x' } as any);
    }
    const count = await db.recentTracks.count();
    expect(count).toBe(10);
    const recents = await getRecentlyPlayed();
    expect(recents).toHaveLength(10);
  });

  it('#9 variant: recordPlay on empty table works and keeps the entry', async () => {
    await recordPlay(TRACK);
    expect(await db.recentTracks.count()).toBe(1);
    const recents = await getRecentlyPlayed();
    expect(recents.map((t: any) => t.id)).toEqual(['t1']);
  });

  it('#9 variant: prune keeps the newest entry and evicts only the oldest past cap', async () => {
    const seeds: any[] = [];
    for (let i = 0; i < 1004; i++) {
      seeds.push({
        id: `seed_${i}`,
        track: { id: `seed_${i}`, title: `Seed ${i}`, artist: 'A', streamUrl: 'x' },
        userEmail: 'default',
        createdAt: 1_000_000 + i * 1000,
      });
    }
    await db.recentTracks.bulkPut(seeds);
    await recordPlay(TRACK);

    const recents = await getRecentlyPlayed();
    expect(recents[0].id).toBe('t1');
    const ids = new Set((await db.recentTracks.toArray()).map((r) => r.id));
    expect(ids.size).toBe(1000);
    expect(ids.has('t1')).toBe(true);
    for (let i = 5; i < 1004; i++) expect(ids.has(`seed_${i}`)).toBe(true);
    for (let i = 0; i < 5; i++) expect(ids.has(`seed_${i}`)).toBe(false);
  });

  it('#9 variant: prune is scoped per userEmail (no cross-user eviction)', async () => {
    setUser('a@x.com');
    const seeds: any[] = [];
    for (let i = 0; i < 1004; i++) {
      seeds.push({
        id: `a_seed_${i}`,
        track: { id: `a_seed_${i}`, title: `Seed ${i}`, artist: 'A', streamUrl: 'x' },
        userEmail: 'a@x.com',
        createdAt: 1_000_000 + i * 1000,
      });
    }
    await db.recentTracks.bulkPut(seeds);
    await recordPlay({ id: 'a_new', title: 'A New', artist: 'A', streamUrl: 'x' } as any);

    setUser('b@x.com');
    for (let i = 0; i < 3; i++) {
      await recordPlay({ id: `b_${i}`, title: `B ${i}`, artist: 'B', streamUrl: 'x' } as any);
    }

    const aCount = await db.recentTracks.where('userEmail').equals('a@x.com').count();
    const bCount = await db.recentTracks.where('userEmail').equals('b@x.com').count();
    expect(aCount).toBe(1000);
    expect(bCount).toBe(3);
    expect(await db.recentTracks.get('a_new')).toBeDefined();
    expect(await db.recentTracks.get('b_2')).toBeDefined();
    expect(await db.recentTracks.get('a_seed_0')).toBeUndefined();
  });

  it('#playCounts cap: recordPlay prunes playCounts to PLAY_COUNT_CAP (1000) on write', async () => {
    const seeds: any[] = [];
    for (let i = 0; i < 1004; i++) {
      seeds.push({
        id: `pseed_${i}`,
        track: { id: `pseed_${i}`, title: `Seed ${i}`, artist: 'A', streamUrl: 'x' },
        count: i + 1,
        userEmail: 'default',
      });
    }
    await db.playCounts.bulkPut(seeds);
    await db.playCounts.put({ id: 't1', track: TRACK, count: 50, userEmail: 'default' });

    await recordPlay(TRACK);

    expect(await db.playCounts.count()).toBe(1000);
    const updated = await db.playCounts.get('t1');
    expect(updated).toBeDefined();
    expect(updated?.count).toBe(51);
    for (let i = 0; i < 5; i++) expect(await db.playCounts.get(`pseed_${i}`)).toBeUndefined();
    for (let i = 5; i < 1004; i++) expect(await db.playCounts.get(`pseed_${i}`)).toBeDefined();
  });

  it('#playCounts cap variant: getHeavyRotation returns top 10 by count from the index', async () => {
    const seeds: any[] = [];
    for (let i = 0; i < 20; i++) {
      seeds.push({
        id: `p_${i}`,
        track: { id: `p_${i}`, title: `P ${i}`, artist: 'A', streamUrl: 'x' },
        count: i + 1,
        userEmail: 'default',
      });
    }
    await db.playCounts.bulkPut(seeds);

    const heavy = await getHeavyRotation();
    expect(heavy.map((t: any) => t.id)).toEqual([
      'p_19', 'p_18', 'p_17', 'p_16', 'p_15',
      'p_14', 'p_13', 'p_12', 'p_11', 'p_10',
    ]);
  });

  it('#playCounts cap variant: prune is scoped per userEmail (no cross-user eviction)', async () => {
    setUser('a@x.com');
    const seeds: any[] = [];
    for (let i = 0; i < 1004; i++) {
      seeds.push({
        id: `a_p_${i}`,
        track: { id: `a_p_${i}`, title: `Seed ${i}`, artist: 'A', streamUrl: 'x' },
        count: i + 1,
        userEmail: 'a@x.com',
      });
    }
    await db.playCounts.bulkPut(seeds);
    await db.playCounts.put({
      id: 'a_t',
      track: { id: 'a_t', title: 'A T', artist: 'A', streamUrl: 'x' },
      count: 50,
      userEmail: 'a@x.com',
    });
    await recordPlay({ id: 'a_t', title: 'A T', artist: 'A', streamUrl: 'x' } as any);

    setUser('b@x.com');
    await recordPlay({ id: 'b_1', title: 'B 1', artist: 'B', streamUrl: 'x' } as any);

    const aCount = await db.playCounts.where('userEmail').equals('a@x.com').count();
    const bCount = await db.playCounts.where('userEmail').equals('b@x.com').count();
    expect(aCount).toBe(1000);
    expect(bCount).toBe(1);
    expect(await db.playCounts.get('a_t')).toBeDefined();
    expect(await db.playCounts.get('a_p_5')).toBeDefined();
    expect(await db.playCounts.get('a_p_0')).toBeUndefined();
    expect(await db.playCounts.get('b_1')).toBeDefined();
  });

  it('#playCounts cap variant: small number of plays never loses data', async () => {
    for (let i = 0; i < 10; i++) {
      await recordPlay({ id: `t_${i}`, title: `Track ${i}`, artist: 'A', streamUrl: 'x' } as any);
    }
    expect(await db.playCounts.count()).toBe(10);
    const heavy = await getHeavyRotation();
    expect(heavy).toHaveLength(10);
  });

  it('#folderVisits cap: recordFolderVisit prunes folderVisits to FOLDER_VISIT_CAP (1000) on write', async () => {
    const seeds: any[] = [];
    for (let i = 0; i < 1004; i++) {
      seeds.push({
        id: `fseed_${i}`,
        name: `Seed ${i}`,
        count: i + 1,
        lastVisited: 1_000_000 + i,
        userEmail: 'default',
      });
    }
    await db.folderVisits.bulkPut(seeds);
    await db.folderVisits.put({ id: 'f_new', name: 'New', count: 2000, lastVisited: Date.now(), userEmail: 'default' });

    await recordFolderVisit('f_new', 'New');

    expect(await db.folderVisits.count()).toBe(1000);
    const updated = await db.folderVisits.get('f_new');
    expect(updated).toBeDefined();
    expect(updated?.count).toBe(2001);
    for (let i = 0; i < 5; i++) expect(await db.folderVisits.get(`fseed_${i}`)).toBeUndefined();
    for (let i = 5; i < 1004; i++) expect(await db.folderVisits.get(`fseed_${i}`)).toBeDefined();
    const top = await getMostVisitedFolders();
    expect(top[0].id).toBe('f_new');
  });
});
