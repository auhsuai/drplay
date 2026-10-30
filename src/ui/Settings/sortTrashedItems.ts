import { FOLDER_MIME } from "../../utils/driveApi";
import type { TrashedItem } from "./useTrashedFiles";

// Sort keys for the Trash list. The Date key covers the whole deleted-date
// fallback chain (deletedAt → trashedTime → modifiedTime), matching exactly
// what the rows display — the sort key can never disagree with the visible
// value.
export type TrashSortKey = "name" | "deletedAt" | "size";
export type TrashSortDirection = "asc" | "desc";

// Google Drive default directions: Name A→Z, Date newest-first, Size
// largest-first.
export const DEFAULT_TRASH_SORT_DIRECTION: Record<
  TrashSortKey,
  TrashSortDirection
> = {
  name: "asc",
  deletedAt: "desc",
  size: "desc",
};

// Numeric+base collator — same configuration as useDriveListing's SORT_COLLATOR
// so "Track 2" sorts before "Track 10" and case differences never reorder.
const TRASH_SORT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

// Same effective-date chain TrashItemRow renders. Malformed strings parse to
// NaN and are handled as missing by the caller.
const effectiveDeletedTime = (item: TrashedItem): number => {
  const raw = item.deletedAt ?? item.trashedTime ?? item.modifiedTime;
  if (raw === undefined) return Number.NaN;
  return new Date(raw).getTime();
};

export function sortTrashedItems(
  items: TrashedItem[],
  key: TrashSortKey,
  direction: TrashSortDirection,
): TrashedItem[] {
  // Copy-on-sort: the hook's state array is never mutated in place.
  return [...items].sort((a, b) => {
    // FOLDER-FIRST, mirroring sortDriveItems (useDriveListing.ts): folders
    // group before files, then each group sorts by the chosen key.
    if (a.mimeType === FOLDER_MIME && b.mimeType !== FOLDER_MIME) return -1;
    if (a.mimeType !== FOLDER_MIME && b.mimeType === FOLDER_MIME) return 1;

    // Tie-break every key with the name collator so equal keys keep a
    // deterministic order without relying on Array.sort stability alone.
    const nameTieBreak = () => TRASH_SORT_COLLATOR.compare(a.name, b.name);

    switch (key) {
      case "name": {
        return direction === "asc"
          ? TRASH_SORT_COLLATOR.compare(a.name, b.name)
          : TRASH_SORT_COLLATOR.compare(b.name, a.name);
      }
      case "deletedAt": {
        const timeA = effectiveDeletedTime(a);
        const timeB = effectiveDeletedTime(b);
        // Missing/malformed dates go to the END in both directions. NaN is
        // never equal to anything, so explicit isNaN checks.
        const aMissing = Number.isNaN(timeA);
        const bMissing = Number.isNaN(timeB);
        if (aMissing && bMissing) return nameTieBreak();
        if (aMissing) return 1;
        if (bMissing) return -1;
        if (timeA !== timeB) {
          return direction === "asc" ? timeA - timeB : timeB - timeA;
        }
        return nameTieBreak();
      }
      case "size": {
        const bytesA = Number(a.size);
        const validA =
          a.size !== undefined && a.size !== "" && Number.isFinite(bytesA);
        const bytesB = Number(b.size);
        const validB =
          b.size !== undefined && b.size !== "" && Number.isFinite(bytesB);
        // Missing/malformed sizes (folders, absent int64, garbage) go to the
        // END in both directions.
        if (!validA && !validB) return nameTieBreak();
        if (!validA) return 1;
        if (!validB) return -1;
        if (bytesA !== bytesB) {
          return direction === "asc" ? bytesA - bytesB : bytesB - bytesA;
        }
        return nameTieBreak();
      }
    }
  });
}
