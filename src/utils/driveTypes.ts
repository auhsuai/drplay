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

// Google Drive reports rate limiting as 403 with these `error.errors[].reason`
// values (usage limits): https://developers.google.com/drive/api/guides/handle-errors.
// Single source shared by the main-thread client (driveHttp) and the proSync
// worker (driveFetch) so the reason set cannot drift between the two.
export const DRIVE_RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

// Transient HTTP statuses worth retrying: 429 (rate limit) and 5xx server
// errors, per Google API guidance. Other statuses (2xx, 4xx) are not retried.
// A 403 is only transient when its body identifies a Drive rate limit (see
// DRIVE_RATE_LIMIT_REASONS) — the callers decide that, not this predicate.
export const isTransientDriveStatus = (status: number): boolean =>
  status === 429 || (status >= 500 && status < 600);

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
