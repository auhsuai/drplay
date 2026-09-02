// Barrel re-export for the upload queue. The 6 public functions previously
// exported from this file now live in split modules (pump / resume /
// terminal / queueState / enqueue / predecessor) — every consumer keeps
// importing via ../uploadManager, which re-exports from here, so import
// paths and signatures stay stable.
export { startUploads } from "./pump";
export { resumeInterruptedUploads } from "./resume";
export {
  cancelUpload,
  getUploadProgress,
  getUploadingIds,
  isUploading,
} from "./terminal";
