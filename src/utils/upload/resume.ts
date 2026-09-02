import { db } from "../../db/db";
import type { UploadSessionRow } from "../../db/db";
import { captureError } from "../errorLog";
import { showErrorToast } from "../simpleToast";
import { t } from "i18next";
import { MODULE, describeError } from "./errors";
import { enqueuePendingRows } from "./enqueue";
import { notify } from "./events";
import { pump } from "./pump";
import { appendEntries } from "./queueState";
import { dbRowOp, resumeEntryFromRow } from "./session";
import type { InternalEntry } from "./types";

// Re-queue every resumable upload this user left interrupted (slice 5.2):
// disk-path rows become fresh queue entries carrying their persisted session
// URI (resumed at the server-confirmed byte) — non-resumable rows (bytes,
// folder roots, unresolved children) are counted and surfaced with ONE
// aggregated toast. Rows of OTHER users are never touched. Runs at most one
// scan at a time (module guard); enqueued entries flow through the same
// sequential pump as new uploads, so both can coexist safely.

// Re-entrancy guard for resumeInterruptedUploads — set synchronously
// before the first await so a second concurrent call returns immediately.
let resumeRunning = false;

/**
 * Resume interrupted uploads for the given user.
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
    appendEntries(...resumed);
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
