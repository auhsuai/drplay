// Barrel re-export: Google Drive API resilience layer, split into focused
// modules (driveTypes / driveHttp / driveFiles / driveConfig / driveQuota).
// All consumers import from "./driveApi" — path unchanged.
export { DRIVE_MODULE, FOLDER_MIME } from "./driveTypes";
export type {
  DriveFileItem,
  DriveFilesListResponse,
  DriveFolderItem,
  DriveFoldersListResponse,
  DriveStorageQuota,
  DriveErrorBody,
} from "./driveTypes";
export {
  sleep,
  mergeWithTimeoutSignal,
  classifyDriveError,
  backoffDelay,
  driveFetch,
  readDriveErrorBody,
  isRateLimit403Response,
} from "./driveHttp";
export {
  createFolder,
  deleteFile,
  moveFile,
  restoreFile,
  permanentlyDeleteFile,
  getRecentlyAddedAudioFiles,
  getFileParents,
  getFileName,
} from "./driveFiles";
export { getAppConfig, withSaveConfigLock, saveAppConfig } from "./driveConfig";
export { getDriveStorageQuota } from "./driveQuota";
