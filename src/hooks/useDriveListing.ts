import { useMemo } from "react";
import type { DriveItem } from "../types";
import type { DriveFile } from "../db/db";
import { db } from "../db/db";
import { useLiveQuery } from "dexie-react-hooks";
import { metadataCache } from "../utils/metadata";
import { stripAudioExtension } from "../utils/pathUtils";
import { getCurrentUserEmail } from "../utils/storageKeys";

// Module-level so the items useMemo sort (re-run on every dbFiles change)
// never re-initializes the collator — locale data load has real cost and
// sorting is a hot path.
const SORT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

// Map.get carries the true nullability (CachedMetadata | undefined) so the
// optional chain below is checked by the compiler instead of by comment.
const cachedTitle = (id: string): string | undefined =>
  metadataCache.get(id)?.title;

// Pure sort extracted from the listing memo so it is unit-testable and the
// sort memo only re-runs on [items, sortOption]. Comparator logic is frozen
// from the original switch — including the asymmetry that the name/default
// cases use cachedTitle(a.id) || a.title while the modifiedTime/size
// tie-breaks use the RAW title (a.title), which must NOT be "unified".
export function sortDriveItems(
  items: DriveItem[],
  sortOption: string,
  collator: Intl.Collator,
  cachedTitle: (id: string) => string | undefined,
): DriveItem[] {
  // Copy-on-sort: output order is identical to the original in-place
  // restItems.sort() but the input array is never mutated.
  return [...items].sort((a, b) => {
    if (a.isFolder && !b.isFolder) return -1;
    if (!a.isFolder && b.isFolder) return 1;

    switch (sortOption) {
      case "name desc": {
        const titleA = cachedTitle(a.id) || a.title;
        const titleB = cachedTitle(b.id) || b.title;
        return collator.compare(titleB, titleA);
      }
      case "modifiedTime": {
        const timeA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
        const timeB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
        if (timeA === timeB) return collator.compare(a.title, b.title);
        return timeA - timeB;
      }
      case "modifiedTime desc": {
        const timeA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
        const timeB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
        if (timeA === timeB) return collator.compare(a.title, b.title);
        return timeB - timeA;
      }
      case "size": {
        const diff = (a.size || 0) - (b.size || 0);
        if (diff === 0) return collator.compare(a.title, b.title);
        return diff;
      }
      case "size desc": {
        const diff = (b.size || 0) - (a.size || 0);
        if (diff === 0) return collator.compare(a.title, b.title);
        return diff;
      }
      // "name" + every unknown option (name_natural, …) — cached title wins.
      default: {
        const titleA = cachedTitle(a.id) || a.title;
        const titleB = cachedTitle(b.id) || b.title;
        return collator.compare(titleA, titleB);
      }
    }
  });
}

export function useDriveListing({
  currentFolderId,
  currentFolderName,
  sortOption,
}: {
  currentFolderId: string;
  currentFolderName: string;
  sortOption: string;
}): { items: DriveItem[]; dbFiles: DriveFile[] | undefined } {
  const stripExt = (name: string, isFolder: boolean) =>
    isFolder ? name : stripAudioExtension(name);

  const dbFiles = useLiveQuery(() => {
    if (!currentFolderId) return Promise.resolve<DriveFile[]>([]);
    // Per-user scoping (schema v10): only the signed-in account's rows.
    return db.files
      .where("[userEmail+parentId]")
      .equals([getCurrentUserEmail(), currentFolderId])
      .toArray();
  }, [currentFolderId]);

  // Items memo: maps rows to DriveItems; the O(n log n) sort runs below on
  // the same memo so a dbFiles change re-maps + re-sorts once.
  const items = useMemo(() => {
    if (!dbFiles) return [];
    const _items: DriveItem[] = dbFiles.map((file) => {
      const title = stripExt(file.name, file.isFolder);
      return {
        id: file.id,
        title,
        isFolder: file.isFolder,
        size: file.size,
        modifiedTime: file.modifiedTime,
        trackInfo: file.isFolder
          ? undefined
          : {
              id: file.id,
              title,
              artist: "",
              streamUrl: "",
              size: file.size,
              originalName: file.name,
              parentId: file.parentId,
              parentName: currentFolderName,
            },
      };
    });

    return sortDriveItems(_items, sortOption, SORT_COLLATOR, cachedTitle);
  }, [dbFiles, currentFolderName, sortOption]);

  return { items, dbFiles };
}
