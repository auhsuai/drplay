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
  metadata?: any; // For future ID3 tag caching
}

export interface SyncState {
  key: string;
  value: any;
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

export class DriveDatabase extends Dexie {
  files!: Table<DriveFile, string>; // Primary key is 'id'
  syncState!: Table<SyncState, string>; // Primary key is 'key'
  favorites!: Table<any, string>; // Primary key is 'id', we store Track objects with an added userEmail index
  errorLogs!: Table<ErrorLogEntry, string>; // Primary key is 'id', index on 'ts'

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
  }
}

export const db = new DriveDatabase();
