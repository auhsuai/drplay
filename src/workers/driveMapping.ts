import type { DriveFile as DriveFileRow } from "../db/db";
import { ROOT_FOLDER_ID } from "../utils/driveConstants";

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

// Shared mapping of a Google Drive file resource to the DB row shape used by
// both full-sync and delta-sync. isFolder is a parameter so callers that
// already computed it (delta-sync) don't recompute it. The parameter type is
// the post-guard shape (id guaranteed by isValidDriveFile); name/mimeType are
// guaranteed by the Drive fields= query, hence the explicit `as string`
// (mirrors the previous non-null assertions with identical runtime semantics).
export function toDriveFileRow(
  f: DriveFile & { id: string },
  isFolder: boolean,
): DriveFileRow {
  return {
    id: f.id,
    name: f.name as string,
    mimeType: f.mimeType as string,
    parentId:
      f.parents && f.parents.length > 0
        ? (f.parents[0] ?? ROOT_FOLDER_ID)
        : ROOT_FOLDER_ID,
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
