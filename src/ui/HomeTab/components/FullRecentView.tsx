import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import type { Track } from "../../../types";
import type { DriveItem } from "../../../types";
import { useTranslation } from "react-i18next";
import { prefetchVisibleTracks } from "../../../utils/streamPrefetcher";
import { ArrowLeft, Search, X } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SongCard } from "../../MainContent/components/SongCard";
import { FileListHeader } from "../../MainContent/components/FileListHeader";
import { matchesNormalized } from "../../../search/searchEngine";
import {
  recentDisplayName,
  toPlaybackTrack,
  type RecentItem,
} from "../recentView";

// Date column follows the My Drive convention (FileListHeader): desc =
// newest-first, so the default "recent" order opens the Date column active.
const DEFAULT_SORT_OPTION = "modifiedTime desc";

function compareSizeAsc(a: Track, b: Track): number {
  const sizeA = a.size;
  const sizeB = b.size;
  // Why: tracks without a size are pinned to the bottom in both directions,
  // and pairs without a size keep their relative (filter) order.
  if (sizeA === undefined && sizeB === undefined) return 0;
  if (sizeA === undefined) return 1;
  if (sizeB === undefined) return -1;
  return sizeA - sizeB;
}

function compareSizeDesc(a: Track, b: Track): number {
  const sizeA = a.size;
  const sizeB = b.size;
  if (sizeA === undefined && sizeB === undefined) return 0;
  if (sizeA === undefined) return 1;
  if (sizeB === undefined) return -1;
  return sizeB - sizeA;
}

export function sortRecentTracks(
  items: RecentItem[],
  sortOption: string,
): RecentItem[] {
  const result = [...items];
  // Why: the date columns must follow the My Drive convention (FileListHeader
  // + aria-sort): "modifiedTime desc" = newest-first, "modifiedTime" =
  // oldest-first. Recency proxy when NO track carries a real viewDate: the
  // input array position — the Recent Files source (getRecentlyPlayedWithDates)
  // already returns tracks newest-first, so desc = array order, asc = reverse.
  const indexByTrack = new Map<RecentItem, number>();
  result.forEach((track, index) => indexByTrack.set(track, index));
  // "Has a real date" = a finite epoch-ms number. NaN (an invalid parsed
  // modifiedTime) counts as date-less — it must not trigger the recency
  // proxy, which would reorder date-less tracks around it.
  const hasValidDate = (track: RecentItem): boolean =>
    typeof track.viewDate === "number" && Number.isFinite(track.viewDate);
  const hasAnyDate = result.some(hasValidDate);
  // Direction-aware date comparator: dir=1 → oldest-first (asc), dir=-1 →
  // newest-first (desc). Tracks without a date (or with an invalid one) are
  // pinned to the bottom in BOTH directions (the pin must NOT flip with the
  // direction, so the direction multiplies only the date delta — arg-flipping
  // the whole comparator would float date-less tracks to the top on desc).
  const byViewDateDir = (dir: 1 | -1) => (a: RecentItem, b: RecentItem) => {
    const aValid = hasValidDate(a);
    const bValid = hasValidDate(b);
    // Date-less/invalid pairs (and equal dates) keep their relative (filter)
    // order.
    if (!aValid && !bValid) return 0;
    if (!aValid) return 1;
    if (!bValid) return -1;
    return ((a.viewDate as number) - (b.viewDate as number)) * dir;
  };
  // Recency proxy over the array order: 0 = oldest … N-1 = newest.
  const byRecencyAsc = (a: RecentItem, b: RecentItem) =>
    (indexByTrack.get(a) ?? 0) - (indexByTrack.get(b) ?? 0);

  switch (sortOption) {
    case "name":
      // Sort by the displayed filename (originalName ?? title), not the ID3
      // title — what the user reads in the row is what must order the list.
      result.sort((a, b) =>
        recentDisplayName(a).localeCompare(recentDisplayName(b)),
      );
      break;
    case "name desc":
      result.sort((a, b) =>
        recentDisplayName(b).localeCompare(recentDisplayName(a)),
      );
      break;
    case "size":
      result.sort(compareSizeAsc);
      break;
    case "size desc":
      result.sort(compareSizeDesc);
      break;
    case "modifiedTime":
      if (hasAnyDate) {
        result.sort(byViewDateDir(1));
      } else {
        // No real dates anywhere: recency proxy, oldest-first = reverse of
        // the array's newest-first order.
        result.sort((a, b) => byRecencyAsc(b, a));
      }
      break;
    case "modifiedTime desc":
      if (hasAnyDate) {
        result.sort(byViewDateDir(-1));
      } else {
        // No real dates anywhere: recency proxy, newest-first = the array's
        // own order (the Recent Files source returns newest-first).
        result.sort(byRecencyAsc);
      }
      break;
    default:
      // Unknown/legacy option (e.g. 'recent') keeps the recency order —
      // newest first, matching the default recent list.
      result.sort(byRecencyAsc);
      break;
  }
  return result;
}

