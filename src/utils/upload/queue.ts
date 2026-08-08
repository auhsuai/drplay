import { t } from "i18next";
import { db } from "../../db/db";
import type { DriveFile, UploadSessionRow } from "../../db/db";
import type { DriveFileItem } from "../driveApi";
import { ROOT_FOLDER_ID } from "../driveConstants";
import { UploadError } from "../driveUpload";
import { captureError } from "../errorLog";
import { showErrorToast } from "../simpleToast";
import {
  clearControllerFor,
  controllerFor,
  createControllerFor,
} from "./controllers";
import {
  clearProgressNotifyTimer,
  markRecentlyDone,
  notify,
  resetProgressNotify,
  bindEntries,
} from "./events";
import {
  AUDIO_FILE_MIME,
  DRIVE_FILES_CHANGED_EVENT,
  ERROR_ABORTED,
  ERROR_FAILED,
  ERROR_INVALID_SEED,
  ERROR_PARENT_FOLDER_MISSING,
  ERROR_QUOTA,
  ERROR_TOO_LARGE,
  FOLDER_MIME,
  MODULE,
  PENDING_ID_PREFIX,
  FileTooLargeError,
  ParentFolderMissingError,
  ResumeFileMissingError,
  describeError,
} from "./errors";
import { handleFolderChild, handleFolderRoot } from "./folderBatch";
import { uploadWithQuotaAndRetry } from "./retry";
import {
  clearSession,
  persistActiveSession,
  resumeEntryFromRow,
} from "./session";
import { handleChildFile, handleDiskFile } from "./streaming";
import type { InternalEntry, UploadSeed } from "./types";

let entries: InternalEntry[] = [];
let busy = false;
// Slice 5.2: re-entrancy guard for resumeInterruptedUploads — set synchronously
// before the first await so a second concurrent call returns immediately.
let resumeRunning = false;

// events.ts (notify/getEntries/getUploadState) must READ the live entries but
// never own/mutate them — hand it a read-only getter so the import graph stays
// acyclic (queue -> events, never events -> queue).
bindEntries(() => entries);

/**
 * Enqueue uploads and start pumping the queue. The manager runs uploads
 * strictly sequentially (one at a time) and publishes a pending db.files row
 * per entry so the UI can render dimmed cards immediately, long before Drive
 * confirms anything. Invalid seeds (folder without a disk path, file without
 * bytes/path) surface as error entries instead of throwing.
 * @param seeds The items to upload (bytes payloads or disk paths).
 * @param token Drive access token for this batch's requests.
 */
export function startUploads(seeds: UploadSeed[], token: string): void {
  for (const seed of seeds) {
    entries.push(createEntry(seed, token));
  }
  notify();
  void pump();
}

/**
 * Re-queue every resumable upload this user left interrupted (slice 5.2):
 * disk-path rows become fresh queue entries carrying their persisted session
 * URI (resumed at the server-confirmed byte) — non-resumable rows (bytes,
 * folder roots, unresolved children) are counted and surfaced with ONE
 * aggregated toast. Rows of OTHER users are never touched. Runs at most one
 * scan at a time (module guard); enqueued entries flow through the same
 * sequential pump as new uploads, so both can coexist safely.
 * @param token Drive access token for this batch's requests.
 * @param userEmail The user whose interrupted uploads are resumed.
 */
export async function resumeInterruptedUploads(
  token: string,
  userEmail: string,
): Promise<void> {
  if (resumeRunning) return;
  resumeRunning = true;
  let interruptedCount = 0;
  const resumed: InternalEntry[] = [];
  try {
    let rows: UploadSessionRow[];
    try {
      rows = await db.uploadSessions
        .where("userEmail")
        .equals(userEmail)
        .toArray();
    } catch (err) {
      await captureError({
        level: "warn",
        source: MODULE,
        message: `resume-read-failed: ${describeError(err)}`,
      });
      return;
    }
    // Oldest first — the queue processes in the original order.
    rows.sort((a, b) => a.createdAt - b.createdAt);
    for (const row of rows) {
      const entry = resumeEntryFromRow(row, token);
      // Delete the OLD row before the new entry can persist its own row under
      // a fresh id (best-effort — a failed delete is logged and the scan
      // continues; the stale row would just be re-scanned next launch).
      await dbRowOp(
        () => db.uploadSessions.delete(row.id),
        "session-resume-delete",
      );
      if (entry === null) interruptedCount += 1;
      else resumed.push(entry);
    }
  } finally {
    resumeRunning = false;
  }
  if (interruptedCount > 0) {
    // ONE aggregated toast for every non-resumable row — never one per file.
    showErrorToast(t("upload.interrupted"));
  }
  if (resumed.length > 0) {
    entries.push(...resumed);
    notify();
    void pump();
  }
}

