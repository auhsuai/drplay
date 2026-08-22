import { t } from "i18next";
import { db } from "../../db/db";
import type { DriveFile, UploadSessionRow } from "../../db/db";
import type { DriveFileItem } from "../driveApi";
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
  collectActiveCoverage,
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
  withDbCapture,
} from "./session";
import { handleChildFile, handleDiskFile } from "./streaming";
import type { InternalEntry, UploadSeed } from "./types";

let entries: InternalEntry[] = [];
let busy = false;
// Slice 5.2: re-entrancy guard for resumeInterruptedUploads — set synchronously
// before the first await so a second concurrent call returns immediately.
let resumeRunning = false;
// Monotonic scan head for pump: the first queued entry is searched from here
// instead of from index 0 on every iteration (a batch of N uploads was
// O(n²) — ~3N² array ops at N=5000). Invariants that keep it correct:
// 1) every enqueue path (startUploads, resumeInterruptedUploads, folder
//    children) appends at the TAIL, i.e. at index >= nextScanIndex;
// 2) nothing before the head ever returns to 'queued' (processEntry flips to
//    'uploading' synchronously, terminal entries are pruned);
// 3) pruneEntry pulls the head back by one when it removes an entry AHEAD of
//    it, because the filter copy shifts every later index left by one.
let nextScanIndex = 0;

// P2-B1a/B1c: resumed entry id -> interrupted SOURCE session row id. The
// source row is marked 'interrupted' at scan time and deleted only once the
// successor's own rows exist — deleting it earlier loses card + position on a
// mid-resume crash.
const resumedPredecessors = new Map<string, string>();

// Uploads run at most UPLOAD_CONCURRENCY entries in parallel. Google Drive's
// per-user quota (325,000 units/min, units model since 2026-05-01) allows this
// generously; 2 is the safe default against 429 storms on weak links — raise
// only after measuring real throughput.
const UPLOAD_CONCURRENCY = 2;

// events.ts (notify/getEntries/getUploadState) must READ the live entries but
// never own/mutate them — hand it a read-only getter so the import graph stays
// acyclic (queue -> events, never events -> queue).
bindEntries(() => entries);

/**
 * Enqueue uploads and start pumping the queue. The manager runs up to
 * UPLOAD_CONCURRENCY uploads in parallel (see pump()) and publishes a pending
 * db.files row per entry so the UI can render dimmed cards immediately, long
 * before Drive confirms anything. Invalid seeds (folder without a disk path,
 * file without bytes/path) surface as error entries instead of throwing.
 * @param seeds The items to upload (bytes payloads or disk paths).
 * @param token Drive access token for this batch's requests.
 */
