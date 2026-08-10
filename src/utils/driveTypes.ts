export const DRIVE_MODULE = "driveApi";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

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
