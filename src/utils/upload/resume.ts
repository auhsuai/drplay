import { t } from "i18next";
import { db } from "../../db/db";
import type { UploadSessionRow } from "../../db/db";
import { captureError } from "../errorLog";
import { showErrorToast } from "../simpleToast";
import { getCurrentUserEmail } from "../storageKeys";
import { notify } from "./events";
import { MODULE, PENDING_ID_PREFIX, describeError } from "./errors";
import { enqueuePendingRows } from "./enqueue";
import { pump } from "./pump";
import { resumedPredecessors } from "./predecessor";
import { appendEntries, readEntries } from "./queueState";
import { dbRowOp, resumeEntryFromRow } from "./session";
import type { InternalEntry } from "./types";

// Re-queue every resumable upload this user left interrupted (slice 5.2) —
// the resume scan, ghost sweep and the module-level re-entrancy guard.

// Re-entrancy guard for resumeInterruptedUploads — set synchronously before
// the first await so a second concurrent call returns immediately. P2-F2:
// held for the ENTIRE function (scan → ghost sweep → enqueue + pump kick) and
// released only by the single final finally, so no phase of an in-flight
// round lets a second call slip through.
let resumeRunning = false;

export async function resumeInterruptedUploads(
  token: string,
  userEmail: string,
): Promise<void> {
  if (resumeRunning) return;
  resumeRunning = true;
  let interruptedCount = 0;
  // F4: ids of rows consumed as non-resumable THIS round. Their stale same-id
  // pending cards are ghosts too, but the item is ALREADY counted via
  // interruptedCount above — excluding them here prevents a double count when
  // the sweep tallies the remaining (never-started) ghosts.
  const consumedNonResumableIds = new Set<string>();
  let unstartedGhostCount = 0;
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
    // P2-F2 layer 2b helper: row ids already claimed by an earlier resume
    // round whose successor has not settled yet (map value = predecessor id).
    const claimedPredecessorIds = new Set<string>(resumedPredecessors.values());
    for (const row of rows) {
      // P2-F2 layer 2a: this row is the in-process identity of a LIVE entry —
      // startUploads persists each entry's own session row under the entry id,
      // and any-status matching also covers the terminal-but-unpruned window.
      // Rebuilding it would clone a running upload (two writers racing one
      // server session URI) and would flip a flying entry's own row from
      // 'active' to 'interrupted'.
      if (readEntries().some((e) => e.id === row.id)) continue;
      // P2F2 layer 2b: an earlier, still-unsettled resume round already
      // claimed this row (its successor lives in `entries` under a fresh id).
      // Skip WITHOUT deleting or re-marking: the rightful owner's settle
      // retires the row when its upload reaches a terminal state.
      if (claimedPredecessorIds.has(row.id)) continue;
      const entry = resumeEntryFromRow(row, token);
      if (entry === null) {
        // Non-resumable row: no successor row will EVER be created from it, so
        // keeping it would resurrect a dead session on every future launch.
        // Delete now (best-effort — a failed delete is logged and the stale
        // row would just be re-scanned next launch).
        consumedNonResumableIds.add(row.id);
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
    await dbRowOp(async () => {
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
      const liveSessionIds = new Set(
        (await db.uploadSessions.toArray()).map((row) => row.id),
      );
      // F1: a seed enqueued between this round's scan and this sweep owns a
      // pending card but NO session row yet (its processEntry persist has not
      // run). The pending files-row id IS the entry id verbatim (pendingCard
      // carries id: entry.id), so any row owned by a LIVE in-process entry is
      // not a ghost regardless of session state — any-status matching mirrors
      // the scan-time layer 2a guard above.
      const liveEntryIds = new Set(readEntries().map((e) => e.id));
      const ghostRows = (
        await db.files.where("id").startsWith(PENDING_ID_PREFIX).toArray()
      ).filter(
        (row) => !liveSessionIds.has(row.id) && !liveEntryIds.has(row.id),
      );
      if (ghostRows.length > 0) {
        // Compound PK (schema v10): delete this user's ghosts by
        // [userEmail, id]; other owners' cards are swept when their own
        // account runs the resume scan.
        const ownerEmail = getCurrentUserEmail();
        await db.files.bulkDelete(
          ghostRows.map((row) => [ownerEmail, row.id] as [string, string]),
        );
      }
      // F4: a ghost that is NOT the stale card of a row consumed this round is
      // the pending card of a seed that never started (crashed before its
      // processEntry persist — it has no uploadSessions row by definition).
      // Deletion stays unconditional (deleting is what prevents ghost
      // revival), but the silent loss must surface: count these into the same
      // aggregated interrupted toast.
      unstartedGhostCount = ghostRows.filter(
        (row) => !consumedNonResumableIds.has(row.id),
      ).length;
    }, "ghost-pending-sweep");
    // F4: never-started cards join the non-resumable rows in ONE aggregated
    // toast — never one per file.
    interruptedCount += unstartedGhostCount;
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
      // a folderChildFile's parent was resolved before its stat persist landed —
      // the totalSize gate in resumeEntryFromRow refuses any row still carrying
      // the batch-root placeholder, so row.parentId here is the actual Drive
      // folder. The kind filter below is defensive — if resumeEntryFromRow ever
      // resumes a placeholder-parented entry, that entry keeps getting its row
      // at processEntry as before.
      void enqueuePendingRows(
        resumed.filter(
          (e) => e.kind === "diskFile" || e.kind === "folderChildFile",
        ),
      );
      notify();
      void pump();
    }
  } finally {
    // P2-F2: the ONLY release point — every exit path (the early read-failure
    // return above included) funnels here AFTER every successor has been
    // enqueued, so no phase of an in-flight round admits a second call. The
    // pump is fire-and-forget on purpose: successors that outlive this
    // function are covered by the scan-time skips (layers 2a/2b), so the
    // guard need not wait for the queue to drain.
    resumeRunning = false;
  }
}