export function startUploads(seeds: UploadSeed[], token: string): void {
  const queued: InternalEntry[] = [];
  for (const seed of seeds) {
    // P2-B4 duplicate-seed guard: a seed whose (diskPath, parentId) matches an
    // ACTIVE (queued/uploading) entry would upload a second identical Drive
    // copy (double-click menu / double-drop). Skip it — terminal entries are
    // pruned from `entries`, so done/error files stay re-uploadable on purpose.
    if (
      seed.diskPath !== undefined &&
      hasActiveDuplicate(seed.diskPath, seed.parentId)
    ) {
      // Basename only in the log — never the user's full disk path.
      void captureError({
        level: "warn",
        source: MODULE,
        message: `duplicate-seed-skipped name=${seed.name}`,
      });
      continue;
    }
    const entry = createEntry(seed, token);
    entries.push(entry);
    // Invalid seeds are terminal 'error' entries — they never touch the DB.
    if (entry.status === "queued") queued.push(entry);
  }
  if (queued.length > 0) {
    // Publish a pending db.files row for EVERY queued seed up-front so the My
    // Drive list renders the whole batch immediately, not one card at a time
    // as the sequential pump reaches each entry (processEntry alone only wrote
    // the row of the entry currently uploading). Best-effort: a failed
    // bulkPut only costs the early visibility — processEntry re-puts each row
    // when its own turn comes, so nothing downstream depends on this write.
    void enqueuePendingRows(queued);
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
      if (entry === null) {
        // Non-resumable row: no successor row will EVER be created from it, so
        // keeping it would resurrect a dead session on every future launch.
        // Delete now (best-effort — a failed delete is logged and the stale
        // row would just be re-scanned next launch).
        await dbRowOp(
          () => db.uploadSessions.delete(row.id),
          "session-resume-delete",
        );
        interruptedCount += 1;
        continue;
      }
      // P2-B1a: mark instead of delete — a crash before the successor's own
      // row persists must leave this source intact so the next scan rebuilds
      // card + position. update() patches ONLY the status: refreshing
      // updatedAt would extend the 7-day TTL clock across repeated failed
      // resumes.
      await dbRowOp(
        () => db.uploadSessions.update(row.id, { status: "interrupted" }),
        "session-resume-mark",
      );
      resumedPredecessors.set(entry.id, row.id);
      resumed.push(entry);
    }
    // Ghost sweep (P1-B1b): a pending db.files row from a dead process whose
    // uploadSessions row no longer exists renders forever as a dimmed card.
    // Runs AFTER the loop above consumed this user's non-resumable rows (their
    // ids are gone from uploadSessions, so their stale same-id rows count as
    // ghosts; a resumed source KEEPS its id as 'interrupted' until the
    // successor's rows land, so its old card survives the sweep on purpose —
    // P2-B1a) and BEFORE enqueuePendingRows publishes fresh rows for the
    // resumed entries below, so those new ids survive the sweep. The keep-set
    // spans ALL users' remaining sessions — a pending row backed by another
    // user's still-active session must be kept untouched.
    await dbRowOp(async () => {
      const liveSessionIds = new Set(
        (await db.uploadSessions.toArray()).map((row) => row.id),
      );
      const ghostRows = (
        await db.files.where("id").startsWith(PENDING_ID_PREFIX).toArray()
      ).filter((row) => !liveSessionIds.has(row.id));
      if (ghostRows.length > 0) {
        await db.files.bulkDelete(ghostRows.map((row) => row.id));
      }
    }, "ghost-pending-sweep");
  } finally {
    resumeRunning = false;
  }
  if (interruptedCount > 0) {
    // ONE aggregated toast for every non-resumable row — never one per file.
    showErrorToast(t("upload.interrupted"));
  }
  if (resumed.length > 0) {
    entries.push(...resumed);
    // Publish pending rows for resumed entries the same way fresh seeds do, so
    // the list shows them immediately instead of when their pump turn starts.
    // resumeEntryFromRow only ever returns diskFile / folderChildFile entries
    // (folderRoot / folderChild / bytes rows are not resumable), and BOTH kinds
    // carry a REAL parentId when resumed: diskFile keeps the seed's parent, and
    // a folderChildFile's parent was resolved by handleChildFile BEFORE its
    // session URI was persisted (resumeEntryFromRow refuses URI-less rows), so
    // its row.parentId is the actual Drive folder. The kind filter below is
    // defensive — if resumeEntryFromRow ever resumes a placeholder-parented
    // entry, that entry keeps getting its row at processEntry as before.
    void enqueuePendingRows(
      resumed.filter(
        (e) => e.kind === "diskFile" || e.kind === "folderChildFile",
      ),
    );
    notify();
    void pump();
  }
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

