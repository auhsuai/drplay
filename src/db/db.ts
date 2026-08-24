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
  userEmail: string; // Owning account (schema v10 per-user scoping)
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

// One row per ACTIVE or INTERRUPTED upload (schema v9). Written by
// uploadManager at processEntry (status 'active'), deleted at any terminal
// transition (done/error/cancel). On the next launch, rows whose upload was
// interrupted mid-flight are the resume source (slice 5.2); 'bytes' rows carry
// no diskPath — their payload is gone with the old process, so they can only
// be reported as interrupted, never resumed.
export interface UploadSessionRow {
  id: string; // = entry.id ('pending-<uuid>') — PK
  userEmail: string; // per-user (index)
  name: string;
  isFolder: boolean;
  kind: "diskFile" | "folderChildFile" | "folderRoot" | "folderChild" | "bytes";
  diskPath?: string; // undefined cho bytes
  parentId: string;
  totalSize?: number; // undefined khi chưa stat / bytes
  uploadUri?: string; // session URI Google — undefined khi chưa initiate
  clientGeneratedId?: string;
  status: "active" | "interrupted";
  createdAt: number;
  updatedAt: number;
}

/**
 * Local IndexedDB mirror of the signed-in user's Drive data (file list,
 * favorites, play history, play counts, folder visits, error logs, app
 * config). The UI reads from here so browsing is instant, while Drive stays
 * the source of truth that gets fetched on demand. Every per-user table is
 * keyed by [userEmail+id] (schema v7, `files` followed in schema v10) so
 * multiple Google accounts never
 * overwrite each other's rows. Schema changes are forward-only: never alter a
 * table's primary key in place — add a new version with new tables and copy.
 */
export class DriveDatabase extends Dexie {
  // Compound PK [userEmail+id] (schema v10) — rebound to filesV2 below so app
  // code keeps talking to db.files.
  files!: Table<DriveFile, [string, string]>;
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
  uploadSessions!: Table<UploadSessionRow, string>; // Primary key is 'id'
  // Compound-key tables that replaced the raw-id versions (schema v7).
  recentTracksV2!: Table<RecentTrackRow, [string, string]>;
  playCountsV2!: Table<PlayCountRow, [string, string]>;
  folderVisitsV2!: Table<FolderVisitRow, [string, string]>;
  favoritesV2!: Table<
    Track & { userEmail: string; createdAt?: number },
    [string, string]
  >;
  filesV2!: Table<DriveFile, [string, string]>; // [userEmail+id] PK (schema v10)

  constructor() {
    super("DrPlayDriveDB");

    // Version 1 as shipped (restored verbatim from 480d43d): Dexie requires
    // every historical version to stay declared so devices whose DB still
    // sits at an old version keep a complete upgrade path.
    this.version(1).stores({
      // Primary key 'id', indexes on 'parentId', 'name', 'isFolder'
      files: "id, parentId, name, isFolder",
      syncState: "key",
    });

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

    // Version 9 adds the uploadSessions table (upload-resume feature, slice
    // 5.1) without touching the existing tables — forward-only, same as every
    // earlier version. Rows are indexed by userEmail (resume is per-account)
    // and status ('active' vs 'interrupted').
    this.version(9).stores({
      files: "id, parentId, name, isFolder",
      syncState: "key",
      errorLogs: "id, ts",
      kv: "key",
      playlists: "id, userEmail",
      recentTracksV2: "[userEmail+id], createdAt, [userEmail+createdAt]",
      playCountsV2: "[userEmail+id], [userEmail+count]",
      folderVisitsV2: "[userEmail+id], [userEmail+count]",
      favoritesV2: "[userEmail+id], createdAt",
      uploadSessions: "id, userEmail, status",
    });

    // Version 10 fixes the same cross-user collision for `files` that v7
    // fixed for the per-user tables above: rows were keyed by RAW Drive id,
    // so two accounts' mirrors of the same file overwrote each other. Dexie
    // cannot change an existing table's primary key in place (UpgradeError),
    // so — same precedent as v7 — this version adds filesV2 with a compound
    // [userEmail+id] primary key and copies the old rows into it. The
    // standalone "id" index is kept ON PURPOSE even though id is part of the
    // compound PK: upload/queue.ts ghost sweep reads
    // where("id").startsWith("pending-") across owners, and
    // [userEmail+parentId] gives the listing its per-user folder query.
    this.version(10)
      .stores({
        filesV2:
          "[userEmail+id], id, parentId, name, isFolder, [userEmail+parentId]",
      })
      .upgrade(async (tx) => {
        // Plan A1.3: every legacy row belongs to whichever account was active
        // at the first launch after the upgrade (accepted one-time assignment;
        // other accounts re-mirror on their next sync). The email read below
        // never throws — its internal try/catch returns "default" — which is
        // exactly the worker-realm safety net: proSync.worker opens
        // its own connection where localStorage does not exist, and a throw
        // here would abort the whole upgrade transaction.
        //
        // Deliberately NOT imported from utils/storageKeys: storageKeys →
        // errorLog → db forms an import cycle once db needs the owner email,
        // and under vitest's errorLog mock that cycle re-binds storageKeys'
        // captureError away from the mocked instance (broke apiClient.test
        // localStorage-failure assertions). Keep this read self-contained;
        // the key string and sentinel mirror storageKeys' USER_EMAIL_KEY /
        // DEFAULT_USER_EMAIL — update both together if they ever change.
        const owner = (() => {
          try {
            return (
              localStorage.getItem("drplay_current_user_email") || "default"
            );
          } catch {
            return "default";
          }
        })();
        const legacyRows = (await tx.table("files").toArray()) as DriveFile[];
        await tx.table("filesV2").bulkPut(
          legacyRows.map((row) => ({
            ...row,
            userEmail: owner,
          })),
        );
      });

    // Bind the public table names to the new compound-key tables so app code
    // (history.ts / favorites.ts / every db.files consumer) keeps talking to
    // the current tables.
    this.files = this.filesV2;
    this.recentTracks = this.recentTracksV2;
    this.playCounts = this.playCountsV2;
    this.folderVisits = this.folderVisitsV2;
    this.favorites = this.favoritesV2;
  }
}

/**
 * The app-wide singleton database. Always import this instead of constructing
 * a second DriveDatabase — two instances would run schema upgrades twice and
 * hold competing connections to the same IndexedDB store.
 */
export const db = new DriveDatabase();
