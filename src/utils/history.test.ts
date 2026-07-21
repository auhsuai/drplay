// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/db';
import {
  recordPlay,
  getRecentlyPlayed,
  getHeavyRotation,
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
});
