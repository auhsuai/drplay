import { t } from "i18next";
import { db } from "../db/db";
import type { DriveFile, UploadSessionRow } from "../db/db";
import {
  backoffDelay,
  createFolder,
  getDriveStorageQuota,
  sleep,
} from "./driveApi";
import { ROOT_FOLDER_ID } from "./driveConstants";
import {
  generateClientId,
  uploadFileResumable,
  uploadFileResumableChunked,
  UploadError,
} from "./driveUpload";
import type { DriveFileItem, DriveStorageQuota } from "./driveApi";
import {
  openDiskReadStream,
  registerUploadPath,
  statDiskPath,
  walkDiskFolder,
} from "./diskFs";
import type { DiskEntry } from "./diskFs";
import { captureError } from "./errorLog";
import { basename } from "./pathUtils";
import { showErrorToast } from "./simpleToast";
import { getCurrentUserEmail } from "./storageKeys";

// Sequential queue (1 upload at a time) + pending db.files rows that render as
// dimmed cards; CustomEvents drive cards, race guards, Recently Added refresh.
const MODULE = "uploadManager";
const PENDING_ID_PREFIX = "pending-";
// Drive folders report this mimeType; octet-stream uploads keep it (getFolderAudioQuery matches on it).
const FOLDER_MIME = "application/vnd.google-apps.folder";
const AUDIO_FILE_MIME = "application/octet-stream";
const MAX_UPLOAD_ATTEMPTS = 3;
const UPLOAD_STATUS_EVENT = "upload-status-changed";
const DRIVE_FILES_CHANGED_EVENT = "drive-files-changed";
const ERROR_INVALID_SEED = "invalid-seed";
const ERROR_QUOTA = "quota";
const ERROR_TOO_LARGE = "too-large";
const ERROR_PARENT_FOLDER_MISSING = "parent-folder-missing";
const ERROR_FAILED = "failed";
const ERROR_ABORTED = "aborted";
// Disk-path error messages shared by every disk entry kind (file, child file,
// folder root); named constants keep one spelling across all call sites.
const ERROR_MISSING_DISK_PATH = "missing disk path";
const ERROR_QUOTA_EXCEEDED = "drive storage quota exceeded";
const ERROR_TOO_LARGE_MESSAGE = "file exceeds 5 TB limit";
// Google Drive's documented maximum uploadable file size (5 TB per file —
// https://developers.google.com/workspace/drive/api/guides/limits). Files
// beyond it fail mid-upload server-side, so they are rejected BEFORE any
// upload call starts (fail-early). The daily 750 GB/user upload limit is
// enforced server-side only — it is NOT tracked locally.
const MAX_FILE_BYTES = 5 * 1024 ** 4;
// Subscribers get at most one progress notify per this window; onProgress can
// fire once per chunk (128× on a 1 GB file) and per-chunk notifies would spam
// renders, so progress bursts are coalesced into a single trailing-edge notify.
const PROGRESS_NOTIFY_INTERVAL_MS = 500;
const ABORTED_UPLOAD_MESSAGE = "upload aborted by caller";

export interface UploadEntry {
  id: string; // 'pending-<uuid>' until a real Drive id exists (also db.files row id)
  name: string;
  isFolder: boolean;
  parentId: string; // Drive destination folder ('root' is valid)
  diskPath?: string | undefined;
  bytes?: Blob | Uint8Array | undefined;
  status: "queued" | "uploading" | "done" | "error";
  error?: string | undefined; // only when status === 'error'
  progress?: number | undefined; // 0..1 fraction of bytes confirmed by Drive (chunked disk uploads)
}

export interface UploadSeed {
  name: string;
  isFolder: boolean;
  parentId: string;
  diskPath?: string;
  bytes?: Blob | Uint8Array;
}

type UploadKind =
  "bytes" | "diskFile" | "folderRoot" | "folderChild" | "folderChildFile";

