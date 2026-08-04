import type { Table } from "dexie";
import Dexie from "dexie";
import type { Track } from "../types";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parentId: string; // The primary parent ID
  size?: number | undefined;
  modifiedTime?: string | undefined;
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
  level: "error" | "warn" | "info";
  source: string;
  message: string;
  stack?: string | undefined;
  kind?: string | undefined;
}

export interface KvRow {
  key: string;
  value: unknown;
}
export interface PlaylistRow {
  id: string;
  name: string;
  createdAt: number;
  tracks: Track[];
  coverImage?: string | undefined;
  userEmail: string;
}
export interface RecentTrackRow {
  id: string;
  track: Track;
  userEmail: string;
  createdAt: number;
}
export interface PlayCountRow {
  id: string;
  track: Track;
  count: number;
  userEmail: string;
}
export interface FolderVisitRow {
  id: string;
  name: string;
  count: number;
  lastVisited: number;
  userEmail: string;
}
export interface MetadataCacheRow {
  key: string;
  entry: unknown;
}

export class DriveDatabase extends Dexie {
  files!: Table<DriveFile, string>; // Primary key is 'id'
  syncState!: Table<SyncState, string>; // Primary key is 'key'
  favorites!: Table<
    Track & { userEmail: string; createdAt?: number },
    [string, string]
  >; // Compound PK [userEmail+id] (schema v7)
  errorLogs!: Table<ErrorLogEntry, string>; // Primary key is 'id', index on 'ts'
  kv!: Table<KvRow, string>;
  playlists!: Table<PlaylistRow, string>;
  recentTracks!: Table<RecentTrackRow, [string, string]>;
  playCounts!: Table<PlayCountRow, [string, string]>;
  folderVisits!: Table<FolderVisitRow, [string, string]>;
  metadataCache!: Table<MetadataCacheRow, string>;
  // Compound-key tables that replaced the raw-id versions (schema v7).
  recentTracksV2!: Table<RecentTrackRow, [string, string]>;
  playCountsV2!: Table<PlayCountRow, [string, string]>;
  folderVisitsV2!: Table<FolderVisitRow, [string, string]>;
  favoritesV2!: Table<
    Track & { userEmail: string; createdAt?: number },
    [string, string]
  >;

  constructor() {
    super("DrPlayDriveDB");

    // Keep old schema intact so existing data is preserved on upgrade.
    this.version(2).stores({
      // Primary key 'id', indexes on 'parentId', 'name', 'isFolder'
      files: "id, parentId, name, isFolder",
      syncState: "key",
      favorites: "id, userEmail",
    });

    // Version 3 adds the errorLogs table without touching the old tables.
    this.version(3).stores({
      files: "id, parentId, name, isFolder",
      syncState: "key",
      favorites: "id, userEmail",
      errorLogs: "id, ts",
    });

    // Version 4 adds the consolidated typed storage tables.
    this.version(4).stores({
      files: "id, parentId, name, isFolder",
      syncState: "key",
      favorites: "id, userEmail",
      errorLogs: "id, ts",
      kv: "key",
      playlists: "id, userEmail",
      recentTracks: "id, userEmail, createdAt",
      playCounts: "id, userEmail",
      folderVisits: "id, userEmail",
      metadataCache: "key",
    });

    // Version 5 adds a compound [userEmail+createdAt] index on recentTracks
    // so write-time pruning (history.ts RECENT_CAP) can delete stale rows per
    // user without reading the whole table. Adding an index preserves data
    // (only primary-key changes would clear it).
    this.version(5).stores({
      files: "id, parentId, name, isFolder",
      syncState: "key",
      favorites: "id, userEmail",
      errorLogs: "id, ts",
      kv: "key",
      playlists: "id, userEmail",
      recentTracks: "id, userEmail, createdAt, [userEmail+createdAt]",
      playCounts: "id, userEmail",
      folderVisits: "id, userEmail",
      metadataCache: "key",
    });

    // Version 6 adds compound [userEmail+count] indexes on playCounts and
    // folderVisits so write-time caps (history.ts PLAY_COUNT_CAP /
    // FOLDER_VISIT_CAP) can evict the least-played / least-visited rows per
    // user without reading the whole table, and so getHeavyRotation can read
    // the top 10 by count straight from the index. Adding indexes preserves
    // data (only primary-key changes would clear it).
    this.version(6).stores({
      files: "id, parentId, name, isFolder",
      syncState: "key",
      favorites: "id, userEmail",
      errorLogs: "id, ts",
      kv: "key",
      playlists: "id, userEmail",
      recentTracks: "id, userEmail, createdAt, [userEmail+createdAt]",
      playCounts: "id, userEmail, [userEmail+count]",
      folderVisits: "id, userEmail, [userEmail+count]",
      metadataCache: "key",
    });

    // Version 7 fixes the cross-user primary-key collision: the 4 per-user
    // tables were keyed by RAW id (track.id / folderId) with userEmail only
    // an index, so two users playing/favoriting/visiting the SAME id
    // overwrote each other's rows (IndexedDB put() is keyed by primary key).
    // Changing the PK of an existing table in-place throws UpgradeError, so
    // this version adds NEW tables with compound [userEmail+id] primary keys
    // and copies the old rows into them. Queries keep working because the
    // first part of a compound key is an implicit index (where('userEmail')
    // stays valid) and put({id, userEmail, ...}) auto-builds the compound
    // key from the keyPath.
    this.version(7)
      .stores({
        files: "id, parentId, name, isFolder",
        syncState: "key",
        favorites: "id, userEmail",
        errorLogs: "id, ts",
        kv: "key",
        playlists: "id, userEmail",
        recentTracks: "id, userEmail, createdAt, [userEmail+createdAt]",
        playCounts: "id, userEmail, [userEmail+count]",
        folderVisits: "id, userEmail, [userEmail+count]",
        metadataCache: "key",
        recentTracksV2: "[userEmail+id], createdAt, [userEmail+createdAt]",
        playCountsV2: "[userEmail+id], [userEmail+count]",
        folderVisitsV2: "[userEmail+id], [userEmail+count]",
        favoritesV2: "[userEmail+id], createdAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("recentTracksV2")
          .bulkPut(await tx.table("recentTracks").toArray());
        await tx
          .table("playCountsV2")
          .bulkPut(await tx.table("playCounts").toArray());
        await tx
          .table("folderVisitsV2")
          .bulkPut(await tx.table("folderVisits").toArray());
        await tx
          .table("favoritesV2")
          .bulkPut(await tx.table("favorites").toArray());
      });

    // Version 8 drops the obsolete raw-id tables now that every row lives in
    // the compound-key V2 tables.
    this.version(8).stores({
      favorites: null,
      recentTracks: null,
      playCounts: null,
      folderVisits: null,
      recentTracksV2: "[userEmail+id], createdAt, [userEmail+createdAt]",
      playCountsV2: "[userEmail+id], [userEmail+count]",
      folderVisitsV2: "[userEmail+id], [userEmail+count]",
      favoritesV2: "[userEmail+id], createdAt",
    });

    // Bind the public table names to the new compound-key tables so app code
    // (history.ts / favorites.ts) keeps talking to db.recentTracks etc.
    this.recentTracks = this.recentTracksV2;
    this.playCounts = this.playCountsV2;
    this.folderVisits = this.folderVisitsV2;
    this.favorites = this.favoritesV2;
  }
}

export const db = new DriveDatabase();