// Only finite epoch-ms values reach the ISO transport — NaN/Infinity would
// make toISOString throw (RangeError) and crash the whole view render.
function toModifiedTimeIso(viewDate: number | undefined): string | undefined {
  if (typeof viewDate !== "number" || !Number.isFinite(viewDate)) {
    return undefined;
  }
  const date = new Date(viewDate);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function FullRecentView({
  recent,
  onBack,
  onPlay,
  token,
  currentTrack,
  title,
}: {
  recent: RecentItem[];
  onBack: () => void;
  onPlay: (track: Track, ctx?: Track[]) => void;
  token: string | null;
  currentTrack?: Track | null | undefined;
  title?: string;
}) {
  const { t } = useTranslation();
  // Why: the header label is shared with HomeTab's "Recent Files" section; the
  // Recently Added view reuses this component and overrides it via the title
  // prop. Undefined title falls back to the translated Recent Files label.
  const resolvedTitle = title ?? t("home.recent_files");
  // Date column label per view: Recent Files shows the last-played timestamp
  // (createdAt), Recently Added shows the file's modifiedTime — the shared
  // FileListHeader label "Date modified" would lie on the play-recency view.
  const isRecentlyAdded = title !== undefined;
  const dateColumnLabel = isRecentlyAdded
    ? t("drive.col_date_modified")
    : t("recent.col_last_played");
  const parentRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Default = Date desc (newest-first), matching the pre-header dropdown's
  // default recency display order under the unified desc-first convention.
  const [sortOption, setSortOption] = useState(DEFAULT_SORT_OPTION);
  // Why: deleting from the MoreMenu removes the Drive file and fires
  // onRemoveItem, but the parent (HomeTab) only refetches on 'recent-updated'
  // (dispatched by history.recordPlay), so the deleted track must be removed
  // from this view's list locally or it would linger until the next play.
  const [removedIds, setRemovedIds] = useState<string[]>([]);

  const handleRemoveTrack = useCallback((id: string) => {
    setRemovedIds((prev) => [...prev, id]);
  }, []);

  useEffect(() => {
    if (recent.length > 0) prefetchVisibleTracks(recent);
  }, [recent]);

  const filteredItems = useMemo(() => {
    // Why: search filters first, then sort runs over the filtered subset so
    // the two never interfere (e.g. "size" cannot re-introduce filtered-out
    // tracks, and "modifiedTime" still sees a monotonic recency order).
    // matchesNormalized is diacritics-insensitive ("noi" finds "Nỗi buồn")
    // but returns false for an empty query by contract, so guard the old
    // "empty query → unfiltered recent" behavior explicitly.
    const searchActive = searchQuery.trim() !== "";
    const filtered = recent
      .filter((item) => !removedIds.includes(item.id))
      .filter(
        (item) =>
          !searchActive ||
          matchesNormalized(recentDisplayName(item), searchQuery),
      );
    return sortRecentTracks(filtered, sortOption);
  }, [recent, searchQuery, sortOption, removedIds]);

  // Latest-ref pattern (mirrors MainContent's handlePlay, P2-03-1): SongCard's
  // memo comparator deliberately ignores callback props, so a mounted card
  // keeps the callback from its last render. Keeping the handler identity
  // stable (deps []) and reading filteredItems/onPlay through a ref updated on
  // every commit means the queue is built from the CURRENT list at click time
  // instead of a stale closure snapshot (search/sort/delete churn re-creates
  // filteredItems without re-rendering the already-mounted cards).
  const playContextRef = useRef({ filteredItems, onPlay });
  useEffect(() => {
    playContextRef.current = { filteredItems, onPlay };
  });
  const handleCardPlay = useCallback((track: Track) => {
    const { filteredItems: currentItems, onPlay: play } =
      playContextRef.current;
    // Playback boundary: strip the view-only viewDate from BOTH the selected
    // track and every queue item — all Recent playback paths funnel through
    // here, so the timestamp can never leak into the persisted queue or the
    // verbatim recentTracks/playCounts rows.
    play(toPlaybackTrack(track), currentItems.map(toPlaybackTrack));
  }, []);

  // eslint-disable-next-line react-hooks/incompatible-library -- the react-hooks compiler cannot analyze @tanstack/react-virtual's internals; the options object is a plain data bag and the hook result is used normally below.
  const rowVirtualizer = useVirtualizer({
    count: filteredItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 92,
    overscan: 3,
  });

  return (
    <main className="flex-1 bg-white dark:bg-[#121212] overflow-hidden flex flex-col relative transition-colors duration-300 h-full">
      <div
        data-view-header
        className="sticky top-0 px-8 pt-8 pb-4 shrink-0 z-20 bg-white/95 dark:bg-[#121212]/95 backdrop-blur-md shadow-[0_4px_20px_rgba(0,0,0,0.02)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.1)]"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <button
              onClick={onBack}
              aria-label={t("common.back")}
              className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors mr-2 shrink-0"
            >
              <ArrowLeft className="w-5 h-5 text-gray-700 dark:text-gray-300" />
            </button>
            <div className="flex items-center gap-3">
              <span
                className="text-gray-900 dark:text-white px-2 py-1 font-semibold truncate max-w-[200px]"
                title={resolvedTitle}
              >
                {resolvedTitle}
              </span>
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-[#202124] px-2.5 py-0.5 rounded-full">
                {filteredItems.length}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {/* Search Input */}
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder={t("search_placeholder")}
                aria-label={t("search_placeholder")}
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                }}
                className="w-40 sm:w-56 pl-9 pr-3 py-1.5 text-sm font-medium bg-gray-100 dark:bg-[#1a1b1e] text-gray-900 dark:text-gray-100 rounded-lg outline-none focus:ring-2 focus:ring-brand-primary/50 border border-transparent focus:border-transparent transition-all placeholder:text-gray-400"
              />
              {searchQuery && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                  }}
                  aria-label={t("common.clear_search")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Sortable column header (same component as My Drive): one sorting
            entry point below the toolbar, still inside this sticky
            data-view-header (no second sticky layer). dateLabel only relabels
            the Date column — sort semantics stay My Drive-compatible. */}
        <FileListHeader
          sortOption={sortOption}
          onSortChange={setSortOption}
          dateLabel={dateColumnLabel}
        />
      </div>

      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto px-8 pt-4 pb-24 min-h-0 custom-scrollbar"
      >
        {filteredItems.length === 0 ? (
          <div className="text-gray-500 py-10 text-center">
            {searchQuery.trim() !== ""
              ? t("drive.no_search_results")
              : t("drive.no_audio")}
          </div>
        ) : (
          <div
            className="flex flex-col relative w-full"
            style={{ height: `${String(rowVirtualizer.getTotalSize())}px` }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const track = filteredItems[virtualRow.index];
              if (track === undefined) return null;
              const driveItem: DriveItem = {
                id: track.id,
                title: track.title,
                isFolder: false,
                size: track.size,
                trackInfo: track,
                // Internal transport only: SongCard's Date cell renders
                // formatModifiedDate(item.modifiedTime), so the viewDate
                // (last-played for Recent Files, file mtime for Recently
                // Added) rides the same field to reach the cell.
                modifiedTime: toModifiedTimeIso(track.viewDate),
              };
              return (
                <div
                  key={virtualRow.key}
                  style={{
                    position: "absolute",
                    left: 0,
                    width: "100%",
                    height: `${String(virtualRow.size)}px`,
                    transform: `translateY(${String(virtualRow.start)}px)`,
                  }}
                  className="pb-2"
                >
                  <SongCard
                    item={driveItem}
                    onPlay={handleCardPlay}
                    onOpenFolder={() => {}}
                    token={token}
                    currentFolderId="recent"
                    currentFolderName="Recent"
                    folderHistory={[]}
                    onRefresh={() => {}}
                    onRemoveItem={handleRemoveTrack}
                    menuVariant="recent"
                    isPlaying={!!currentTrack && track.id === currentTrack.id}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
