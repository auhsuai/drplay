import { db } from "./db";
import { ROOT_FOLDER_ID } from "../utils/driveConstants";
import { captureError } from "../utils/errorLog";

// Log source label for the fire-and-forget reconcile reports.
const PRUNE_MODULE = "db/pruneRootRows";

/**
 * Deletes cached rows parked under this account's My Drive root ("root") whose
 * ids are absent from the authoritative listing just fetched. The root bucket
 * can be poisoned by rows historically persisted with an unverified "root"
 * parent (folders AND media), so every caller that listed "root" completely
 * reconciles it against the live ids.
 *
 * Scope is exactly the `[userEmail+parentId]` compound index for
 * `[ownerEmail, ROOT_FOLDER_ID]`; other accounts and non-root folders are
 * never touched. Deletion uses the `[ownerEmail, id]` compound primary keys.
 *
 * NEVER throws: a Dexie failure is logged once (without ids) and reported as
 * 0, because both call sites treat the prune as fire-and-forget after the
 * authoritative list is already displayed.
 */
export async function pruneStaleRootRows(
  ownerEmail: string,
  validIds: ReadonlySet<string>,
  opts: { foldersOnly: boolean },
): Promise<number> {
  try {
    const rootRows = await db.files
      .where("[userEmail+parentId]")
      .equals([ownerEmail, ROOT_FOLDER_ID])
      .toArray();
    const staleIds = rootRows
      .filter(
        (row) => (!opts.foldersOnly || row.isFolder) && !validIds.has(row.id),
      )
      .map((row) => row.id);
    if (staleIds.length === 0) return 0;

    await db.files.bulkDelete(
      staleIds.map((id): [string, string] => [ownerEmail, id]),
    );
    void captureError({
      level: "warn",
      source: PRUNE_MODULE,
      message: `pruned-stale-root-rows: deletedCount=${String(staleIds.length)}`,
    });
    return staleIds.length;
  } catch (e: unknown) {
    void captureError({
      level: "warn",
      source: PRUNE_MODULE,
      message: `prune-stale-root-rows-failed: ${
        e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      }`,
    });
    return 0;
  }
}
