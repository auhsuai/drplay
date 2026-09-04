import { upsertPendingCardRows, type PendingFileCard } from "../../db/fileRows";
import { captureError } from "../errorLog";
import { getCurrentUserEmail } from "../storageKeys";
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
// the same id + content is idempotent, so both writes coexist safely. The
// card is NOT a Drive resource: its self-managed parentId passes through
// upsertPendingCardRows verbatim (no canonical root fallback).
export function pendingCard(entry: InternalEntry): PendingFileCard {
  return {
    id: entry.id,
    name: entry.name,
    mimeType: entry.isFolder ? FOLDER_MIME : AUDIO_FILE_MIME,
    parentId: entry.parentId,
    isFolder: entry.isFolder,
  };
}

// Best-effort batch publish of pending rows at enqueue time — ONE bulkPut
// transaction so the list pin (which keeps dbFiles insertion order) mirrors
// enqueue order. Never blocks the upload: a failed write only delays the
// dimmed card until processEntry's own put (withDbCapture logs the warn).
export function enqueuePendingRows(batch: InternalEntry[]): Promise<void> {
  if (batch.length === 0) return Promise.resolve();
  return dbRowOp(
    () => upsertPendingCardRows(batch.map(pendingCard), getCurrentUserEmail()),
    "enqueue-pending-rows",
  );
}
