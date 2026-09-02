import { t } from "i18next";
import { db } from "../../db/db";
import type { DriveFileItem } from "../driveApi";
import { UploadError } from "../driveUpload";
import { captureError } from "../errorLog";
import { showErrorToast } from "../simpleToast";
import { getCurrentUserEmail } from "../storageKeys";
import { clearControllerFor, controllerFor } from "./controllers";
import {
  clearProgressNotifyTimer,
  collectActiveCoverage,
  markRecentlyDone,
  notify,
} from "./events";
import {
  DRIVE_FILES_CHANGED_EVENT,
  ERROR_ABORTED,
  ERROR_FAILED,
  ERROR_INVALID_SEED,
  ERROR_PARENT_FOLDER_MISSING,
  ERROR_QUOTA,
  ERROR_TOO_LARGE,
  FOLDER_MIME,
  MODULE,
  FileTooLargeError,
  ParentFolderMissingError,
  ResumeFileMissingError,
} from "./errors";
import { settleResumedPredecessor } from "./predecessor";
import { findEntryByAnyId, pruneEntry } from "./queueState";
import { clearSession, dbRowOp } from "./session";
import { upsertFileRows, type UpsertableFileRow } from "../../db/fileRows";
import type { InternalEntry } from "./types";

// Terminal transitions and user-initiated cancel: markDone / markError /
// cancelUpload, plus the three read-only projections consumers use.

// A queued entry never touched the network: flip it to terminal so pump skips
// it, drop the (absent) pending row safely, then notify + prune like any
// other terminal transition (subscribers must observe the terminal state).
function cancelQueuedEntry(entry: InternalEntry): void {
  entry.status = "error";
  entry.error = ERROR_ABORTED;
  // Compound PK (schema v10): [userEmail, id].
  void dbRowOp(
    () => db.files.delete([getCurrentUserEmail(), entry.id]),
    "pending-row-delete",
  );
  // Sync path: fire-and-forget — clearSession swallows its own failures.
  void clearSession(entry);
  // A cancelled resume is a definitive end: drop the interrupted source pair
  // unconditionally, or every future launch would resurrect the cancelled
  // work (P2-B1a).
  void settleResumedPredecessor(entry.id, false);
  clearProgressNotifyTimer();
  notify();
  pruneEntry(entry);
}

/**
 * User-initiated cancel. An in-flight 'uploading' entry aborts its wired
 * AbortController (the Drive request rejects and the entry turns into a
 * silent 'aborted' state — no error toast); a still-queued entry is flipped
 * to terminal inline so the pump skips it. Unknown or already-terminal ids
 * are a no-op, so cancel can be re-clicked safely.
 * @param id The entry id ('pending-…') or the Drive id once known.
 */
export function cancelUpload(id: string): void {
  const entry = findEntryByAnyId(id);
  if (!entry || entry.status === "done" || entry.status === "error") return;
  if (entry.status === "queued") {
    cancelQueuedEntry(entry);
    return;
  }
  const controller = controllerFor(entry);
  if (controller) controller.abort();
}

// Live progress fraction (0..1) of a queued/uploading entry — the id may be
// the pending entry id or the Drive id. undefined when the id is unknown,
// terminal, or no progress has been reported yet.
export function getUploadProgress(id: string): number | undefined {
  const entry = findEntryByAnyId(id);
  if (
    entry === undefined ||
    (entry.status !== "queued" && entry.status !== "uploading")
  ) {
    return undefined;
  }
  return entry.progress;
}

export function getUploadingIds(): ReadonlySet<string> {
  // The active-coverage rule (entry id + driveId + parentId ≠ root) lives in
  // events.collectActiveCoverage — this is the flat-set projection of it.
  const { ids, driveIds, parentIds } = collectActiveCoverage();
  return new Set<string>([...ids, ...driveIds, ...parentIds]); // fresh set per call - callers must not cache the reference
}

export function isUploading(id: string): boolean {
  return getUploadingIds().has(id);
}

// Shared terminal cleanup for the two async terminal paths: drop the pending
// row, then notify subscribers BEFORE the prune so they still observe the
// terminal state, then release the entry's cancel controller. cancelQueuedEntry
// does not share this — a queued entry never touched the network and must turn
// terminal synchronously within cancelUpload (the pump only picks 'queued').
async function finishEntry(entry: InternalEntry): Promise<void> {
  // Compound PK (schema v10): [userEmail, id].
  await dbRowOp(
    () => db.files.delete([getCurrentUserEmail(), entry.id]),
    "pending-row-delete",
  );
  notify();
  pruneEntry(entry);
  clearControllerFor(entry);
}

