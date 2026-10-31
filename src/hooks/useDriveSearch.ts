import { useState, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DriveItem } from "../types";
import { useSearchWorker } from "./useSearchWorker";
import type { SearchHit } from "../search/searchEngine";
import { useDriveStore } from "../store/driveStore";

const GLOBAL_SEARCH_LIMIT = 500;
const SEARCH_RESULT_LABEL = "Search Result";

// Search mode + sort model (I2). Sort string mapping (FileListHeader ↔ model,
// pinned for Phase B): "relevance" ↔ {relevance}; "name" ↔ {name, asc};
// "name desc" ↔ {name, desc}; "modifiedTime" ↔ {modifiedTime, asc};
// "modifiedTime desc" ↔ {modifiedTime, desc}; "size" ↔ {size, asc};
// "size desc" ↔ {size, desc}.
export type SearchMode = "global" | "recursive";
export interface SearchSort {
  field: "relevance" | "name" | "modifiedTime" | "size";
  dir: "asc" | "desc";
}

const DEFAULT_SORT: SearchSort = { field: "relevance", dir: "desc" };

// Maps a worker SearchHit to the DriveItem shape the listing uses. The engine
// already resolved the display title (real metadata title when present, else
// filename minus extension; folders keep their full name) and artist (null
// when no real metadata exists) — this layer only adapts those into the Track
// contract. Module-level because the mapping is pure; keeps the hook body
// small.
function mapSearchHitToDriveItem(hit: SearchHit): DriveItem {
  return {
    id: hit.id,
    title: hit.title,
    isFolder: hit.isFolder,
    size: hit.size,
    modifiedTime: hit.modifiedTime,
    // Top-level parent (NOT in trackInfo): folder hits must keep
    // trackInfo === undefined, but navigation still needs the real parent to
    // tell a same-folder drill-down from a cross-branch search jump.
    parentId: hit.parentId,
    trackInfo: hit.isFolder
      ? undefined
      : {
          id: hit.id,
          title: hit.title,
          artist: hit.artist ?? "",
          streamUrl: "",
          size: hit.size,
          originalName: hit.name,
          parentId: hit.parentId,
          parentName: SEARCH_RESULT_LABEL,
        },
  };
}

export function useDriveSearch(currentFolderId?: string): {
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  globalSearchItems: DriveItem[];
  searchMode: SearchMode;
  setSearchMode: (mode: SearchMode) => void;
  searchSort: SearchSort;
  setSearchSort: (sort: SearchSort) => void;
} {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("global");
  const [searchSort, setSearchSort] = useState<SearchSort>(DEFAULT_SORT);

  // The configured roots live in the store (set by useDriveInit /
  // useDriveRootSelector). Read at render so a root change re-renders and the
  // context below carries the fresh ids on the next query frame.
  const rootFolders = useDriveStore((state) => state.rootFolders);
  const rootIds = useMemo(() => rootFolders.map((r) => r.id), [rootFolders]);

  // NO reset on query change (user feedback 2026-10-31, replaces the old I2
  // reset rule): clearing the query only clears the RESULTS — mode AND sort
  // both survive and are re-applied on the next non-empty query. Each lives
  // for the hook's mount lifetime and changes ONLY through explicit user
  // clicks (icon toggle / header columns).

  // Query context: recursive mode narrows to the open folder's subtree; at
  // the virtual root (or without a folder) it degrades to the global root
  // scope. The worker/engine treat VIRTUAL_ROOT_ID as global.
  const context = useMemo(
    () => ({
      mode: searchMode,
      rootIds,
      ...(currentFolderId !== undefined ? { currentFolderId } : {}),
      sortField: searchSort.field,
      sortDir: searchSort.dir,
    }),
    [searchMode, rootIds, currentFolderId, searchSort],
  );

  // Global search: results come from the worker-backed search engine, and
  // query dispatch is debounced. Hits are exposed only while they belong to
  // the current search identity AND lifecycle epoch, so any change to query,
  // scope, account or sorting hides the previous lifecycle's results in the
  // same render instead of keeping them visible while the next request runs.
  // Empty queries never reach the worker (return []), so the normal Drive
  // listing below wins.
  const { hits } = useSearchWorker(searchQuery, GLOBAL_SEARCH_LIMIT, context);

  // The engine sorts (folders-first + field/dir) BEFORE slicing to the
  // limit, so the hook maps hits in order — no hook-level re-sort (B3.5:
  // the old folders-first/score sort here was the single sort point, now
  // moved into the engine).
  const globalSearchItems = useMemo(() => {
    if (searchQuery.trim() === "") return [];
    return hits.map(mapSearchHitToDriveItem);
  }, [hits, searchQuery]);

  return {
    searchQuery,
    setSearchQuery,
    globalSearchItems,
    searchMode,
    setSearchMode,
    searchSort,
    setSearchSort,
  };
}
