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

export class DriveDatabase extends Dexie {
  files!: Table<DriveFile, string>; // Primary key is 'id'
  syncState!: Table<SyncState, string>; // Primary key is 'key'
  favorites!: Table<any, string>; // Primary key is 'id', we store Track objects with an added userEmail index

  constructor() {
    super('DrPlayDriveDB');
    
    // Define schema
    this.version(2).stores({
      // Primary key 'id', indexes on 'parentId', 'name', 'isFolder'
      files: 'id, parentId, name, isFolder',
      syncState: 'key',
      favorites: 'id, userEmail'
    });
  }
}

export const db = new DriveDatabase();