export async function markDone(
  entry: InternalEntry,
  driveItem: DriveFileItem,
): Promise<void> {
  clearProgressNotifyTimer();
  entry.driveId = driveItem.id;
  // Publish the created subfolder to the batch memo so its child files can
  // resolve their parent id when their own turn comes.
  if (
    entry.kind === "folderChild" &&
    entry.relativeDir !== undefined &&
    entry.batchMemo
  ) {
    entry.batchMemo.set(entry.relativeDir, driveItem.id);
  }
  await dbRowOp(
    () =>
      upsertFileRows(
        [
          {
            // Provisional userEmail (type-required) — the helper stamps its
            // own ownerEmail argument authoritatively.
            ...realUploadRow(entry, driveItem),
            userEmail: getCurrentUserEmail(),
          },
        ],
        getCurrentUserEmail(),
        // The resumable-upload response never echoes parents[] back (narrowed
        // by asDriveFileItem), so the canonical source here is the parent THIS
        // entry itself sent in the upload request — for folder children that
        // is the resolved Drive folder id (entry.parentId was set from the
        // batch memo before initiating).
        [entry.parentId],
      ),
    "real-row",
  );
  entry.status = "done";
  // The row shows a green check for a short while after finishing — a driveId
  // is the id the live list knows the item by, so mark that one. Notify runs
  // BEFORE finishEntry removes the entry so the final status snapshot still
  // shows 'done'.
  markRecentlyDone(driveItem.id);
  // Terminal: the active session row is stale the moment the upload is done.
  await clearSession(entry);
  // P2-B1a terminal net: normally retired at processEntry already; if that
  // persist failed, a completed upload means the real Drive row exists — the
  // source is safe to drop (no-op when nothing is pending).
  await settleResumedPredecessor(entry.id, false);
  await finishEntry(entry);
  window.dispatchEvent(
    new CustomEvent<{ count: number }>(DRIVE_FILES_CHANGED_EVENT, {
      detail: { count: 1 },
    }),
  );
}

// Map a thrown error to its terminal entry kind (same input → same output as
// the former four-tier ternary). An aborted UploadError carries kind
// 'aborted' === ERROR_ABORTED, so the aborted branch needs no special case.
function errorKindFor(err: unknown): string {
  if (err instanceof FileTooLargeError) return ERROR_TOO_LARGE;
  if (err instanceof ParentFolderMissingError) {
    return ERROR_PARENT_FOLDER_MISSING;
  }
  if (err instanceof UploadError) return err.kind;
  return ERROR_FAILED;
}

export async function markError(
  entry: InternalEntry,
  err: unknown,
): Promise<void> {
  clearProgressNotifyTimer();
  const isAborted = err instanceof UploadError && err.kind === ERROR_ABORTED;
  const isResumeMissing = err instanceof ResumeFileMissingError;
  entry.error = errorKindFor(err);
  entry.status = "error";
  if (isAborted) {
    // A user-initiated cancel is not a failure: no error toast, warn-level log
    // only. entry.name is always a basename (never a disk path or token).
    await captureError({
      level: "warn",
      source: MODULE,
      message: `upload-cancelled name=${entry.name}`,
      kind: ERROR_ABORTED,
    });
  } else {
    const isTooLarge = entry.error === ERROR_TOO_LARGE;
    const isQuota = entry.error === ERROR_QUOTA;
    // The resumed file vanished from disk — keep the entry kind 'failed' (no
    // new public error value) but log + toast the dedicated reason so the user
    // knows the file is gone rather than "upload failed".
    const resumeMissingDetail = isResumeMissing
      ? " reason=resume-file-missing"
      : "";
    // UploadError messages are self-created constants (status/quota text — never
    // PII), so they are safe to log and carry the concrete 4xx that the kind
    // alone hides. A plain Error from diskFs can embed the full disk path, so
    // its message stays out of the log — only name + kind are recorded.
    const uploadDetail =
      err instanceof UploadError ? ` message=${err.message}` : "";
    const tooLargeDetail =
      err instanceof FileTooLargeError ? ` size=${String(err.size)}` : "";
    // Never log the disk path or token - only the shortened file name.
    await captureError({
      level: isQuota || isTooLarge ? "warn" : "error",
      source: MODULE,
      message: `upload-entry-failed name=${entry.name} kind=${entry.error}${resumeMissingDetail}${uploadDetail}${tooLargeDetail}`,
      kind: entry.error,
    });
    if (isTooLarge) {
      showErrorToast(t("upload.too_large"));
    } else if (isQuota) {
      showErrorToast(t("upload.quota_exceeded"));
    } else if (isResumeMissing) {
      showErrorToast(t("upload.resume_not_found"));
    } else if (
      entry.error !== ERROR_INVALID_SEED &&
      entry.error !== ERROR_PARENT_FOLDER_MISSING
    ) {
      showErrorToast(t("upload.error"));
    }
  }
  // Terminal (error/cancel): the active session row is stale — drop it so a
  // future resume never retries a dead entry.
  await clearSession(entry);
  // P2-B1a terminal net: if the successor's first persist failed and this
  // entry still ended terminally, drop the source pair anyway — a permanently
  // failed resume must not resurrect on every launch (no-op when already
  // retired).
  await settleResumedPredecessor(entry.id, false);
  await finishEntry(entry);
}

// Map the settled upload into the helper's raw-row shape. The parent is NOT
// set here — markDone passes entry.parentId as upsertFileRows' knownParents
// (the request's own target), so a future response that DOES carry parents[]
// automatically wins via the row's own parents. Same as driveMapping, the row
// is WITHOUT userEmail (the call site composes the provisional value).
function realUploadRow(
  entry: InternalEntry,
  driveItem: DriveFileItem,
): Omit<UpsertableFileRow, "userEmail"> {
  let size: number | undefined;
  if (driveItem.size !== undefined) {
    const n = Number(driveItem.size);
    size = Number.isFinite(n) ? n : undefined;
  }
  return {
    id: driveItem.id,
    name: entry.name,
    mimeType: entry.isFolder ? FOLDER_MIME : driveItem.mimeType,
    size,
    trashed: false,
    isFolder: entry.isFolder,
    modifiedTime: driveItem.modifiedTime ?? new Date().toISOString(),
  };
}
