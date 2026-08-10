import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { DriveItem } from "../types";
import type { DriveFile } from "../db/db";
import { db } from "../db/db";
import {
  getUploadState,
  subscribe as subscribeUploads,
} from "../utils/uploadManager";
import { useLiveQuery } from "dexie-react-hooks";
import { metadataCache } from "../utils/metadata";

// Module-level so the items useMemo sort (re-run on every dbFiles change or
// uploadStatusVersion bump) never re-initializes the collator — locale data
// load has real cost and sorting is a hot path.
const SORT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

// Monotonic upload-status version: bumped on every uploadManager notify so the
// explorer re-runs the pin partition below with fresh getUploadState()
// verdicts (a started upload pins immediately, a finished one unpins).
// Module-level (same pattern as MainContent's VirtualizedSongList) so a
// remounted view still starts from the latest version — useSyncExternalStore
// re-reads the snapshot right after subscribing.
let uploadStatusVersion = 0;

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
    isFolder ? name : name.replace(/\.[^/.]+$/, "");

  // Re-render on every upload status change so the pin partition below re-runs
  // with fresh getUploadState() verdicts while an upload is in flight.
  // Stable subscribe identity: useSyncExternalStore re-subscribes every time a
  // different subscribe function is passed on a re-render (react.dev caveat),
  // so the uploadManager wrapper is memoized to keep the subscription stable.
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeUploads(() => {
        uploadStatusVersion += 1;
        onStoreChange();
      }),
    [],
  );

  useSyncExternalStore(subscribe, () => uploadStatusVersion);

  const dbFiles = useLiveQuery(() => {
    if (!currentFolderId) return Promise.resolve<DriveFile[]>([]);
    return db.files.where("parentId").equals(currentFolderId).toArray();
  }, [currentFolderId]);

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
        thumbnailLink: file.thumbnailLink,
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

    // Pin items with an active upload presentation state to the top of the
    // list while it lasts — a just-started upload must be visible in My Drive
    // even when its name would sort to page 2+. Order matters: 'uploaded'
    // (just-finished tint) ranks FIRST so the fresh check is immediately
    // visible, then 'uploading', then the normal sorted rest. A folder whose
    // child is uploading ('parent-uploading') already exists on Drive and must
    // keep its normal sorted position (spinner only, no dim).
    const uploadedItems: DriveItem[] = [];
    const uploadingItems: DriveItem[] = [];
    const restItems: DriveItem[] = [];
    for (const item of _items) {
      const state = getUploadState(item.id);
      if (state === "uploaded") {
        uploadedItems.push(item);
      } else if (state === "uploading") {
        uploadingItems.push(item);
      } else {
        restItems.push(item);
      }
    }

    const collator = SORT_COLLATOR;
    // metadataCache is typed Record<string, CachedMetadata> but is a sparse
    // module-level cache — index access can still be undefined at runtime.
    const cachedTitle = (id: string): string | undefined => {
      const meta = metadataCache[id];
      return meta?.title;
    };
    restItems.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;

      switch (sortOption) {
        case "name": {
          const titleA = cachedTitle(a.id) || a.title;
          const titleB = cachedTitle(b.id) || b.title;
          return collator.compare(titleA, titleB);
        }
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
        default: {
          const titleA = cachedTitle(a.id) || a.title;
          const titleB = cachedTitle(b.id) || b.title;
          return collator.compare(titleA, titleB);
        }
      }
    });

    // Uploading items keep their _items (dbFiles) order — pending rows are
    // inserted in upload enqueue order and the queue is strictly sequential,
    // so this mirrors the order uploads started, not the active sort option.
    // Uploaded items sit ahead of them (fresh tint must be the most visible).
    if (uploadedItems.length === 0 && uploadingItems.length === 0)
      return restItems;
    return [...uploadedItems, ...uploadingItems, ...restItems];
    // uploadStatusVersion IS load-bearing here: the memo must re-run when a
    // started/finished upload changes the pin partition — the re-render that
    // makes that visible is triggered by useSyncExternalStore, which the rule
    // cannot see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbFiles, sortOption, currentFolderName, uploadStatusVersion]);

  return { items, dbFiles };
}