// An entry is reachable by its pending id ('pending-…') or, once known, by its
// Drive id — callers may hold either. Shared lookup for cancelUpload and
// getUploadProgress.
function findEntryByAnyId(id: string): InternalEntry | undefined {
  return entries.find((e) => e.id === id || e.driveId === id);
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

// A queued entry never touched the network: flip it to terminal so pump skips
// it, drop the (absent) pending row safely, then notify + prune like any
// other terminal transition (subscribers must observe the terminal state).
function cancelQueuedEntry(entry: InternalEntry): void {
  entry.status = "error";
  entry.error = ERROR_ABORTED;
  void dbRowOp(() => db.files.delete(entry.id), "pending-row-delete");
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

// P2-B4 duplicate-seed guard: does a live entry with the same
// (diskPath, parentId) still sit in queued/uploading? Only disk-path seeds
// carry the stable identity this check needs (bytes seeds have no key).
function hasActiveDuplicate(diskPath: string, parentId: string): boolean {
  return entries.some(
    (e) =>
      e.diskPath === diskPath &&
      e.parentId === parentId &&
      (e.status === "queued" || e.status === "uploading"),
  );
}

// A queued entry's placeholder db.files row (the dimmed card in the live
// list) — same shape whether written at enqueue or by processEntry; putting
// the same id + content is idempotent, so both writes coexist safely.
function pendingRow(entry: InternalEntry): DriveFile {
  return {
    id: entry.id,
    name: entry.name,
    mimeType: entry.isFolder ? FOLDER_MIME : AUDIO_FILE_MIME,
    parentId: entry.parentId,
    trashed: false,
    isFolder: entry.isFolder,
    modifiedTime: new Date().toISOString(),
  };
}

// Best-effort batch publish of pending rows at enqueue time — ONE bulkPut
// transaction so the list pin (which keeps dbFiles insertion order) mirrors
// enqueue order. Never blocks the upload: a failed write only delays the
// dimmed card until processEntry's own put (withDbCapture logs the warn).
function enqueuePendingRows(batch: InternalEntry[]): Promise<void> {
  if (batch.length === 0) return Promise.resolve();
  return dbRowOp(
    () => db.files.bulkPut(batch.map((e) => pendingRow(e))),
    "enqueue-pending-rows",
  );
}

// A folder-child FILE cannot start before its parent folder's Drive id is
// known: handleChildFile throws ParentFolderMissingError on the '' memo
// marker. The parent (a folderChild entry) is always enqueued before its
// children (walk order), so a child whose memo is still '' is blocked while
// the parent is queued/uploading — once the parent settles (done → memo set,
// or cancelled/errored → gone from the queue) the child is claimable again
// and either uploads or fails with parent-folder-missing like the sequential
// queue did.
function childParentResolved(entry: InternalEntry): boolean {
  if (entry.kind !== "folderChildFile" || entry.batchMemo === undefined) {
    return true;
  }
  const dir = entry.relativeDir ?? "";
  if (entry.batchMemo.get(dir)) return true;
  return !entries.some(
    (e) =>
      e.batchMemo === entry.batchMemo &&
      e.kind === "folderChild" &&
      e.relativeDir === dir &&
      (e.status === "queued" || e.status === "uploading"),
  );
}

// First CLAIMABLE entry with status 'queued', scanned from the monotonic head —
// FIFO by array order, identical selection to the old entries.find from index 0,
// but each entry is visited at most once per pass (entries at index < head
// are settled by invariant — see the nextScanIndex comment). When the scan
// runs out, the head resets to the tail so the next pump pass starts fresh.
// A blocked child (parent folder still resolving) does NOT advance the head —
// the next scan re-evaluates it, while a claimable entry further along the
// queue is still claimed (a free slot must not stall behind one unresolved
// parent).
function nextQueued(): InternalEntry | undefined {
  let firstBlocked: number | undefined;
  for (let i = nextScanIndex; i < entries.length; i++) {
    const candidate = entries[i];
    if (candidate === undefined) continue; // noUncheckedIndexedAccess guard — array has no holes
    if (candidate.status !== "queued") continue;
    if (!childParentResolved(candidate)) {
      if (firstBlocked === undefined) firstBlocked = i;
      continue;
    }
    nextScanIndex = firstBlocked ?? i + 1;
    return candidate;
  }
  nextScanIndex = firstBlocked ?? entries.length;
  return undefined;
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    // Runs started by THIS pump, tracked so the loop stays alive until all of
    // them settle: a folder root pushes its children mid-flight, and the
    // re-scan must still catch them after the initial claim ran dry. The set
    // IS the concurrency counter (UPLOAD_CONCURRENCY slots); Promise.race
    // refills a slot the moment ANY run settles, so the next queued entry
    // starts as soon as one of the in-flight entries finishes — never later.
    const inFlight = new Set<Promise<void>>();
    for (;;) {
      while (inFlight.size < UPLOAD_CONCURRENCY) {
        const next = nextQueued();
        if (!next) break;
        const task = processEntry(next);
        inFlight.add(task);
        void task.finally(() => {
          inFlight.delete(task);
        });
      }
      if (inFlight.size === 0) break;
      // processEntry never rejects (every path ends in markDone/markError),
      // and each task is already observed by the finally above.
      await Promise.race([...inFlight]);
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
    dbRowOp(() => db.files.put(pendingRow(entry)), "pending-row"),
    // P2-B1c: a resumed entry re-persists its INHERITED session metadata at
    // the first write — otherwise a crash before the chunked uploader reports
    // a fresh URI drops the still-valid server session and restarts at byte 0.
    persistActiveSession(entry, inheritedResumeExtras(entry)),
  ]);
  // P2-B1a: both successor rows were attempted — retire the marked source
  // pair, but only if the successor's own session row really landed.
  await settleResumedPredecessor(entry.id, true);
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
  const removedIndex = entries.indexOf(entry);
  entries = entries.filter((e) => e !== entry);
  // The filter copy shifts every index after the removed one left by one, so
  // a removal AHEAD of the scan head must pull the head back to keep pointing
  // at the same logical position (removals behind it leave it untouched).
  if (removedIndex !== -1 && removedIndex < nextScanIndex) {
    nextScanIndex -= 1;
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

async function markError(entry: InternalEntry, err: unknown): Promise<void> {
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
// P2-B1a: delete the interrupted source pair — the OLD session row plus its
// stale same-id dimmed card (the successor publishes its rows under a fresh
// id, so both old copies are garbage the moment retirement is safe).
async function deleteInterruptedPredecessor(oldRowId: string): Promise<void> {
  await dbRowOp(
    () => db.uploadSessions.delete(oldRowId),
    "session-resume-delete",
  );
  await dbRowOp(() => db.files.delete(oldRowId), "pending-row-delete");
}

// P2-B1a: retire an entry's interrupted source row once it is safe. With
// requireSuccessorRow the deletion happens only when the successor's OWN
// session row exists — a failed persist keeps the source recoverable for the
// next scan. Without it the entry reached a definitive end (done / error /
// cancel), where keeping the source would only resurrect dead work.
async function settleResumedPredecessor(
  successorId: string,
  requireSuccessorRow: boolean,
): Promise<void> {
  const oldRowId = resumedPredecessors.get(successorId);
  if (oldRowId === undefined) return;
  if (requireSuccessorRow) {
    try {
      if ((await db.uploadSessions.get(successorId)) === undefined) {
        // Successor persist never landed — keep the source untouched.
        return;
      }
    } catch (err) {
      // Read failure is transient/local: conservative fallback KEEPS the
      // source (never destroy the last remaining copy blindly).
      await captureError({
        level: "warn",
        source: MODULE,
        message: `resume-predecessor-check-failed: ${describeError(err)}`,
      });
      return;
    }
  }
  resumedPredecessors.delete(successorId);
  await deleteInterruptedPredecessor(oldRowId);
}

// P2-B1c: resume metadata carried onto the successor's first session snapshot
// (shape mirrors session.ts SessionPersistExtra). undefined for fresh entries,
// so their persisted rows stay byte-identical to before.
function inheritedResumeExtras(
  entry: InternalEntry,
):
  | { uploadUri?: string; totalSize?: number; clientGeneratedId?: string }
  | undefined {
  if (
    entry.resumeUri === undefined &&
    entry.resumeTotalSize === undefined &&
    entry.resumeClientGeneratedId === undefined
  ) {
    return undefined;
  }
  return {
    ...(entry.resumeUri !== undefined ? { uploadUri: entry.resumeUri } : {}),
    ...(entry.resumeTotalSize !== undefined
      ? { totalSize: entry.resumeTotalSize }
      : {}),
    ...(entry.resumeClientGeneratedId !== undefined
      ? { clientGeneratedId: entry.resumeClientGeneratedId }
      : {}),
  };
}

// Shared best-effort DB capture (see session.withDbCapture): swallow failures
// and log `${label}-db-failed` — the same message the old inline try/catch
// produced.
async function dbRowOp(
  op: () => Promise<unknown>,
  label: string,
): Promise<void> {
  return withDbCapture(
    label,
    op,
    (opName, err) => `${opName}-db-failed: ${describeError(err)}`,
  );
}