export function getUploadingIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== "queued" && entry.status !== "uploading") continue;
    ids.add(entry.id);
    if (entry.driveId) ids.add(entry.driveId);
    // The parent folder must stay locked (spinner, no dim) while a child uploads.
    if (entry.parentId !== ROOT_FOLDER_ID) ids.add(entry.parentId);
  }
  return ids; // fresh set per call - callers must not cache the reference
}

export function isUploading(id: string): boolean {
  return getUploadingIds().has(id);
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
  const entry = entries.find((e) => e.id === id || e.driveId === id);
  if (!entry || entry.status === "done" || entry.status === "error") return;
  if (entry.status === "queued") {
    cancelQueuedEntry(entry);
    return;
  }
  const controller = controllerFor(entry);
  if (controller) controller.abort();
}

// A queued entry never touched the network: flip it to terminal so pump skips
// it, drop the (absent) pending row safely, then notify + prune like any
// other terminal transition (subscribers must observe the terminal state).
function cancelQueuedEntry(entry: InternalEntry): void {
  entry.status = "error";
  entry.error = ERROR_ABORTED;
  void dbRowOp(() => db.files.delete(entry.id), "pending-row-delete");
  // Sync path: fire-and-forget — clearSession swallows its own failures.
  void clearSession(entry);
  clearProgressNotifyTimer();
  notify();
  pruneEntry(entry);
}

// Live progress fraction (0..1) of a queued/uploading entry — the id may be
// the pending entry id or the Drive id. undefined when the id is unknown,
// terminal, or no progress has been reported yet.
export function getUploadProgress(id: string): number | undefined {
  const entry = entries.find(
    (e) =>
      (e.id === id || e.driveId === id) &&
      (e.status === "queued" || e.status === "uploading"),
  );
  return entry?.progress;
}

function createEntry(seed: UploadSeed, token: string): InternalEntry {
  const entry: InternalEntry = {
    id: `${PENDING_ID_PREFIX}${crypto.randomUUID()}`,
    name: seed.name,
    isFolder: seed.isFolder,
    parentId: seed.parentId,
    diskPath: seed.diskPath,
    bytes: seed.bytes,
    status: "queued",
    token,
    kind: seed.isFolder ? "folderRoot" : seed.diskPath ? "diskFile" : "bytes",
  };
  if (seed.isFolder && !seed.diskPath) {
    failSeed(entry, "folder seed lacks a disk path");
  } else if (!seed.isFolder && !seed.bytes && !seed.diskPath) {
    failSeed(entry, "file seed lacks both bytes and a disk path");
  }
  return entry;
}

// Invalid seeds error synchronously (never enqueued) and surface as error entries.
function failSeed(entry: InternalEntry, reason: string): void {
  entry.status = "error";
  entry.error = ERROR_INVALID_SEED;
  // fire-and-forget: logging must not throw in this sync path (captureError
  // never rejects — it swallows failures internally).
  void captureError({
    level: "warn",
    source: MODULE,
    message: `invalid-seed name=${entry.name}: ${reason}`,
  });
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const next = entries.find((e) => e.status === "queued");
      if (!next) break;
      await processEntry(next);
    }
  } finally {
    busy = false;
  }
}

async function processEntry(entry: InternalEntry): Promise<void> {
  entry.status = "uploading";
  notify();
  createControllerFor(entry);
  resetProgressNotify();
  // The pending files row and the active-session snapshot are independent
  // best-effort writes — issue them in the SAME batch so the session row
  // exists before handleByKind without adding a DB roundtrip to the upload
  // pipeline.
  await Promise.all([
    dbRowOp(
      () =>
        db.files.put({
          id: entry.id,
          name: entry.name,
          mimeType: entry.isFolder ? FOLDER_MIME : AUDIO_FILE_MIME,
          parentId: entry.parentId,
          trashed: false,
          isFolder: entry.isFolder,
          modifiedTime: new Date().toISOString(),
        }),
      "pending-row",
    ),
    persistActiveSession(entry),
  ]);
  try {
    const driveItem = await handleByKind(entry);
    await markDone(entry, driveItem);
  } catch (err) {
    await markError(entry, err);
  }
}

