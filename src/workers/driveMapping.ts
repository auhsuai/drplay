import type { UpsertableFileRow } from "../db/fileRows";

export interface DriveFile {
  id?: string | undefined;
  name?: string;
  mimeType?: string;
  size?: string;
  parents?: string[];
  trashed?: boolean;
  createdTime?: string;
  modifiedTime?: string;
  md5Checksum?: string;
}
export interface DriveChangesList {
  changes?: DriveChange[];
  nextPageToken?: string;
  newStartPageToken?: string;
}
export interface DriveChange {
  file?: DriveFile;
  fileId?: string;
  removed?: boolean;
  changeType?: string;
}

function toSize(raw: string | undefined | null): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

// Canonical-parent write path (schema v10): rows written through
// upsertFileRows derive parentId from parents[0] INSIDE the helper, so this
// mapper passes the raw `parents` array through untouched instead of
// pre-deriving it. This is THE single write path for synced rows (the
// single-write-path rule in src/db/fileRows.ts): new writers must go through
// this shape. `parents` passthrough keeps the response's own truth; the
// helper derives the parent from it and skips the row when neither the
// response nor the caller's known parent proves one (there is no root
// fallback).
//
// Shared mapping of a Google Drive file resource to the DB row shape used by
// both full-sync and delta-sync. isFolder is a parameter so callers that
// already computed it (delta-sync) don't recompute it. The parameter type is
// the post-guard shape (id guaranteed by isValidDriveFile); name/mimeType are
// guaranteed by the Drive fields= query, hence the explicit `as string`
// (mirrors the previous non-null assertions with identical runtime semantics).
//
// The returned row is intentionally WITHOUT userEmail: mapping a response is
// account-agnostic. The writer composes the final UpsertableFileRow with the
// account it validated ({...row, userEmail}) — upsertFileRows stamps its
// ownerEmail parameter authoritatively regardless.
export function toUpsertableFileRow(
  f: DriveFile & { id: string },
  isFolder: boolean,
): Omit<UpsertableFileRow, "userEmail"> {
  return {
    id: f.id,
    name: f.name as string,
    mimeType: f.mimeType as string,
    // exactOptionalPropertyTypes: omit `parents` entirely when absent — an
    // explicit undefined assignment is illegal for `parents?: readonly string[]`.
    ...(f.parents !== undefined ? { parents: f.parents } : {}),
    size: toSize(f.size),
    modifiedTime: f.modifiedTime,
    trashed: false,
    isFolder,
  };
}

// Guard for files missing a usable `id`. Drive can theoretically omit `id`
// on a file resource; filtering before map/bulkPut keeps one malformed file
// from failing an entire full-sync page, since Dexie bulkPut aborts its
// whole transaction on an invalid primary key. Doubles as a type guard so
// callers get a narrowed `DriveFile & { id: string }` after the check.
export function isValidDriveFile(
  f: DriveFile,
): f is DriveFile & { id: string } {
  return typeof f.id === "string" && f.id.length > 0;
}

// Partitions a page of Drive files into the subset that can be persisted
// (has a usable id) and a count of silently-unpersistable ones. Callers log a
// single summary line when skippedCount > 0 so missing-id files are never
// dropped without a trace (AGENTS.md Luật 4 — no silent error swallowing).
export function partitionValidFiles(files: DriveFile[]): {
  valid: Array<DriveFile & { id: string }>;
  skippedCount: number;
} {
  let skippedCount = 0;
  const valid: Array<DriveFile & { id: string }> = [];
  for (const f of files) {
    if (isValidDriveFile(f)) valid.push(f);
    else skippedCount += 1;
  }
  return { valid, skippedCount };
}

// Post-guard shape: id/name/mimeType are all proven usable, so a caller may
// classify (`mimeType === FOLDER_MIME`) and name-test without a cast.
export type ClassifiableDriveFile = DriveFile & {
  id: string;
  name: string;
  mimeType: string;
};

// Classification precondition, mirroring the delta-sync guards
// (`deltaSync.ts` name + mime checks) — the same two fields drive every
// classification decision (folder? playable? unsupported?).
//
// Full sync needs it because classification is a WRITE decision there:
// `mimeType === FOLDER_MIME` defaults a blank/absent type to `isFolder:false`,
// and the completion sweep then deletes that row as unsupported media — which
// takes its whole subtree out of root membership (search is fail-closed on
// orphans). A missing `name` additionally makes the sweep predicate itself
// throw, which the pass-wide catch turns into a silently skipped sweep.
//
// Deliberately SEPARATE from `isValidDriveFile`: that guard exists for the
// Dexie primary-key hazard and its id-only contract is pinned by tests.
export function isClassifiableDriveFile(
  f: DriveFile,
): f is ClassifiableDriveFile {
  return (
    isValidDriveFile(f) &&
    typeof f.name === "string" &&
    f.name.length > 0 &&
    typeof f.mimeType === "string" &&
    f.mimeType.trim().length > 0
  );
}

// Splits a page into rows that may be classified + persisted, files without a
// usable id (`skippedCount`, keeping the historical "missing id" meaning so
// full sync's existing skip log stays accurate), and id-valid files whose
// classification fields are unusable (`unclassifiable`).
//
// `unclassifiableIds` is the same bucket keyed by id, for callers that must
// exclude such files from a later sweep: a malformed/previously-mislabeled
// folder must never be deleted as unsupported media.
export function partitionClassifiableFiles(files: DriveFile[]): {
  valid: ClassifiableDriveFile[];
  skippedCount: number;
  unclassifiable: Array<DriveFile & { id: string }>;
  unclassifiableIds: Set<string>;
} {
  let skippedCount = 0;
  const valid: ClassifiableDriveFile[] = [];
  const unclassifiable: Array<DriveFile & { id: string }> = [];
  const unclassifiableIds = new Set<string>();
  for (const f of files) {
    if (!isValidDriveFile(f)) {
      skippedCount += 1;
      continue;
    }
    if (isClassifiableDriveFile(f)) {
      valid.push(f);
      continue;
    }
    unclassifiable.push(f);
    unclassifiableIds.add(f.id);
  }
  return { valid, skippedCount, unclassifiable, unclassifiableIds };
}
