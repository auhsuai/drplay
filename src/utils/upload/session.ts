import { db } from "../../db/db";
import type { UploadSessionRow } from "../../db/db";
import { captureError } from "../errorLog";
import { getCurrentUserEmail } from "../storageKeys";
import { MODULE, PENDING_ID_PREFIX, describeError } from "./errors";
import type { InternalEntry } from "./types";

// Google resumable upload sessions expire after one week of inactivity
// (developers.google.com/workspace/drive/api/guides/manage-uploads — "A
// resumable session URI expires after one week"). A persisted row whose last
// activity is older than this is a dead session: resuming it would only cost
// a 404 query-status round-trip and a restart.
export const UPLOAD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  // Drive expires a resumable session URI after one week of inactivity, so a
  // row whose updatedAt is older than the TTL is a dead session — refuse it
  // like any other non-resumable row so the caller deletes it and counts it
  // into the interrupted toast instead of pointlessly querying a dead URI.
  // Rows missing updatedAt (written before schema v9) are refused the same
  // way — never trust an absent timestamp. An active upload renews updatedAt
  // on every persist (persistActiveSession), so in-flight work is renewed
  // naturally and never falsely expired.
  if (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime legacy rows CAN lack updatedAt despite the TS type (schema v9) requiring it; IndexedDB rows from older schemas are not re-typed.
    row.updatedAt === undefined ||
    Date.now() - row.updatedAt > UPLOAD_SESSION_TTL_MS
  ) {
    return null;
  }
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

// Shared best-effort DB capture used by persistActiveSession / clearSession /
// queue.dbRowOp: run the op, swallow failures and log a warn with the exact
// per-call-site message (behavior identical to the three former inline
// try/catch blocks). The message builder receives the op name so call sites
// that embed it in their message string keep their exact wording.
export async function withDbCapture(
  opName: string,
  fn: () => Promise<unknown>,
  message: (opName: string, err: unknown) => string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    await captureError({
      level: "warn",
      source: MODULE,
      message: message(opName, err),
    });
  }
}

// Shared best-effort DB row operation (see withDbCapture): swallow failures
// and log `${label}-db-failed` — the same message the old inline try/catch
// produced.
export async function dbRowOp(
  op: () => Promise<unknown>,
  label: string,
): Promise<void> {
  return withDbCapture(
    label,
    op,
    (opName, err) => `${opName}-db-failed: ${describeError(err)}`,
  );
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
  await withDbCapture(
    "session-persist",
    async () => {
      // A Dexie put REPLACES the whole row, so the enrich puts (stat size,
      // session URI) must carry the FIRST write's createdAt forward —
      // resumeInterruptedUploads sorts rows by createdAt ("oldest first =
      // original order"), and re-stamping it on every persist would reorder
      // resumed uploads by last activity instead.
      const existing = await db.uploadSessions.get(entry.id);
      const createdAt =
        typeof existing?.createdAt === "number" ? existing.createdAt : now;
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
        ...(extra?.totalSize !== undefined
          ? { totalSize: extra.totalSize }
          : {}),
        ...(extra?.uploadUri !== undefined
          ? { uploadUri: extra.uploadUri }
          : {}),
        ...(extra?.clientGeneratedId !== undefined
          ? { clientGeneratedId: extra.clientGeneratedId }
          : {}),
        status: "active",
        createdAt,
        updatedAt: now,
      });
    },
    (_opName, err) =>
      `session-persist-failed name=${entry.name}: ${describeError(err)}`,
  );
}

// Best-effort removal of the session row for a terminal entry (done / error /
// cancelled). A failed delete leaves a stale 'active' row that a future resume
// would retry pointlessly — so the failure is logged and the upload still
// completes. delete() of a never-persisted id resolves without error, making
// this safe for queued cancels too.
export async function clearSession(entry: InternalEntry): Promise<void> {
  await withDbCapture(
    "session-clear",
    () => db.uploadSessions.delete(entry.id),
    (_opName, err) =>
      `session-clear-failed name=${entry.name}: ${describeError(err)}`,
  );
}
