import { db } from '../db/db';
import { Track } from '../App';

const RECENT_CAP = 1000;

function currentUserEmail(): string {
  return localStorage.getItem('drplay_current_user_email') || 'default';
}

export interface PlayCountEntry {
  track: Track;
  count: number;
}

export interface FolderVisitEntry {
  id: string;
  name: string;
  count: number;
  lastVisited: number;
}

export async function recordPlay(track: Track) {
  const email = currentUserEmail();
  try {
    const existing = await db.recentTracks.where('userEmail').equals(email).and((r) => r.id === track.id).toArray();
    if (existing.length) {
      await db.recentTracks.delete(existing[0].id);
    }
    await db.recentTracks.put({ id: track.id, track, userEmail: email, createdAt: Date.now() });

    const countRows = await db.playCounts.where('userEmail').equals(email).and((r) => r.id === track.id).toArray();
    const countRow = countRows[0];
    const nextCount = (countRow?.count || 0) + 1;
    await db.playCounts.put({ id: track.id, track, count: nextCount, userEmail: email });
  } catch (e) {
    console.error('[history] recordPlay-failed', e instanceof Error ? e.message : String(e));
  }

  window.dispatchEvent(new Event('recent-updated'));
}

export async function getRecentlyPlayed(): Promise<Track[]> {
  const email = currentUserEmail();
  try {
    const rows = await db.recentTracks.where('userEmail').equals(email).toArray();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const deduped: Track[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      deduped.push(row.track);
    }
    return deduped.slice(0, RECENT_CAP);
  } catch (e) {
    console.error('[history] getRecentlyPlayed-failed', e instanceof Error ? e.message : String(e));
    return [];
  }
}

export async function getHeavyRotation(): Promise<Track[]> {
  const email = currentUserEmail();
  try {
    const rows = await db.playCounts.where('userEmail').equals(email).toArray();
    return rows
      .sort((a, b) => b.count - a.count)
      .map((row) => row.track)
      .slice(0, 10);
  } catch (e) {
    console.error('[history] getHeavyRotation-failed', e instanceof Error ? e.message : String(e));
    return [];
  }
}

export async function getRandomDiscoveries(): Promise<Track[]> {
  try {
    const rows = await db.metadataCache.toArray();
    const keys = rows
      .filter((r) => r.entry && r.entry.data && r.entry.data.v >= 9)
      .map((r) => r.key as string)
      .filter((k) => typeof k === 'string' && k.startsWith('metadata_'));
    if (keys.length === 0) return [];

    const shuffled = [...keys];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const selectedKeys = shuffled.slice(0, 12);

    const tracks: Track[] = [];
    for (const key of selectedKeys) {
      const id = key.replace('metadata_', '');
      tracks.push({
        id,
        title: 'Audio Track',
        artist: '',
        streamUrl: ''
      });
    }
    return tracks;
  } catch (e) {
    console.error('[history] getRandomDiscoveries-failed', e instanceof Error ? e.message : String(e));
    return [];
  }
}

export async function recordFolderVisit(folderId: string, folderName: string) {
  if (folderId === 'root') return;
  const email = currentUserEmail();
  try {
    const existingRows = await db.folderVisits.where('userEmail').equals(email).and((r) => r.id === folderId).toArray();
    const existing = existingRows[0];
    const now = Date.now();
    const count = (existing?.count || 0) + 1;
    await db.folderVisits.put({ id: folderId, name: folderName, count, lastVisited: now, userEmail: email });
  } catch (e) {
    console.error('[history] recordFolderVisit-failed', e instanceof Error ? e.message : String(e));
  }
}

export async function getMostVisitedFolders(): Promise<FolderVisitEntry[]> {
  const email = currentUserEmail();
  try {
    const rows = await db.folderVisits.where('userEmail').equals(email).toArray();
    return rows
      .sort((a, b) => b.count - a.count || b.lastVisited - a.lastVisited)
      .slice(0, 4)
      .map((r) => ({ id: r.id, name: r.name, count: r.count, lastVisited: r.lastVisited }));
  } catch (e) {
    console.error('[history] getMostVisitedFolders-failed', e instanceof Error ? e.message : String(e));
    return [];
  }
}
