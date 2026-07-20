import { db } from './db';
import { get as idbGet, keys as idbKeys } from 'idb-keyval';

const MIGRATION_FLAG = 'drplay_storage_migrated_v4';

function userEmail(): string {
  return localStorage.getItem('drplay_current_user_email') || 'default';
}

let _migrationPromise: Promise<void> | null = null;

export function ensureStorageMigration(): Promise<void> {
  if (!_migrationPromise) {
    _migrationPromise = runStorageMigration().catch((e) => {
      console.error('[storage] ensureStorageMigration-failed', e instanceof Error ? e.message : String(e));
    });
  }
  return _migrationPromise;
}

export async function runStorageMigration(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATION_FLAG)) return;
    const email = userEmail();

    // playlists
    const oldPlaylists = await idbGet<any[]>(emailKey('drplay_playlists'));
    if (oldPlaylists?.length) {
      await db.playlists.bulkPut(oldPlaylists.map(p => ({ ...p, userEmail: email })));
    }
    // recent tracks
    const oldRecent = await idbGet<any[]>(emailKey('drplay_recent_tracks'));
    if (oldRecent?.length) {
      await db.recentTracks.bulkPut(oldRecent.map((t, i) => ({ id: t.id, track: t, userEmail: email, createdAt: Date.now() - i })));
    }
    // play counts
    const oldCounts = await idbGet<Record<string, any>>(emailKey('drplay_play_counts'));
    if (oldCounts) {
      const rows = Object.values(oldCounts).map(e => ({ id: e.track.id, track: e.track, count: e.count, userEmail: email }));
      if (rows.length) await db.playCounts.bulkPut(rows);
    }
    // folder visits
    const oldVisits = await idbGet<Record<string, any>>(emailKey('drplay_folder_visits'));
    if (oldVisits) {
      const rows = Object.values(oldVisits).map(e => ({ id: e.id, name: e.name, count: e.count, lastVisited: e.lastVisited, userEmail: email }));
      if (rows.length) await db.folderVisits.bulkPut(rows);
    }
    // metadata cache entries (metadata_${id})
    const allKeys = await idbKeys();
    const metaKeys = allKeys.filter((k): k is string => typeof k === 'string' && k.startsWith('metadata_'));
    if (metaKeys.length) {
      const rows = await Promise.all(metaKeys.map(async k => ({ key: k, entry: await idbGet(k) })));
      await db.metadataCache.bulkPut(rows.filter(r => r.entry));
    }
    // session + buffer flags
    const buffer = await idbGet('drplay_buffer_seconds');
    if (buffer !== undefined) await db.kv.put({ key: 'drplay_buffer_seconds', value: buffer });
    const queue = await idbGet('drplay_queue');
    if (queue !== undefined) await db.kv.put({ key: 'drplay_queue', value: queue });
    const playmode = await idbGet('drplay_playmode');
    if (playmode !== undefined) await db.kv.put({ key: 'drplay_playmode', value: playmode });
    const session = await idbGet('drplay_last_session');
    if (session !== undefined) await db.kv.put({ key: 'drplay_last_session', value: session });

    localStorage.setItem(MIGRATION_FLAG, 'true');
  } catch (e) {
    console.error('[storage] migration-failed', e instanceof Error ? e.message : String(e));
  }
}

function emailKey(base: string): string {
  const email = localStorage.getItem('drplay_current_user_email');
  return email ? `${base}_${email}` : base;
}
