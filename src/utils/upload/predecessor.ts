import { db } from "../../db/db";
import { captureError } from "../errorLog";
import { getCurrentUserEmail } from "../storageKeys";
import { MODULE, describeError } from "./errors";
import { dbRowOp } from "./session";

// Interrupted-resume predecessor ledger: the only home of the in-process
// claim map and its settle/delete transitions, shared by the resume scan
// (sets claims) and the terminal paths (retires them).

// P2-B1a/B1c: resumed entry id -> interrupted SOURCE session row id. The
// source row is marked 'interrupted' at scan time and deleted only once the
// successor's own rows exist — deleting it earlier loses card + position on a
// mid-resume crash.
export const resumedPredecessors = new Map<string, string>();

// P2-B1a: delete the interrupted source pair — the OLD session row plus its
// stale same-id dimmed card (the successor publishes its rows under a fresh
// id, so both old copies are garbage the moment retirement is safe).
async function deleteInterruptedPredecessor(oldRowId: string): Promise<void> {
  await dbRowOp(
    () => db.uploadSessions.delete(oldRowId),
    "session-resume-delete",
  );
  await dbRowOp(
    // Compound PK (schema v10): [userEmail, id].
    () => db.files.delete([getCurrentUserEmail(), oldRowId]),
    "pending-row-delete",
  );
}

// P2-B1a: retire an entry's interrupted source row once it is safe. With
// requireSuccessorRow the deletion happens only when the successor's OWN
// session row exists — a failed persist keeps the source recoverable for the
// next scan. Without it the entry reached a definitive end (done / error /
// cancel), where keeping the source would only resurrect dead work.
export async function settleResumedPredecessor(
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
