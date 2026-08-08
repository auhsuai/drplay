import { UploadError } from "../driveUpload";
import type { InternalEntry } from "./types";

// Sequential queue (1 upload at a time) + pending db.files rows that render as
// dimmed cards; CustomEvents drive cards, race guards, Recently Added refresh.
export const MODULE = "uploadManager";
export const PENDING_ID_PREFIX = "pending-";
// Drive folders report this mimeType; octet-stream uploads keep it (getFolderAudioQuery matches on it).
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const AUDIO_FILE_MIME = "application/octet-stream";
export const MAX_UPLOAD_ATTEMPTS = 3;
export const UPLOAD_STATUS_EVENT = "upload-status-changed";
export const DRIVE_FILES_CHANGED_EVENT = "drive-files-changed";
export const ERROR_INVALID_SEED = "invalid-seed";
export const ERROR_QUOTA = "quota";
export const ERROR_TOO_LARGE = "too-large";
export const ERROR_PARENT_FOLDER_MISSING = "parent-folder-missing";
export const ERROR_FAILED = "failed";
export const ERROR_ABORTED = "aborted";
// Disk-path error messages shared by every disk entry kind (file, child file,
// folder root); named constants keep one spelling across all call sites.
export const ERROR_MISSING_DISK_PATH = "missing disk path";
export const ERROR_QUOTA_EXCEEDED = "drive storage quota exceeded";
export const ERROR_TOO_LARGE_MESSAGE = "file exceeds 5 TB limit";
// Google Drive's documented maximum uploadable file size (5 TB per file —
// https://developers.google.com/workspace/drive/api/guides/limits). Files
// beyond it fail mid-upload server-side, so they are rejected BEFORE any
// upload call starts (fail-early). The daily 750 GB/user upload limit is
// enforced server-side only — it is NOT tracked locally.
export const MAX_FILE_BYTES = 5 * 1024 ** 4;
// Subscribers get at most one progress notify per this window; onProgress can
// fire once per chunk (128× on a 1 GB file) and per-chunk notifies would spam
// renders, so progress bursts are coalesced into a single trailing-edge notify.
export const PROGRESS_NOTIFY_INTERVAL_MS = 500;
export const ABORTED_UPLOAD_MESSAGE = "upload aborted by caller";

export class ParentFolderMissingError extends Error {
  constructor(relativeDir: string) {
    super(`parent folder not created: ${relativeDir}`);
    this.name = "ParentFolderMissingError";
  }
}

// Marker for a RESUMED upload whose file vanished from disk (deleted, moved or
// renamed): distinct from a fresh-upload file-missing so markError can surface
// the dedicated upload.resume_not_found toast. Self-created message (basename
// only — no disk path), so it is safe to log.
export class ResumeFileMissingError extends Error {
  constructor(name: string) {
    super(`file not found on disk: ${name}`);
    this.name = "ResumeFileMissingError";
  }
}

// Manager-level guard error (NOT an UploadError — the driveUpload kind union
// has no 'too-large' member and that module is not part of this slice's scope).
// Raised by the 5 TB pre-check so markError can map it to its own kind and
// toast; `size` is carried for the log (bytes, never a path).
export class FileTooLargeError extends Error {
  readonly size: number;
  constructor(size: number) {
    super(ERROR_TOO_LARGE_MESSAGE);
    this.name = "FileTooLargeError";
    this.size = size;
  }
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Disk-path seeds must carry a diskPath; a missing one is a seed-level defect
// that must fail loudly as 'invalid' instead of a TypeError downstream.
export function requireDiskPath(entry: InternalEntry): string {
  const path = entry.diskPath;
  if (!path) throw new UploadError(ERROR_MISSING_DISK_PATH, "invalid");
  return path;
}
