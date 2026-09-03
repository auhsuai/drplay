import { db, type DriveFile } from "./db";
import { ROOT_FOLDER_ID } from "../utils/driveConstants";

/**
 * Canonical parent rule: a file's parentId ALWAYS comes from the `parents`
 * array of the Drive API response of the very request that returned the file
 * (parents[0]) — never from "the folder currently being browsed" at call
 * time. A missing or empty parents array falls back to the My Drive root
 * sentinel.
 */
export function canonicalParent(parents?: readonly string[]): string {
  return parents?.[0] ?? ROOT_FOLDER_ID;
}

/** Raw row shape straight from a Drive API response: identical to DriveFile
 *  but carrying `parents[]` instead of the derived `parentId`. */
export type UpsertableFileRow = Omit<DriveFile, "parentId"> & {
  parents?: readonly string[];
};

/**
 * Single write path for `db.files`: maps each raw response row into its
 * stored shape (parentId via canonicalParent, every other field passed
 * through untouched) and writes them with ONE bulkPut — idempotent by
 * primary key (writing the same id twice overwrites, it never duplicates).
 * Rows are mapped explicitly instead of spread so the raw `parents` array
 * is not leaked into IndexedDB rows.
 *
 * Error contract: NOTHING is caught here. Dexie failures (quota, aborted
 * transaction, invalid key) propagate to the caller — each writer owns its
 * own error path (worker SYNC_ERROR vs UI error surface).
 */
export async function upsertFileRows(
  rows: readonly UpsertableFileRow[],
): Promise<void> {
  const storedRows: DriveFile[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    parentId: canonicalParent(row.parents),
    size: row.size,
    modifiedTime: row.modifiedTime,
    trashed: row.trashed,
    isFolder: row.isFolder,
    metadata: row.metadata,
  }));

  await db.files.bulkPut(storedRows);
}
