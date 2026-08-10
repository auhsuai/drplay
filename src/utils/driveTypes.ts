export const DRIVE_MODULE = "driveApi";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

// Shared files.list `fields` mask fragment for audio listings. One source of
// truth so every list request (recents, folder on-demand fetch, proSync
// full/delta sync) carries the same item fields — including thumbnailLink,
// which cards render as instant art before the slower metadata parse resolves.
export const AUDIO_FILE_FIELDS =
  "id,name,mimeType,size,modifiedTime,thumbnailLink";
// Same mask plus `parents` for the requests that persist rows into Dexie
// (parentId is derived from the first parent).
export const AUDIO_FILE_FIELDS_WITH_PARENTS =
  "id,name,mimeType,parents,size,modifiedTime,thumbnailLink";

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  parents?: string[];
  trashed?: boolean;
  createdTime?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  capabilities?: Record<string, boolean>;
  /** Short-lived Drive thumbnail URL (files.thumbnailLink); undefined when Drive has none. */
  thumbnailLink?: string | undefined;
}
export interface DriveFilesListResponse {
  files?: DriveFileItem[];
  nextPageToken?: string;
  incompleteSearch?: boolean;
}
export interface DriveFolderItem {
  id: string;
  name: string;
  mimeType: string;
}
export interface DriveFoldersListResponse {
  files?: DriveFolderItem[];
  nextPageToken?: string;
}

export interface DriveStorageQuota {
  limit: number | null;
  usage: number;
  usageInDrive: number;
  usageInDriveTrash: number;
}

// Google Drive error responses carry { error: { message, reason } } with the
// failure reason ALSO inside error.errors[].reason (handle-errors docs — real
// API shape). Only the public message/reason are read (never the raw body —
// it can embed file ids).
export interface DriveErrorBody {
  error?: {
    message?: unknown;
    reason?: unknown;
    errors?: Array<{ reason?: unknown }>;
  };
}