function handleByKind(entry: InternalEntry): Promise<DriveFileItem> {
  switch (entry.kind) {
    case "bytes": {
      if (!entry.bytes)
        throw new UploadError("missing upload bytes", "invalid");
      return uploadWithQuotaAndRetry(entry, entry.bytes);
    }
    case "diskFile":
      return handleDiskFile(entry);
    case "folderChildFile":
      return handleChildFile(entry);
    case "folderRoot":
      // folderBatch is pure: children come back through the callback and are
      // pushed here — this module stays the single owner of `entries`.
      return handleFolderRoot(entry, (child) => {
        entries.push(child);
      });
    case "folderChild":
      return handleFolderChild(entry);
    default: {
      // Exhaustiveness guard: TS narrows `entry.kind` to `never` here, so a new
      // UploadKind added to the union without a matching branch fails to compile
      // instead of returning undefined and crashing markDone downstream.
      const exhaustive: never = entry.kind;
      throw new Error(`unhandled upload kind: ${String(exhaustive)}`);
    }
  }
}

// Terminal (done/error) entries are useless to the UI — getUploadingIds /
// getUploadState only read queued/uploading — but each holds a full diskPath
// string and (for byte seeds) the raw payload, so keeping them is an
// unbounded retention that grows with every batch. Callers must have fired
// their final notify() first so subscribers still observe the terminal state.
function pruneEntry(entry: InternalEntry): void {
  entry.bytes = undefined;
  entries = entries.filter((e) => e !== entry);
}

// Shared terminal cleanup for the two async terminal paths: drop the pending
// row, then notify subscribers BEFORE the prune so they still observe the
// terminal state, then release the entry's cancel controller. cancelQueuedEntry
// does not share this — a queued entry never touched the network and must turn
// terminal synchronously within cancelUpload (the pump only picks 'queued').
async function finishEntry(entry: InternalEntry): Promise<void> {
  await dbRowOp(() => db.files.delete(entry.id), "pending-row-delete");
  notify();
  pruneEntry(entry);
  clearControllerFor(entry);
}

async function markDone(
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
  await dbRowOp(() => db.files.put(realRow(entry, driveItem)), "real-row");
  entry.status = "done";
  // The row shows a green check for a short while after finishing — a driveId
  // is the id the live list knows the item by, so mark that one. Notify runs
  // BEFORE finishEntry removes the entry so the final status snapshot still
  // shows 'done'.
  markRecentlyDone(driveItem.id);
  // Terminal: the active session row is stale the moment the upload is done.
  await clearSession(entry);
  await finishEntry(entry);
  window.dispatchEvent(
    new CustomEvent<{ count: number }>(DRIVE_FILES_CHANGED_EVENT, {
      detail: { count: 1 },
    }),
  );
}

async function markError(entry: InternalEntry, err: unknown): Promise<void> {
  clearProgressNotifyTimer();
  const isAborted = err instanceof UploadError && err.kind === ERROR_ABORTED;
  const isResumeMissing = err instanceof ResumeFileMissingError;
  entry.error = isAborted
    ? ERROR_ABORTED
    : err instanceof FileTooLargeError
      ? ERROR_TOO_LARGE
      : err instanceof ParentFolderMissingError
        ? ERROR_PARENT_FOLDER_MISSING
        : err instanceof UploadError
          ? err.kind
          : ERROR_FAILED;
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
  await finishEntry(entry);
}

function realRow(entry: InternalEntry, driveItem: DriveFileItem): DriveFile {
  let size: number | undefined;
  if (driveItem.size !== undefined) {
    const n = Number(driveItem.size);
    size = Number.isFinite(n) ? n : undefined;
  }
  return {
    id: driveItem.id,
    name: entry.name,
    mimeType: entry.isFolder ? FOLDER_MIME : driveItem.mimeType,
    parentId: entry.parentId,
    size,
    trashed: false,
    isFolder: entry.isFolder,
    modifiedTime: driveItem.modifiedTime ?? new Date().toISOString(),
  };
}
async function dbRowOp(
  op: () => Promise<unknown>,
  label: string,
): Promise<void> {
  try {
    await op();
  } catch (err) {
    await captureError({
      level: "warn",
      source: MODULE,
      message: `${label}-db-failed: ${describeError(err)}`,
    });
  }
}
