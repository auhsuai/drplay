import { useState, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DriveItem } from "../types";
import { useSearchWorker } from "./useSearchWorker";
import type { SearchHit } from "../search/searchEngine";

const GLOBAL_SEARCH_LIMIT = 500;
const SEARCH_RESULT_LABEL = "Search Result";

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

export function useDriveSearch(): {
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  globalSearchItems: DriveItem[];
} {
  const [searchQuery, setSearchQuery] = useState("");

  // Global search: worker-backed relevance engine (Task 3 of the search
  // rebuild). The hook debounces the query and keeps last-good hits while one
  // is in flight; empty queries never reach the worker (return []), so the
  // normal listing below wins.
  const { hits } = useSearchWorker(searchQuery, GLOBAL_SEARCH_LIMIT);

  const globalSearchItems = useMemo(() => {
    if (searchQuery.trim() === "") return [];
    // Folders first (stable), then relevance (score) descending within each
    // group — deliberate replacement of the old alphabetical sort (plan Task
    // 3). A copy is sorted because MiniSearch returns a fresh array per query.
    const sortedHits = [...hits].sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return b.score - a.score;
    });
    return sortedHits.map(mapSearchHitToDriveItem);
  }, [hits, searchQuery]);

  return { searchQuery, setSearchQuery, globalSearchItems };
}
