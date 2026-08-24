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

// Stored rows carry the owning account so per-user scoping can never mix two
// accounts' mirrors. Declared here because DriveFile itself only gains
// `userEmail` in the schema migration that follows this helper.
type OwnedDriveFile = DriveFile & { userEmail: string };

/**
 * Single write path for `db.files`: maps each raw response row into its
 * stored shape (parentId via canonicalParent, stamped with ownerEmail, every
 * other field passed through untouched) and writes them with ONE bulkPut —
 * idempotent by primary key (writing the same id twice overwrites, it never
 * duplicates). Rows are mapped explicitly instead of spread so the raw
 * `parents` array is not leaked into IndexedDB rows.
 *
 * `knownParents` is the fallback parent source for responses that do NOT echo
 * a `parents[]` back (e.g. resumable-upload completions narrowed by
 * asDriveFileItem): the caller passes the parents ITSELF sent in the very
 * request that produced the row (e.g. the upload request's target folder).
 * A row's own `parents` always wins; when neither exists the parent roots.
 *
 * Error contract: NOTHING is caught here. Dexie failures (quota, aborted
 * transaction, invalid key) propagate to the caller — each writer owns its
 * own error path (worker SYNC_ERROR vs UI error surface).
 */
export async function upsertFileRows(
  rows: readonly UpsertableFileRow[],
  ownerEmail: string,
  knownParents?: readonly string[],
): Promise<void> {
  if (typeof ownerEmail !== "string" || ownerEmail.trim().length === 0) {
    throw new TypeError(
      `Expected upsertFileRows ownerEmail to be a non-empty account email identifying the row owner, got \`${ownerEmail}\``,
    );
  }

  const ownedRows: OwnedDriveFile[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    parentId: canonicalParent(row.parents ?? knownParents),
    size: row.size,
    modifiedTime: row.modifiedTime,
    trashed: row.trashed,
    isFolder: row.isFolder,
    metadata: row.metadata,
    userEmail: ownerEmail,
  }));

  await db.files.bulkPut(ownedRows);
}

/**
 * A pending upload card: a synthesized db.files row standing in for an
 * in-flight upload BEFORE Drive knows the file exists (id "pending-<uuid>").
 * It is NOT a Drive API resource — there is no response behind it and no
 * `parents[]` source — so its self-managed `parentId` (the folder the user
 * queued/dropped the file into, resolved for folder children before their
 * card lands) IS the truth. Deliberately never routed through canonicalParent:
 * there is no Drive source to canonically derive from, and rooting the card
 * would make it flash at the wrong place until the real row replaces it.
 */
export interface PendingFileCard {
  id: string;
  name: string;
  mimeType: string;
  parentId: string;
  isFolder: boolean;
  modifiedTime?: string;
}

/**
 * Write path for pending upload cards (the dimmed cards in the live list).
 * Same single-writer contract as upsertFileRows — ONE bulkPut so a batch's
 * cards land in one transaction preserving enqueue order (the list pin reads
 * insertion order), idempotent per PK. Stamps trashed=false + ownerEmail;
 * modifiedTime defaults to now, exactly like the former inline writes.
 *
 * Error contract: identical to upsertFileRows — nothing caught, Dexie/TypeError
 * failures propagate to the caller (queue.ts wraps these in its best-effort
 * dbRowOp capture).
 */
export async function upsertPendingCardRows(
  cards: readonly PendingFileCard[],
  ownerEmail: string,
): Promise<void> {
  if (typeof ownerEmail !== "string" || ownerEmail.trim().length === 0) {
    throw new TypeError(
      `Expected upsertPendingCardRows ownerEmail to be a non-empty account email identifying the row owner, got \`${ownerEmail}\``,
    );
  }

  const ownedRows: OwnedDriveFile[] = cards.map((card) => ({
    id: card.id,
    name: card.name,
    mimeType: card.mimeType,
    parentId: card.parentId,
    size: undefined,
    modifiedTime: card.modifiedTime ?? new Date().toISOString(),
    trashed: false,
    isFolder: card.isFolder,
    metadata: undefined,
    userEmail: ownerEmail,
  }));

  await db.files.bulkPut(ownedRows);
}
