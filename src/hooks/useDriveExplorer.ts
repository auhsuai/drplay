import {
  useState,
  useMemo,
  useEffect,
  useSyncExternalStore,
  useCallback,
} from "react";
import type { DriveItem } from "../types";
import { useDebouncedLiveQuery } from "./useDebouncedLiveQuery";
import type { DriveFile } from "../db/db";
import { db } from "../db/db";
import { normalizeText } from "../utils/normalizeText";
import {
  deleteFile,
  moveFile,
  createFolder,
  driveFetch,
} from "../utils/driveApi";
import type { DriveFileItem } from "../utils/driveApi";
import {
  isUploading,
  getUploadState,
  subscribe as subscribeUploads,
} from "../utils/uploadManager";
import { showErrorToast } from "../utils/simpleToast";
import { t } from "i18next";
import { captureError } from "../utils/errorLog";

import { useLiveQuery } from "dexie-react-hooks";
import { metadataCache } from "../utils/metadata";
import { getFolderAudioQuery } from "../utils/audioQuery";
import { useDriveStore } from "../store/driveStore";
import type { DriveFilesListResponse } from "../utils/driveApi";

const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const ITEMS_PER_PAGE = 50;
const GLOBAL_SEARCH_LIMIT = 100;
const DRIVE_PAGE_SIZE = 1000;
// Module-level so the items useMemo sort (re-run on every dbFiles change or
// uploadStatusVersion bump) never re-initializes the collator — locale data
// load has real cost and sorting is a hot path.
const SORT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const DEBOUNCE_DELAY_MS = 150;
const SEARCH_RESULT_LABEL = "Search Result";

// Monotonic upload-status version: bumped on every uploadManager notify so the
// explorer re-runs the pin partition below with fresh getUploadState()
// verdicts (a started upload pins immediately, a finished one unpins).
// Module-level (same pattern as MainContent's VirtualizedSongList) so a
// remounted view still starts from the latest version — useSyncExternalStore
// re-reads the snapshot right after subscribing.
let uploadStatusVersion = 0;

// Bulk ops must never touch items that are still uploading (a pending row can
// not be deleted/moved — it has no Drive id yet). Excluded ids get a toast and
// the rest of the batch proceeds unchanged.
function filterUploading(ids: string[]): string[] {
  return ids.filter((id) => !isUploading(id));
}

/**
 * Drive explorer logic for one folder view: keeps the local Dexie mirror warm
 * (on-demand Drive pagination when a folder has no cached rows), derives the
 * sorted/pinned item list, search (global name search over the local DB),
 * pagination, and the folder/bulk operations (create folder, bulk delete,
 * bulk move) — with items still uploading excluded from bulk ops. One hook
 * per open folder; pass the current folder + token so it re-fetches on
 * navigation. Uploads pin to the top of the list while active and keep their
 * freshly-done green check visible via uploadManager state.
 * @param currentFolderId Drive id of the folder being explored.
 * @param currentFolderName Its display name (used for track parentName).
 * @param token Drive access token; null (signed out) disables network ops.
 * @param onRefresh Called after mutations so parent scopes can refresh their
 * own derived data.
 * @param onRemoveItem Optional per-item removal callback (e.g. player queue
 * eviction) fired for every id a bulk op removed.
 * @param sortOption Sort key for the listing ("name", "modifiedTime desc", …).
 * @returns Search/pagination state, the current page of items, selection
 * state, and the create/bulk handlers.
 */
