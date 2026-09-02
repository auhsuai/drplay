import { db } from "../../db/db";
import type { DriveFile } from "../../db/db";
import { captureError } from "../errorLog";
import {
  AUDIO_FILE_MIME,
  ERROR_INVALID_SEED,
  FOLDER_MIME,
  MODULE,
  PENDING_ID_PREFIX,
} from "./errors";
import { dbRowOp } from "./session";
import type { InternalEntry, UploadSeed } from "./types";

// Entry construction and the pending-row publish path: everything needed to
// turn an UploadSeed into a queue entry and give it its placeholder db.files
// row (the dimmed card) before the pump reaches it.

export function createEntry(seed: UploadSeed, token: string): InternalEntry {
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

// A queued entry's placeholder db.files row (the dimmed card in the live
// list) — same shape whether written at enqueue or by processEntry; putting
// the same id + content is idempotent, so both writes coexist safely.
export function pendingRow(entry: InternalEntry): DriveFile {
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
export function enqueuePendingRows(batch: InternalEntry[]): Promise<void> {
  if (batch.length === 0) return Promise.resolve();
  return dbRowOp(
    () => db.files.bulkPut(batch.map((e) => pendingRow(e))),
    "enqueue-pending-rows",
  );
}
