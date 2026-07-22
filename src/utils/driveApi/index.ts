// Barrel re-export for backward compatibility.
// All Drive API operations are split into domain-specific modules:
//   core    — retry/backoff/resilience primitives
//   files   — file CRUD (create, move, delete, restore, etc.)
//   search  — folder/file search, navigation, metadata queries
//   config  — appDataFolder config persistence (multipart upload)
export { backoffDelay, classifyDriveError, driveFetch } from './core';
export {
  createFolder,
  deleteFile,
  moveFile,
  restoreFile,
  permanentlyDeleteFile,
  getRecentlyAddedAudioFiles,
} from './files';
export {
  searchFolders,
  listFolderChildren,
  getFileParents,
  getFileName,
  getTrashedFiles,
} from './search';
export { getAppConfig, saveAppConfig } from './config';