// Internal fields (token, memo, drive id) must never leak through the public contract.
interface InternalEntry extends UploadEntry {
  token: string;
  kind: UploadKind;
  driveId?: string;
  relativeDir?: string; // dir path within a folder batch ('sub/sub2'; '' = batch root)
  batchMemo?: Map<string, string>; // shared per batch: relativeDir -> driveId ('' marker = enqueued)
  // Slice 5.2 resume metadata (from a persisted session row) — internal only:
  // uploadDiskPathChunked feeds these into the chunked uploader. `| undefined`
  // is explicit because a size-change drop CLEARS them mid-flight.
  resumeUri?: string | undefined; // persisted session URI (undefined = fresh upload)
  resumeTotalSize?: number | undefined; // persisted totalSize — for the size-change check
  resumeClientGeneratedId?: string | undefined; // persisted pre-generated id — reused for idempotency
}

interface FolderBatch {
  entry: InternalEntry;
  memo: Map<string, string>;
}

class ParentFolderMissingError extends Error {
  constructor(relativeDir: string) {
    super(`parent folder not created: ${relativeDir}`);
    this.name = "ParentFolderMissingError";
  }
}

// Marker for a RESUMED upload whose file vanished from disk (deleted, moved or
// renamed): distinct from a fresh-upload file-missing so markError can surface
// the dedicated upload.resume_not_found toast. Self-created message (basename
// only — no disk path), so it is safe to log.
class ResumeFileMissingError extends Error {
  constructor(name: string) {
    super(`file not found on disk: ${name}`);
    this.name = "ResumeFileMissingError";
  }
}

// Manager-level guard error (NOT an UploadError — the driveUpload kind union
// has no 'too-large' member and that module is not part of this slice's scope).
// Raised by the 5 TB pre-check so markError can map it to its own kind and
// toast; `size` is carried for the log (bytes, never a path).
class FileTooLargeError extends Error {
  readonly size: number;
  constructor(size: number) {
    super(ERROR_TOO_LARGE_MESSAGE);
    this.name = "FileTooLargeError";
    this.size = size;
  }
}

let entries: InternalEntry[] = [];
let busy = false;
// Slice 5.2: re-entrancy guard for resumeInterruptedUploads — set synchronously
// before the first await so a second concurrent call returns immediately.
let resumeRunning = false;
const subscribers = new Set<() => void>();

// One AbortController per in-flight upload: created when the entry turns
// 'uploading' (before handleByKind) and removed at terminal. cancelUpload
// aborts it; driveApi converts the abort into UploadError('aborted') which
// markError surfaces as a silent user-initiated cancel.
const entryControllers = new Map<string, AbortController>();

// Progress notify is coalesced through a single trailing-edge timer: pending
// onProgress bursts leave the timer running (at most one notify per
// PROGRESS_NOTIFY_INTERVAL_MS), and a notify only fires when the value
// actually changed since the last one. The queue is strictly sequential, so
// one shared timer + last-notified value covers every entry.
let pendingProgressTimer: ReturnType<typeof setTimeout> | null = null;
let pendingProgressEntry: InternalEntry | null = null;
let lastNotifiedProgress = 0;

function controllerFor(entry: InternalEntry): AbortController | undefined {
  return entryControllers.get(entry.id);
}
function createControllerFor(entry: InternalEntry): void {
  entryControllers.set(entry.id, new AbortController());
}
function clearControllerFor(entry: InternalEntry): void {
  entryControllers.delete(entry.id);
}

// Coalesce: a pending timer is left running (new bursts merge into it). The
// callback re-checks the entry (still queued/uploading? progress changed?)
// because the entry may have gone terminal while the timer was pending.
function scheduleProgressNotify(entry: InternalEntry): void {
  if (pendingProgressTimer !== null) return;
  pendingProgressEntry = entry;
  pendingProgressTimer = setTimeout(() => {
    pendingProgressTimer = null;
    const target = pendingProgressEntry;
    pendingProgressEntry = null;
    if (!target) return;
    const active = target.status === "queued" || target.status === "uploading";
    if (!active || target.progress === undefined) return;
    if (target.progress === lastNotifiedProgress) return;
    lastNotifiedProgress = target.progress;
    notify();
  }, PROGRESS_NOTIFY_INTERVAL_MS);
}

