import { db } from "../../db/db";
import type { UploadSessionRow } from "../../db/db";
import { captureError } from "../errorLog";
import { getCurrentUserEmail } from "../storageKeys";
import { MODULE, PENDING_ID_PREFIX, describeError } from "./errors";
import type { InternalEntry } from "./types";

// Build a queue entry from a persisted session row (slice 5.2). Returns null
// when the row cannot be resumed — such rows only count toward the aggregated
// interrupted toast: 'bytes' (payload lost with the old process), 'folderRoot'
// (re-walking would create a DUPLICATE Drive folder) and 'folderChild'
// (no diskPath ever persisted) are never resumed; a 'folderChildFile' whose
// session never initiated has a placeholder parentId (the batch root's, not a
// resolved Drive id) and cannot resolve its parent without the lost batch memo.
export function resumeEntryFromRow(
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
export async function persistActiveSession(
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
export async function clearSession(entry: InternalEntry): Promise<void> {
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
