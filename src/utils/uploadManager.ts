import { t } from "i18next";
import { db } from "../db/db";
import type { DriveFile } from "../db/db";
import {
  backoffDelay,
  createFolder,
  getDriveStorageQuota,
  sleep,
} from "./driveApi";
import { ROOT_FOLDER_ID } from "./driveConstants";
import {
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
const ERROR_PARENT_FOLDER_MISSING = "parent-folder-missing";
const ERROR_FAILED = "failed";
const ERROR_ABORTED = "aborted";
// Disk-path error messages shared by every disk entry kind (file, child file,
// folder root); named constants keep one spelling across all call sites.
const ERROR_MISSING_DISK_PATH = "missing disk path";
const ERROR_QUOTA_EXCEEDED = "drive storage quota exceeded";
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

let entries: InternalEntry[] = [];
let busy = false;
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
  await dbRowOp(
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
  );
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
    // Plain Error (not UploadError) so the entry shows 'failed', same as the
    // old whole-file read failure.
    throw new Error(`file not found on disk: ${basename(path)}`);
  }
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

// Only transient network failures are retried (bounded backoff); pending row stays.
async function uploadWithRetry(
  entry: InternalEntry,
  data: Blob | Uint8Array,
): Promise<DriveFileItem> {
  const signal = controllerFor(entry)?.signal;
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
  entry.error = isAborted
    ? ERROR_ABORTED
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
    const isQuota = entry.error === ERROR_QUOTA;
    // UploadError messages are self-created constants (status/quota text — never
    // PII), so they are safe to log and carry the concrete 4xx that the kind
    // alone hides. A plain Error from diskFs can embed the full disk path, so
    // its message stays out of the log — only name + kind are recorded.
    const uploadDetail =
      err instanceof UploadError ? ` message=${err.message}` : "";
    // Never log the disk path or token - only the shortened file name.
    await captureError({
      level: isQuota ? "warn" : "error",
      source: MODULE,
      message: `upload-entry-failed name=${entry.name} kind=${entry.error}${uploadDetail}`,
      kind: entry.error,
    });
    if (isQuota) {
      showErrorToast(t("upload.quota_exceeded"));
    } else if (
      entry.error !== ERROR_INVALID_SEED &&
      entry.error !== ERROR_PARENT_FOLDER_MISSING
    ) {
      showErrorToast(t("upload.error"));
    }
  }
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