export function useDriveExplorer(
  currentFolderId: string,
  currentFolderName: string,
  token: string | null,
  onRefresh: () => void,
  onRemoveItem?: (id: string) => void,
  sortOption: string = "name_natural",
) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  const stripExt = (name: string, isFolder: boolean) =>
    isFolder ? name : name.replace(/\.[^/.]+$/, "");

  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [isBulkOperating, setIsBulkOperating] = useState(false);

  // Reset page when folder, search, or sort changes — and reset search on
  // folder change. Done during render (React 19 "adjusting state when props
  // change" pattern) instead of in an effect, which would cascade renders.
  const [prevResetKey, setPrevResetKey] = useState<{
    folder: string;
    search: string;
    sort: string;
  }>({ folder: currentFolderId, search: searchQuery, sort: sortOption });
  if (
    prevResetKey.folder !== currentFolderId ||
    prevResetKey.search !== searchQuery ||
    prevResetKey.sort !== sortOption
  ) {
    setPrevResetKey({
      folder: currentFolderId,
      search: searchQuery,
      sort: sortOption,
    });
    if (prevResetKey.folder !== currentFolderId) {
      setSearchQuery("");
    }
    setCurrentPage(1);
  }

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

  // Global search data loading
  const globalSearchItemsRaw = useDebouncedLiveQuery(
    async () => {
      if (!searchQuery) return undefined;
      const query = normalizeText(searchQuery);
      const matches = await db.files
        .filter((f) => normalizeText(f.name).includes(query))
        .limit(GLOBAL_SEARCH_LIMIT)
        .toArray();
      return matches;
    },
    [searchQuery],
    DEBOUNCE_DELAY_MS,
  );

  const globalSearchItems = useMemo(() => {
    if (!globalSearchItemsRaw) return [];

    const mapped = globalSearchItemsRaw.map((file) => {
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
              parentName: SEARCH_RESULT_LABEL,
            },
      };
    });

    return mapped.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.title.localeCompare(b.title, undefined, { numeric: true });
    });
  }, [globalSearchItemsRaw]);

  const dbFiles = useLiveQuery(() => {
    if (!currentFolderId) return Promise.resolve<DriveFile[]>([]);
    return db.files.where("parentId").equals(currentFolderId).toArray();
  }, [currentFolderId]);

  const setIsLoadingTracks = useDriveStore((state) => state.setIsLoadingTracks);

  // On-Demand Fetching: Kéo nóng 1 trang từ Drive nếu thư mục chưa có trong Dexie
  useEffect(() => {
    if (!token || !currentFolderId || currentFolderId === "") return;

    // Nếu có dữ liệu rồi thì fetch ngầm (không hiện spinner)
    // Nếu chưa có (dbFiles undefined hoặc = 0), hiện spinner.
    let isMounted = true;
    const abortController = new AbortController();
    const stillMounted = () => isMounted;
    const isAborted = () => abortController.signal.aborted;

    const fetchOnDemand = async () => {
      try {
        const count = await db.files
          .where("parentId")
          .equals(currentFolderId)
          .count();
        if (count === 0) setIsLoadingTracks(true);

        const q = getFolderAudioQuery(currentFolderId);
        let hasMore = true;
        let pageToken: string | undefined = undefined;

        while (hasMore && isMounted && !abortController.signal.aborted) {
          const url = new URL("https://www.googleapis.com/drive/v3/files");
          url.searchParams.set("q", q);
          url.searchParams.set(
            "fields",
            "nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)",
          );
          url.searchParams.set("pageSize", String(DRIVE_PAGE_SIZE));
          if (pageToken) url.searchParams.set("pageToken", pageToken);

          // driveFetch owns the retry policy (driveApi resilience layer):
          // 429/5xx and 403 rate-limit are retried with exponential backoff,
          // honoring Retry-After when present; a caller abort propagates as an
          // immediate rejection (Google handle-errors guidance). A response
          // returned here is final — retried or non-retryable.
          const res = await driveFetch(url.toString(), {
            headers: { Authorization: `Bearer ${token}` },
            signal: abortController.signal,
          });
          if (isAborted()) break;

          if (!res.ok) {
            void captureError({
              level: "warn",
              source: "useDriveExplorer",
              message: `OnDemandFetch Drive API error: HTTP ${String(res.status)} (folder=${currentFolderId})`,
            });
            break;
          }
          const data = (await res.json()) as DriveFilesListResponse | null;
          if (isAborted()) break;

          // Write each page to Dexie immediately instead of accumulating all
          // pages in memory (mirrors proSync.worker.ts full-sync pattern).
          if (
            stillMounted() &&
            data &&
            Array.isArray(data.files) &&
            data.files.length > 0
          ) {
            const filesToInsert = data.files.map((f: DriveFileItem) => ({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              parentId: currentFolderId,
              size: f.size ? parseInt(f.size, 10) : undefined,
              modifiedTime: f.modifiedTime,
              trashed: false,
              isFolder: f.mimeType === GOOGLE_FOLDER_MIME,
            }));
            try {
              await db.files.bulkPut(filesToInsert);
            } catch (dbErr) {
              void captureError({
                level: "error",
                source: "useDriveExplorer",
                message: `OnDemandFetch Dexie bulkPut failed (folder=${currentFolderId}, count=${String(filesToInsert.length)}): ${String(dbErr)}`,
              });
              break;
            }
          }

          pageToken = data?.nextPageToken;
          if (!pageToken) hasMore = false;
        }
      } catch (err) {
        if (abortController.signal.aborted) return;
        if (err instanceof TypeError) {
          void captureError({
            level: "warn",
            source: "useDriveExplorer",
            message: `OnDemandFetch network error (folder=${currentFolderId}): ${err.message}`,
          });
        } else {
          void captureError({
            level: "error",
            source: "useDriveExplorer",
            message: `OnDemandFetch unexpected error (folder=${currentFolderId}): ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } finally {
        if (isMounted) setIsLoadingTracks(false);
      }
    };

    void fetchOnDemand();
    return () => {
      isMounted = false;
      abortController.abort();
    };
  }, [currentFolderId, token, setIsLoadingTracks]);

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

  const filteredItems = searchQuery ? globalSearchItems : items;
  const totalPages = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);

  const currentItems = useMemo(
    () =>
      filteredItems.slice(
        (currentPage - 1) * ITEMS_PER_PAGE,
        currentPage * ITEMS_PER_PAGE,
      ),
    [filteredItems, currentPage],
  );

  const handleCreateFolder = async (
    folderName: string,
    onComplete: () => void,
  ) => {
    if (!token) return;
    setIsCreatingFolder(true);
    try {
      const res = await createFolder(token, folderName, currentFolderId);
      if (res.id) {
        await db.files.put({
          id: res.id,
          name: res.name || folderName,
          parentId: currentFolderId,
          mimeType: GOOGLE_FOLDER_MIME,
          isFolder: true,
          trashed: false,
          modifiedTime: new Date().toISOString(),
        });
      }
      onRefresh();
      onComplete();
    } catch (e: unknown) {
      void captureError({
        level: "error",
        source: "useDriveExplorer",
        message: `create-folder failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("drive.create_folder_error"));
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const handleBulkDelete = async (onComplete: () => void) => {
    if (!token || selectedIds.size === 0) return;

    const itemsToDelete = filterUploading([...selectedIds]);
    if (itemsToDelete.length < selectedIds.size) {
      showErrorToast(t("upload.uploading_blocked"));
    }
    if (itemsToDelete.length === 0) return;

    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setIsBulkOperating(true);

    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    try {
      for (const id of itemsToDelete) {
        try {
          await deleteFile(token, id);
          deletedIds.push(id);
        } catch (e: unknown) {
          failedIds.push(id);
          void captureError({
            level: "error",
            source: "useDriveExplorer",
            message: `bulk-delete failed for item ${id}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      if (deletedIds.length > 0) {
        await db.files.bulkDelete(deletedIds);
        if (onRemoveItem)
          deletedIds.forEach((id) => {
            onRemoveItem(id);
          });
      }
      if (failedIds.length > 0) {
        showErrorToast(t("drive.delete_error"));
      }
    } catch (e: unknown) {
      void captureError({
        level: "error",
        source: "useDriveExplorer",
        message: `bulk-delete unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("drive.delete_error"));
    } finally {
      setIsBulkOperating(false);
      onComplete();
    }
  };

  const handleBulkMove = async (
    destinationFolderId: string,
    onComplete: () => void,
  ) => {
    if (!token || selectedIds.size === 0) return;

    const itemsToMove = filterUploading([...selectedIds]);
    if (itemsToMove.length < selectedIds.size) {
      showErrorToast(t("upload.uploading_blocked"));
    }
    if (itemsToMove.length === 0) return;

    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setIsBulkOperating(true);

    const movedIds: string[] = [];
    const failedIds: string[] = [];
    try {
      for (const id of itemsToMove) {
        try {
          await moveFile(token, id, currentFolderId, destinationFolderId);
          movedIds.push(id);
        } catch (e: unknown) {
          failedIds.push(id);
          void captureError({
            level: "error",
            source: "useDriveExplorer",
            message: `bulk-move failed for item ${id}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      // Single transaction for the whole batch (vs. one update() per item);
      // missing keys are skipped without throwing, same as update().
      await db.files.bulkUpdate(
        movedIds.map((id) => ({
          key: id,
          changes: { parentId: destinationFolderId },
        })),
      );
      if (onRemoveItem && movedIds.length > 0)
        movedIds.forEach((id) => {
          onRemoveItem(id);
        });
      if (failedIds.length > 0) {
        showErrorToast(t("drive.move_error"));
      }
    } catch (e: unknown) {
      void captureError({
        level: "error",
        source: "useDriveExplorer",
        message: `bulk-move unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("drive.move_error"));
    } finally {
      setIsBulkOperating(false);
      onComplete();
    }
  };

  return {
    searchQuery,
    setSearchQuery,
    currentPage,
    setCurrentPage,
    totalPages,
    currentItems,
    filteredItems,
    isSelectionMode,
    setIsSelectionMode,
    selectedIds,
    setSelectedIds,
    isCreatingFolder,
    isBulkOperating,
    handleCreateFolder,
    handleBulkDelete,
    handleBulkMove,
  };
}
