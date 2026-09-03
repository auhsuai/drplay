import { useState, useMemo } from "react";
import { useDriveListing } from "./useDriveListing";
import { useDriveOnDemandFetch } from "./useDriveOnDemandFetch";
import { useDriveSearch } from "./useDriveSearch";
import { useDriveBulkOps } from "./useDriveBulkOps";

export const ITEMS_PER_PAGE = 50;

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
    // Selection is folder-scoped UI state: bulk ops run on raw selectedIds
    // with no per-folder validation, so a stale set surviving navigation would
    // delete/move folder A's files while the user views folder B. Clear it on
    // every reset trigger (folder/search/sort), same key as the page reset.
    setSelectedIds(new Set());
    setIsSelectionMode(false);
  }

  // Whitespace-only queries count as empty: the worker answers [] for them,
  // and the listing must stay visible (matches the old full-list behavior for
  // a " " query, whose token list was empty and matched everything).
  const filteredItems = searchQuery.trim() !== "" ? globalSearchItems : items;
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
