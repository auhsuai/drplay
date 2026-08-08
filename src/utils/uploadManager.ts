// Barrel re-export: the upload manager implementation now lives in
// src/utils/upload/* (queue, events, session, retry, streaming, folderBatch,
// controllers, errors, types). This path and every export are stable, so the
// 20+ consumers and the test mocks keep importing unchanged.
export {
  cancelUpload,
  getUploadProgress,
  getUploadingIds,
  isUploading,
  resumeInterruptedUploads,
  startUploads,
} from "./upload/queue";
export {
  clearUploadedTint,
  dismissUploaded,
  getEntries,
  getUploadState,
  subscribe,
} from "./upload/events";
export type { UploadEntry, UploadSeed } from "./upload/types";
export type { UploadState } from "./upload/events";
