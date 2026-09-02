import { db } from "../../db/db";
import type { DriveFileItem } from "../driveApi";
import { UploadError } from "../driveUpload";
import { notify, resetProgressNotify } from "./events";
import { createEntry, enqueuePendingRows, pendingRow } from "./enqueue";
import { createControllerFor } from "./controllers";
import { handleFolderChild, handleFolderRoot } from "./folderBatch";
import { markDone, markError } from "./terminal";
import { uploadWithQuotaAndRetry } from "./retry";
import { appendEntries, nextQueued } from "./queueState";
import { dbRowOp, persistActiveSession } from "./session";
import { handleChildFile, handleDiskFile } from "./streaming";
import type { InternalEntry, UploadSeed } from "./types";

// Uploads run at most UPLOAD_CONCURRENCY entries in parallel. Google Drive's
// per-user quota (325,000 units/min, units model since 2026-05-01) allows this
// generously; 2 is the safe default against 429 storms on weak links — raise
// only after measuring real throughput.
const UPLOAD_CONCURRENCY = 2;

// Re-entrancy guard: only one pump loop may run at a time (see pump()).
let busy = false;

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
  const queued: InternalEntry[] = [];
  for (const seed of seeds) {
    const entry = createEntry(seed, token);
    appendEntries(entry);
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

export async function pump(): Promise<void> {
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
      // pushed here — queueState stays the single owner of `entries`.
      return handleFolderRoot(entry, (child) => {
        appendEntries(child);
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
