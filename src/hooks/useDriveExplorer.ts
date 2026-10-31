import { useState, useMemo } from "react";
import { useDriveListing } from "./useDriveListing";
import { useDriveOnDemandFetch } from "./useDriveOnDemandFetch";
import { useDriveSearch } from "./useDriveSearch";
import { useDriveBulkOps } from "./useDriveBulkOps";
import { useDriveStore } from "../store/driveStore";
import { useAuthStore } from "../store/authStore";
import { getCurrentUserEmail } from "../utils/storageKeys";
import { VIRTUAL_ROOT_ID } from "../utils/driveConstants";

export const ITEMS_PER_PAGE = 50;

/**
 * Drive explorer logic for one folder view: keeps the local Dexie mirror warm
 * (on-demand Drive pagination when a folder has no cached rows), derives the
 * sorted item list, search (global name search over the local DB), pagination,
 * and the folder/bulk operations (create folder, bulk delete, bulk move).
 * One hook per open folder; pass the current folder + token so it re-fetches
 * on navigation.
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
  const [currentPage, setCurrentPage] = useState(1);

  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // The virtual root lists configured roots only: selection (and the bulk
  // operations it drives) has no valid target there. Enforce it at the state
  // source as well as in the UI; a stale TRUE from a previous folder must not
  // survive into the virtual view (render-time adjustment, same React 19
  // pattern as the reset block below — no effect loop).
  const isVirtualRoot = currentFolderId === VIRTUAL_ROOT_ID;
  if (isVirtualRoot && (isSelectionMode || selectedIds.size > 0)) {
    setIsSelectionMode(false);
    setSelectedIds(new Set());
  }

  const {
    searchQuery,
    setSearchQuery,
    globalSearchItems,
    searchMode,
    setSearchMode,
    searchSort,
    setSearchSort,
  } = useDriveSearch(currentFolderId);
  const { items } = useDriveListing({
    currentFolderId,
    currentFolderName,
    sortOption,
  });
  useDriveOnDemandFetch({ currentFolderId, token });

  // Derived before the bulk-ops hook so it can validate the selection against
  // the CURRENT result set. Content-based on purpose: a new `items` array with
  // the same ids must not invalidate a selection during pagination.
  // Whitespace-only queries count as empty: the worker answers [] for them,
  // and the listing must stay visible (matches the old full-list behavior for
  // a " " query, whose token list was empty and matched everything).
  const filteredItems = searchQuery.trim() !== "" ? globalSearchItems : items;
  const validIds = useMemo(
    () => new Set(filteredItems.map((i) => i.id)),
    [filteredItems],
  );

  const {
    isCreatingFolder,
    isBulkOperating,
    handleCreateFolder,
    handleBulkDelete,
    handleBulkMove,
  } = useDriveBulkOps({
    token,
    currentFolderId,
    selectedIds,
    validIds,
    onRemoveItem,
    onRefresh,
    setSelectedIds,
    setIsSelectionMode,
  });

  // Reset page when anything that changes the RESULT SET changes — folder,
  // query, listing sort, search mode, configured roots, account or search
  // sort — and reset search on folder change. All fields are content-based
  // values (ids joined, field|dir), never object references, so an identical
  // re-render does not reset. Done during render (React 19 "adjusting state
  // when props change" pattern) instead of in an effect, which would cascade
  // renders.
  const rootFolders = useDriveStore((s) => s.rootFolders);
  const rootsKey = useMemo(
    () =>
      rootFolders
        .map((r) => r.id)
        .sort()
        .join("|"),
    [rootFolders],
  );
  // Reactive owner (same source as useSearchWorker): the auth store is live,
  // localStorage is only the pre-hydration fallback.
  const storeEmail = useAuthStore((s) => s.userProfile?.email ?? "");
  const accountEmail = storeEmail !== "" ? storeEmail : getCurrentUserEmail();
  const searchSortKey = `${searchSort.field}|${searchSort.dir}`;

  const [prevResetKey, setPrevResetKey] = useState<{
    folder: string;
    search: string;
    sort: string;
    mode: string;
    roots: string;
    account: string;
    searchSort: string;
  }>({
    folder: currentFolderId,
    search: searchQuery,
    sort: sortOption,
    mode: searchMode,
    roots: rootsKey,
    account: accountEmail,
    searchSort: searchSortKey,
  });
  if (
    prevResetKey.folder !== currentFolderId ||
    prevResetKey.search !== searchQuery ||
    prevResetKey.sort !== sortOption ||
    prevResetKey.mode !== searchMode ||
    prevResetKey.roots !== rootsKey ||
    prevResetKey.account !== accountEmail ||
    prevResetKey.searchSort !== searchSortKey
  ) {
    setPrevResetKey({
      folder: currentFolderId,
      search: searchQuery,
      sort: sortOption,
      mode: searchMode,
      roots: rootsKey,
      account: accountEmail,
      searchSort: searchSortKey,
    });
    if (prevResetKey.folder !== currentFolderId) {
      setSearchQuery("");
    }
    setCurrentPage(1);
    // Selection is scoped to the result set that produced it: bulk ops run on
    // raw selectedIds, so a stale set surviving a scope change would
    // delete/move items that are no longer visible. Clear it on every reset
    // trigger, same key as the page reset. Preferences (searchMode,
    // searchSort, sortOption) are deliberately NOT reset — only the selection
    // and the page position are.
    setSelectedIds(new Set());
    setIsSelectionMode(false);
  }

  const totalPages = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);

  // Clamp when the list shrinks below the current page (e.g. bulk delete
  // wiped the last page): currentPage > totalPages slices an empty window and
  // the view looks blank until the user paginates manually. Same render-time
  // adjustment pattern as the reset block above; the max(…, 1) floor parks an
  // emptied list on page 1. Mobile's single MAX_SAFE_INTEGER page makes this
  // a no-op there.
  const safeCurrentPage = Math.min(currentPage, Math.max(totalPages, 1));
  if (safeCurrentPage !== currentPage) {
    setCurrentPage(safeCurrentPage);
  }

  const currentItems = useMemo(
    () =>
      filteredItems.slice(
        (safeCurrentPage - 1) * ITEMS_PER_PAGE,
        safeCurrentPage * ITEMS_PER_PAGE,
      ),
    [filteredItems, safeCurrentPage],
  );

  return {
    isVirtualRoot,
    searchQuery,
    setSearchQuery,
    // Search mode/sort re-export (I2) for MainContent/TopNavigationBar (Phase B).
    searchMode,
    setSearchMode,
    searchSort,
    setSearchSort,
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
