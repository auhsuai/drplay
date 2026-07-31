import Dexie, { Table } from 'dexie';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parentId: string; // The primary parent ID
  size?: number;
  modifiedTime?: string;
  trashed: boolean;
  isFolder: boolean;
  metadata?: unknown; // For future ID3 tag caching
}

export interface SyncState {
  key: string;
  value: unknown;
}

export interface ErrorLogEntry {
  id: string;
  ts: number;
  level: 'error' | 'warn' | 'info';
  source: string;
  message: string;
  stack?: string;
  kind?: string;
}

export interface KvRow { key: string; value: unknown; }
export interface PlaylistRow { id: string; name: string; createdAt: number; tracks: any[]; coverImage?: string; userEmail: string; }
export interface RecentTrackRow { id: string; track: any; userEmail: string; createdAt: number; }
export interface PlayCountRow { id: string; track: any; count: number; userEmail: string; }
export interface FolderVisitRow { id: string; name: string; count: number; lastVisited: number; userEmail: string; }
export interface MetadataCacheRow { key: string; entry: unknown; }

export class DriveDatabase extends Dexie {
  files!: Table<DriveFile, string>; // Primary key is 'id'
  syncState!: Table<SyncState, string>; // Primary key is 'key'
  favorites!: Table<any, string>; // Primary key is 'id', we store Track objects with an added userEmail index
  errorLogs!: Table<ErrorLogEntry, string>; // Primary key is 'id', index on 'ts'
  kv!: Table<KvRow, string>;
  playlists!: Table<PlaylistRow, string>;
  recentTracks!: Table<RecentTrackRow, string>;
  playCounts!: Table<PlayCountRow, string>;
  folderVisits!: Table<FolderVisitRow, string>;
  metadataCache!: Table<MetadataCacheRow, string>;

  constructor() {
    super('DrPlayDriveDB');

    // Keep old schema intact so existing data is preserved on upgrade.
    this.version(2).stores({
      // Primary key 'id', indexes on 'parentId', 'name', 'isFolder'
      files: 'id, parentId, name, isFolder',
      syncState: 'key',
      favorites: 'id, userEmail'
    });

    // Version 3 adds the errorLogs table without touching the old tables.
    this.version(3).stores({
      files: 'id, parentId, name, isFolder',
      syncState: 'key',
      favorites: 'id, userEmail',
      errorLogs: 'id, ts'
    });

    // Version 4 adds the consolidated typed storage tables.
    this.version(4).stores({
      files: 'id, parentId, name, isFolder',
      syncState: 'key',
      favorites: 'id, userEmail',
      errorLogs: 'id, ts',
      kv: 'key',
      playlists: 'id, userEmail',
      recentTracks: 'id, userEmail, createdAt',
      playCounts: 'id, userEmail',
      folderVisits: 'id, userEmail',
      metadataCache: 'key'
    });

    // Version 5 adds a compound [userEmail+createdAt] index on recentTracks
    // so write-time pruning (history.ts RECENT_CAP) can delete stale rows per
    // user without reading the whole table. Adding an index preserves data
    // (only primary-key changes would clear it).
    this.version(5).stores({
      files: 'id, parentId, name, isFolder',
      syncState: 'key',
      favorites: 'id, userEmail',
      errorLogs: 'id, ts',
      kv: 'key',
      playlists: 'id, userEmail',
      recentTracks: 'id, userEmail, createdAt, [userEmail+createdAt]',
      playCounts: 'id, userEmail',
      folderVisits: 'id, userEmail',
      metadataCache: 'key'
    });

    // Version 6 adds compound [userEmail+count] indexes on playCounts and
    // folderVisits so write-time caps (history.ts PLAY_COUNT_CAP /
    // FOLDER_VISIT_CAP) can evict the least-played / least-visited rows per
    // user without reading the whole table, and so getHeavyRotation can read
    // the top 10 by count straight from the index. Adding indexes preserves
    // data (only primary-key changes would clear it).
    this.version(6).stores({
      files: 'id, parentId, name, isFolder',
      syncState: 'key',
      favorites: 'id, userEmail',
      errorLogs: 'id, ts',
      kv: 'key',
      playlists: 'id, userEmail',
      recentTracks: 'id, userEmail, createdAt, [userEmail+createdAt]',
      playCounts: 'id, userEmail, [userEmail+count]',
      folderVisits: 'id, userEmail, [userEmail+count]',
      metadataCache: 'key'
    });
  }
}

export const db = new DriveDatabase();