// Terminal transitions notify immediately themselves, so a pending progress
// timer must not fire a stale notify afterwards (and must not leak).
function clearProgressNotifyTimer(): void {
  if (pendingProgressTimer !== null) {
    clearTimeout(pendingProgressTimer);
    pendingProgressTimer = null;
    pendingProgressEntry = null;
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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

// Disk-path seeds must carry a diskPath; a missing one is a seed-level defect
// that must fail loudly as 'invalid' instead of a TypeError downstream.
function requireDiskPath(entry: InternalEntry): string {
  const path = entry.diskPath;
  if (!path) throw new UploadError(ERROR_MISSING_DISK_PATH, "invalid");
  return path;
}

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

// Build a queue entry from a persisted session row (slice 5.2). Returns null
// when the row cannot be resumed — such rows only count toward the aggregated
// interrupted toast: 'bytes' (payload lost with the old process), 'folderRoot'
// (re-walking would create a DUPLICATE Drive folder) and 'folderChild'
// (no diskPath ever persisted) are never resumed; a 'folderChildFile' whose
// session never initiated has a placeholder parentId (the batch root's, not a
// resolved Drive id) and cannot resolve its parent without the lost batch memo.
function resumeEntryFromRow(
  row: UploadSessionRow,
  token: string,
): InternalEntry | null {
  if (row.diskPath === undefined) return null;
  if (row.kind === "folderRoot" || row.kind === "folderChild") return null;
  if (row.kind === "folderChildFile" && row.uploadUri === undefined)
    return null;
  const entry: InternalEntry = {
    // Fresh id — the old row (same id) was deleted by the caller first, so
    // there is no clash and cancel-by-id stays unambiguous.
    id: `${PENDING_ID_PREFIX}${crypto.randomUUID()}`,
    name: row.name,
    isFolder: row.isFolder,
    parentId: row.parentId,
    diskPath: row.diskPath,
    status: "queued",
    token,
    kind: row.kind,
    ...(row.uploadUri !== undefined ? { resumeUri: row.uploadUri } : {}),
    ...(row.totalSize !== undefined ? { resumeTotalSize: row.totalSize } : {}),
    ...(row.clientGeneratedId !== undefined
      ? { resumeClientGeneratedId: row.clientGeneratedId }
      : {}),
  };
  if (row.kind === "folderChildFile") {
    // The parent Drive folder id was resolved BEFORE the session initiated
    // (handleChildFile runs before the chunked upload), so row.parentId is the
    // real destination. Feed it back through a single-entry batch memo so
    // handleChildFile resolves it without a live batch.
    entry.relativeDir = "";
    entry.batchMemo = new Map<string, string>([["", row.parentId]]);
  }
  return entry;
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

/**
 * Card-level upload presentation state (slice 6):
 * - 'uploading'        → the item itself is being uploaded (dim + spinner)
 * - 'parent-uploading' → a child of this folder is uploading (spinner only,
 *                        the folder already exists on Drive — no dim)
 * - 'uploaded'         → the item finished uploading recently (green check,
 *                        dismissed on play or after UPLOADED_TINT_MS)
 * - 'none'             → idle
 */
export type UploadState =
  "none" | "uploading" | "parent-uploading" | "uploaded";

// How long the "just uploaded" green check stays visible before the row
// returns to the idle MoreMenu state.
const UPLOADED_TINT_MS = 10_000;
// Ids (entry or drive id) that finished uploading recently — presentation
// only, cleared by timer or when the user plays the item.
const recentlyDoneIds = new Set<string>();

/**
 * Resolve a single item id to its upload presentation state ('uploading' wins
 * when an id matches both the entry and a child upload under it). Callers use
 * this to decide a row's dim/spinner/green-check rendering.
 * @param id The entry id, Drive id, or parent folder id to look up.
 * @returns The state that row should render ('none' when not uploading).
 */
export function getUploadState(id: string): UploadState {
  // Mirrors getUploadingIds' coverage (entry id + driveId + parentId) but
  // resolves a SINGLE id to a presentation state instead of a flat set.
  // 'uploading' wins when the id matches both (e.g. a folder whose own
  // driveId matches while a child uploads under it).
  let isParent = false;
  for (const entry of entries) {
    if (entry.status !== "queued" && entry.status !== "uploading") continue;
    if (entry.id === id || entry.driveId === id) return "uploading";
    if (entry.parentId === id && id !== ROOT_FOLDER_ID) isParent = true;
  }
  // A folder that just finished must still show its child-upload spinner while
  // a child uploads under it — parent-uploading beats the transient check.
  if (isParent) return "parent-uploading";
  if (recentlyDoneIds.has(id)) return "uploaded";
  return "none";
}

// Mark an id as just-finished so the row shows the green check; auto-clears
// after UPLOADED_TINT_MS. No immediate notify: the caller (markComplete) runs
// this right before finishEntry, whose own notify picks up the new state.
function markRecentlyDone(id: string): void {
  recentlyDoneIds.add(id);
  window.setTimeout(() => {
    recentlyDoneIds.delete(id);
    notify();
  }, UPLOADED_TINT_MS);
}

/**
 * Hide the green check early (e.g. the user clicked the row to play it) and
 * return the row to its idle MoreMenu state.
 * @param id The entry or Drive id whose tint should clear.
 */
export function dismissUploaded(id: string): void {
  if (recentlyDoneIds.delete(id)) notify();
}

/**
 * Clear EVERY "just uploaded" check at once (e.g. the user left the My Drive
 * tab and MainContent unmounted) — the tint is presentation-only, so a fresh
 * visit must show no stale checks. No-op (and no notify) when already empty,
 * same silent pattern as dismissUploaded.
 */
export function clearUploadedTint(): void {
  if (recentlyDoneIds.size === 0) return;
  recentlyDoneIds.clear();
  notify();
}

/**
 * Subscribe to upload-state changes (status flips, progress ticks, cancels).
 * Also re-dispatched as a window 'upload-status-changed' CustomEvent for
 * non-React consumers. The callback must be resilient: a throwing subscriber
 * is caught and logged, never allowed to break the notify loop.
 * @param cb Called on every state change after the queue mutates.
 * @returns An unsubscribe function; call it on unmount to stop receiving
 * notifications (and to let the manager drop the reference).
 */
export function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
/**
 * Snapshot of every upload entry (queued, uploading, and terminal). Terminal
 * entries are pruned right after they notify, so the snapshot is a point-in-
 * time view: subscribers must consume the 'done'/'error' state from the
 * notify that preceded the prune, not from a later getEntries call.
 * @returns A shallow copy of the internal entries with internal fields
 * (token, memo, drive id) stripped — safe for any consumer.
 */
export function getEntries(): UploadEntry[] {
  return entries.map((e) => ({
    id: e.id,
    name: e.name,
    isFolder: e.isFolder,
    parentId: e.parentId,
    status: e.status,
    diskPath: e.diskPath,
    bytes: e.bytes,
    error: e.error,
    progress: e.progress,
  }));
}

// Fire subscribers + window event; a throwing subscriber must not break the loop.
function notify(): void {
  for (const cb of subscribers) {
    try {
      cb();
    } catch (err) {
      // fire-and-forget: logging must not throw in this sync path
      // (captureError never rejects — it swallows failures internally).
      void captureError({
        level: "warn",
        source: MODULE,
        message: `subscriber-failed: ${describeError(err)}`,
      });
    }
  }
  window.dispatchEvent(
    new CustomEvent<UploadEntry[]>(UPLOAD_STATUS_EVENT, {
      detail: getEntries(),
    }),
  );
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
  lastNotifiedProgress = 0;
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
      return handleFolderRoot(entry);
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

async function handleDiskFile(entry: InternalEntry): Promise<DriveFileItem> {
  const path = requireDiskPath(entry);
  entry.name = basename(path);
  await registerUploadPath(path);
  return uploadDiskFileStreaming(entry, path);
}

async function handleChildFile(entry: InternalEntry): Promise<DriveFileItem> {
  // The parent's drive id is only known once its own folder entry completed
  // (the queue is sequential, so it always has by the time a child runs).
  const dir = entry.relativeDir ?? "";
  const parentId = entry.batchMemo?.get(dir);
  if (!parentId) throw new ParentFolderMissingError(dir);
  entry.parentId = parentId;
  const path = requireDiskPath(entry);
  return uploadDiskFileStreaming(entry, path);
}

// Disk-path files stream in bounded chunks (~8 MiB in memory) instead of
// materializing the whole file in the JS heap — the fix for the multi-GB RAM
// spike when uploading large FLAC/WAV files. The file size comes from one stat
// (walk entries carry size 0), which also feeds the quota check.
async function uploadDiskFileStreaming(
  entry: InternalEntry,
  path: string,
): Promise<DriveFileItem> {
  const stat = await statDiskPath(path);
  if (stat === null || stat.isDirectory) {
    // A RESUMED file that vanished (deleted/moved/renamed) gets a distinct
    // failure + toast so the user knows the file is gone; a fresh upload keeps
    // the legacy plain Error (generic failed entry, same behavior as before).
    if (entry.resumeUri !== undefined) {
      throw new ResumeFileMissingError(basename(path));
    }
    // Plain Error (not UploadError) so the entry shows 'failed', same as the
    // old whole-file read failure.
    throw new Error(`file not found on disk: ${basename(path)}`);
  }
  // The file changed size since the interruption: the old session's
  // Content-Range is invalid, and its pre-generated id may already own a
  // server-side file of the OLD size (a same-id retry would resolve DONE
  // against the stale file). Drop BOTH — the upload silently restarts from 0
  // with the new size and a fresh id.
  if (
    entry.resumeTotalSize !== undefined &&
    stat.size !== entry.resumeTotalSize
  ) {
    entry.resumeUri = undefined;
    entry.resumeClientGeneratedId = undefined;
  }
  // Persist the freshly-statted size so a FUTURE resume can run the same
  // size-change check (best-effort — persistActiveSession logs its own warn).
  await persistActiveSession(entry, { totalSize: stat.size });
  if (!(await quotaAllows(entry, stat.size))) {
    throw new UploadError(ERROR_QUOTA_EXCEEDED, "quota");
  }
  return uploadDiskPathChunked(entry, path, stat.size);
}

async function uploadDiskPathChunked(
  entry: InternalEntry,
  path: string,
  totalSize: number,
): Promise<DriveFileItem> {
  // Generated ONCE per logical upload: the chunked uploader restarts its
  // session internally (MAX_UPLOAD_ATTEMPTS), and every session must stay
  // bound to the same pre-generated id (idempotent retry — see tryGenerateClientId).
  // A RESUMED upload REUSES the id persisted with its session (slice 5.2): a
  // retry that already completed server-side then answers 409 → resolve DONE
  // with the real file instead of creating a duplicate.
  const clientGeneratedId =
    entry.resumeClientGeneratedId ?? (await tryGenerateClientId(entry));
  let stream = await openDiskReadStream(path);
  let consumed = 0;
  // Tail of a chunk that straddled the requested skip offset, served before
  // the stream is read again so every returned chunk starts exactly at the
  // offset the resumable session asked for.
  let remainder: Uint8Array | null = null;
  const readChunk = async (offset: number): Promise<Uint8Array | null> => {
    if (offset < consumed) {
      // A 308 resume can ask for bytes we already consumed (server received
      // fewer than sent). The rid-backed handle only reads forward, so reopen
      // the stream and skip to the requested offset.
      await stream.close();
      stream = await openDiskReadStream(path);
      consumed = 0;
      remainder = null;
    }
    while (consumed < offset) {
      const skipped = await stream.read();
      if (skipped === null) break;
      const next = consumed + skipped.byteLength;
      if (next > offset) {
        // The chunk straddles the requested offset: keep its tail (starting
        // exactly at `offset`) instead of discarding it — the old
        // discard-then-read desynced the stream and uploaded data shifted by
        // `next - offset` bytes, silently corrupting the file.
        remainder = skipped.slice(offset - consumed);
        consumed = offset;
        break;
      }
      consumed = next;
    }
    if (remainder !== null) {
      const r = remainder;
      remainder = null;
      consumed += r.byteLength;
      return r;
    }
    const chunk = await stream.read();
    if (chunk === null) return null;
    consumed += chunk.byteLength;
    return chunk;
  };
  try {
    return await uploadFileResumableChunked(entry.token, {
      name: entry.name,
      parentId: entry.parentId,
      totalSize,
      readChunk,
      // The entry's cancel controller is wired into the real uploader so a
      // cancelUpload aborts the in-flight Drive request (driveApi rejects
      // with UploadError('aborted')).
      signal: controllerFor(entry)?.signal,
      clientGeneratedId,
      // Slice 5.2: seed the uploader with the persisted session URI — attempt
      // 0 queries its status (308 → continue at the server byte, 200 → done,
      // 404 → fresh session). Undefined for fresh uploads and after a
      // size-change drop, both meaning "start from 0".
      initialUploadUri: entry.resumeUri,
      // Persist the live session URI as soon as a session exists (best-effort,
      // fire-and-forget): a crash after this point can still resume. A failed
      // write costs only the resume — persistActiveSession never throws.
      onSessionUpdate: (uploadUri) => {
        void persistActiveSession(entry, {
          uploadUri,
          ...(clientGeneratedId !== undefined ? { clientGeneratedId } : {}),
          totalSize,
        });
      },
      // Progress is written silently on the entry and surfaced via a throttled
      // notify (at most one per PROGRESS_NOTIFY_INTERVAL_MS): onProgress can
      // fire once per chunk (128× on a 1 GB file = 128 chunks) and per-chunk
      // notifies would spam subscribers.
      onProgress: (fraction) => {
        entry.progress = fraction;
        scheduleProgressNotify(entry);
      },
    });
  } finally {
    await stream.close();
  }
}

async function handleFolderChild(entry: InternalEntry): Promise<DriveFileItem> {
  // A subfolder's parent is the dir ABOVE it ('sub' -> batch root;
  // 'sub/sub2' -> 'sub'), resolved via the batch memo.
  const parentDir = dirOf(entry.relativeDir ?? "");
  const parentId = entry.batchMemo?.get(parentDir);
  if (!parentId) throw new ParentFolderMissingError(parentDir);
  entry.parentId = parentId;
  // Cancel must abort the in-flight createFolder (driveApi forwards the
  // signal into driveFetch); the rejection is normalized so a cancel of a
  // subfolder surfaces as 'aborted', not 'failed' + error toast.
  const signal = controllerFor(entry)?.signal;
  return abortIfCancelled(
    createFolder(entry.token, entry.name, entry.parentId, signal),
    signal,
  );
}

async function handleFolderRoot(entry: InternalEntry): Promise<DriveFileItem> {
  const dirPath = requireDiskPath(entry);
  await registerUploadPath(dirPath);
  // The batch's cancel controller must reach BOTH the walk and the folder
  // creation: without it a cancel of the root folder would still walk + create
  // + enqueue every child, and the children would upload despite the cancel.
  const signal = controllerFor(entry)?.signal;
  const walked = await abortIfCancelled(
    walkDiskFolder(dirPath, signal),
    signal,
  );
  const rootFolder = await abortIfCancelled(
    createFolder(entry.token, entry.name, entry.parentId, signal),
    signal,
  );
  const memo = new Map<string, string>();
  memo.set("", rootFolder.id);
  const batch: FolderBatch = { entry, memo };
  // A cancel that landed while createFolder was resolving must not enqueue the
  // walked children — they would upload after the user already cancelled.
  if (signal?.aborted) throw abortedUploadError();
  // walkDiskFolder sorts by relativePath, so a folder's entry (and thus its
  // creation) always precedes the files inside it - the sequential queue
  // preserves that order and the memo is filled before children resolve it.
  for (const item of walked) {
    if (item.isDirectory) {
      if (!memo.has(item.relativePath))
        enqueueFolderChild(batch, item.relativePath);
    } else {
      ensureSubfolderChain(batch, item.relativePath);
      enqueueChildFile(batch, item);
    }
  }
  return rootFolder;
}

// One folder entry per distinct subfolder (memo dedupes), even if walk omits dirs.
function ensureSubfolderChain(batch: FolderBatch, relPath: string): void {
  const dir = dirOf(relPath);
  if (!dir) return;
  let acc = "";
  for (const segment of dir.split("/")) {
    acc = acc ? `${acc}/${segment}` : segment;
    if (!batch.memo.has(acc)) {
      enqueueFolderChild(batch, acc);
    }
  }
}

function enqueueFolderChild(batch: FolderBatch, relativeDir: string): void {
  const entry: InternalEntry = {
    id: `${PENDING_ID_PREFIX}${crypto.randomUUID()}`,
    name: basename(relativeDir),
    isFolder: true,
    parentId: batch.entry.parentId, // placeholder - resolved during processing
    status: "queued",
    token: batch.entry.token,
    kind: "folderChild",
    relativeDir,
    batchMemo: batch.memo,
  };
  batch.memo.set(relativeDir, ""); // '' marker = enqueued, drive id pending
  entries.push(entry);
}
function enqueueChildFile(batch: FolderBatch, item: DiskEntry): void {
  entries.push({
    id: `${PENDING_ID_PREFIX}${crypto.randomUUID()}`,
    name: basename(item.relativePath),
    isFolder: false,
    parentId: batch.entry.parentId, // placeholder - resolved during processing
    diskPath: item.path,
    status: "queued",
    token: batch.entry.token,
    kind: "folderChildFile",
    relativeDir: dirOf(item.relativePath),
    batchMemo: batch.memo,
  });
}

// Bytes-path uploads (picker/tests keep the whole body in memory): quota check
// then uploadFileResumable with manager-level retries — the SINGLE retry layer
// for the bytes path (uploadFileResumable is one attempt; retry lives here, so
// a transient failure is retried at most 3 times, never 3×2). Disk paths
// bypass this and go through uploadDiskFileStreaming — the chunked uploader
// retries transient failures internally (2 session restarts via its own
// MAX_UPLOAD_ATTEMPTS + per-chunk backoff through the 308-resume protocol), a
// DIFFERENT mechanism, so layering the manager retries on top would multiply
// upload attempts.
async function uploadWithQuotaAndRetry(
  entry: InternalEntry,
  data: Blob | Uint8Array,
): Promise<DriveFileItem> {
  const byteLength = data instanceof Blob ? data.size : data.byteLength;
  if (!(await quotaAllows(entry, byteLength))) {
    throw new UploadError(ERROR_QUOTA_EXCEEDED, "quota");
  }
  return uploadWithRetry(entry, data);
}
// Unknown quota (fetch fail / null) must never block: getDriveStorageQuota logs its own warn.
async function quotaAllows(
  entry: InternalEntry,
  byteLength: number,
): Promise<boolean> {
  // Fail-early guard (single choke point for BOTH the bytes and the disk
  // path): reject >5 TB files before any quota fetch or upload call, because
  // Google fails such uploads mid-transfer — a >5 TB file is a defective
  // seed, so it should fail in milliseconds, not hours.
  if (byteLength > MAX_FILE_BYTES) {
    throw new FileTooLargeError(byteLength);
  }
  let quota: DriveStorageQuota | null;
  try {
    quota = await getDriveStorageQuota(entry.token);
  } catch (err) {
    await captureError({
      level: "warn",
      source: MODULE,
      message: `quota-check-skipped name=${entry.name}: ${describeError(err)}`,
    });
    return true;
  }
  if (quota === null) return true;
  if (quota.limit === null) return true; // unlimited account (pooled Workspace quota)
  return quota.usage + byteLength <= quota.limit;
}

// ONE pre-generated id per logical upload: retry attempts must bind their
// sessions to the SAME id or Drive would create a duplicate file when the
// first PUT succeeded server-side but its response was lost (the idempotent
// retry fix — driveUpload turns the retry's 409 into a resolve-DONE). A
// failure only degrades to the legacy non-idempotent upload — never blocks.
async function tryGenerateClientId(
  entry: InternalEntry,
): Promise<string | undefined> {
  try {
    return await generateClientId(entry.token, controllerFor(entry)?.signal);
  } catch (err) {
    await captureError({
      level: "warn",
      source: MODULE,
      message: `client-id-generation-failed name=${entry.name}: ${describeError(err)}`,
    });
    return undefined;
  }
}

// Only transient network failures are retried (bounded backoff); pending row stays.
async function uploadWithRetry(
  entry: InternalEntry,
  data: Blob | Uint8Array,
): Promise<DriveFileItem> {
  const signal = controllerFor(entry)?.signal;
  // Generated BEFORE the retry loop so every attempt creates a session bound
  // to the same pre-generated id — the core of the idempotent-retry fix.
  const clientGeneratedId = await tryGenerateClientId(entry);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw abortedUploadError();
    try {
      return await uploadFileResumable(
        entry.token,
        data,
        entry.name,
        entry.parentId,
        signal,
        { clientGeneratedId },
      );
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof UploadError &&
        err.kind === "network" &&
        attempt < MAX_UPLOAD_ATTEMPTS;
      if (!retryable) throw err;
      await sleep(backoffDelay(attempt - 1));
      // An abort during the backoff must not schedule another attempt — the
      // user asked to cancel; re-firing would waste a fresh upload session.
      if (signal?.aborted) throw abortedUploadError();
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new UploadError("upload failed", "network");
}
function abortedUploadError(): UploadError {
  return new UploadError(ABORTED_UPLOAD_MESSAGE, ERROR_ABORTED);
}

// Normalize a rejection caused by a user-initiated cancel into the manager's
// canonical UploadError('aborted'). A raw AbortError/DOMException would
// otherwise classify as 'failed' and show an error toast — markError only
// treats UploadError kind 'aborted' as a silent cancel. The signal is
// re-checked in the catch (instead of inspecting err.name) because diskFs
// throws its own AbortError-like error and driveFetch rethrows the merged
// fetch rejection; both are aborts and both are normalized here.
async function abortIfCancelled<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (signal?.aborted) throw abortedUploadError();
    throw err;
  }
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

// Resume metadata that only becomes known AFTER processEntry's first persist
// (slice 5.2): the stat size, the generated id and the live session URI.
interface SessionPersistExtra {
  totalSize?: number;
  uploadUri?: string;
  clientGeneratedId?: string;
}

// Best-effort IndexedDB snapshot of an ACTIVE upload (schema v9 uploadSessions)
// so a crashed/interrupted upload can be resumed on the next launch (slice
// 5.2). NEVER throws and never blocks the upload: the row is resume metadata
// only — a failed write only costs the resume, not the upload. Called from
// processEntry before handleByKind (base fields) and again as the upload
// progresses (stat size, session URI). A put with the SAME id overwrites the
// row, so later calls just enrich it.
async function persistActiveSession(
  entry: InternalEntry,
  extra?: SessionPersistExtra,
): Promise<void> {
  const now = Date.now();
  try {
    await db.uploadSessions.put({
      id: entry.id,
      userEmail: getCurrentUserEmail(),
      name: entry.name,
      isFolder: entry.isFolder,
      kind: entry.kind,
      // exactOptionalPropertyTypes: omit diskPath (bytes/folderChild have none)
      // instead of writing undefined.
      ...(entry.diskPath !== undefined ? { diskPath: entry.diskPath } : {}),
      parentId: entry.parentId,
      ...(extra?.totalSize !== undefined ? { totalSize: extra.totalSize } : {}),
      ...(extra?.uploadUri !== undefined ? { uploadUri: extra.uploadUri } : {}),
      ...(extra?.clientGeneratedId !== undefined
        ? { clientGeneratedId: extra.clientGeneratedId }
        : {}),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    await captureError({
      level: "warn",
      source: MODULE,
      message: `session-persist-failed name=${entry.name}: ${describeError(err)}`,
    });
  }
}

// Best-effort removal of the session row for a terminal entry (done / error /
// cancelled). A failed delete leaves a stale 'active' row that a future resume
// would retry pointlessly — so the failure is logged and the upload still
// completes. delete() of a never-persisted id resolves without error, making
// this safe for queued cancels too.
async function clearSession(entry: InternalEntry): Promise<void> {
  try {
    await db.uploadSessions.delete(entry.id);
  } catch (err) {
    await captureError({
      level: "warn",
      source: MODULE,
      message: `session-clear-failed name=${entry.name}: ${describeError(err)}`,
    });
  }
}
