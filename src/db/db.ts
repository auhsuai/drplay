import Dexie, { Table } from 'dexie';
import { Track } from '../App';

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
export interface PlaylistRow { id: string; name: string; createdAt: number; tracks: Track[]; coverImage?: string; userEmail: string; }
export interface RecentTrackRow { id: string; track: Track; userEmail: string; createdAt: number; }
export interface PlayCountRow { id: string; track: Track; count: number; userEmail: string; }
export interface FolderVisitRow { id: string; name: string; count: number; lastVisited: number; userEmail: string; }
export interface MetadataCacheRow { key: string; entry: unknown; }
// `favorites` rows are a Track plus the two fields addFavorite() stamps on
// (userEmail, createdAt) — was `Table<any, string>`, which meant Dexie gave
// zero compile-time protection against writing a malformed row here. Every
// other row-shaped table below is typed against a real interface; this now
// matches that bar instead of being the one silent hole.
export interface FavoriteRow extends Track { userEmail: string; createdAt: number; }

export class DriveDatabase extends Dexie {
  files!: Table<DriveFile, string>; // Primary key is 'id'
  syncState!: Table<SyncState, string>; // Primary key is 'key'
  favorites!: Table<FavoriteRow, string>; // Primary key is 'id', we store Track objects with an added userEmail index
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
  }
}

export const db = new DriveDatabase();
