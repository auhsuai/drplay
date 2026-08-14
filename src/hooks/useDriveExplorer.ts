import { useState, useMemo } from "react";
import { useDriveListing } from "./useDriveListing";
import { useDriveOnDemandFetch } from "./useDriveOnDemandFetch";
import { useDriveSearch } from "./useDriveSearch";
import { useDriveBulkOps } from "./useDriveBulkOps";
import { IS_MOBILE } from "../utils/platform";

// Mobile (Task 14): every list renders through @tanstack/react-virtual with
// NO pagination UX, so one "page" spans the entire list. MAX_SAFE_INTEGER
// keeps every consumer of this constant correct with zero extra code:
//   - totalPages = ceil(len / ITEMS_PER_PAGE) = 1 → PaginationControls hides
//     itself (it also gates on IS_MOBILE directly)
//   - currentItems slice covers the whole list → the virtualizer owns
//     rendering, no load-more/paging for the user
//   - MainContent's highlight math (floor(idx / ITEMS_PER_PAGE) + 1) resolves
//     to page 1 and scrollToIndex(idx % ITEMS_PER_PAGE) to the TRUE index
// Desktop keeps the historical 50-item page contract unchanged.
export const ITEMS_PER_PAGE = IS_MOBILE ? Number.MAX_SAFE_INTEGER : 50;

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
  const [currentPage, setCurrentPage] = useState(1);

  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { searchQuery, setSearchQuery, globalSearchItems } = useDriveSearch();
  const { items } = useDriveListing({
    currentFolderId,
    currentFolderName,
    sortOption,
  });
  useDriveOnDemandFetch({ currentFolderId, token });
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
    onRemoveItem,
    onRefresh,
    setSelectedIds,
    setIsSelectionMode,
  });

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

  // Whitespace-only queries count as empty: the worker answers [] for them,
  // and the listing must stay visible (matches the old full-list behavior for
  // a " " query, whose token list was empty and matched everything).
  const filteredItems = searchQuery.trim() !== "" ? globalSearchItems : items;
  const totalPages = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);

  const currentItems = useMemo(
    () =>
      filteredItems.slice(
        (currentPage - 1) * ITEMS_PER_PAGE,
        currentPage * ITEMS_PER_PAGE,
      ),
    [filteredItems, currentPage],
  );

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
