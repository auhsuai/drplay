import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import type { Track } from "../../../App";
import type { DriveItem } from "../../../types";
import { useTranslation } from "react-i18next";
import { prefetchVisibleTracks } from "../../../utils/streamPrefetcher";
import { ArrowLeft, Search, X } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SongCard } from "../../MainContent/components/SongCard";
import { SortDropdown } from "../../components/SortDropdown";

const DEFAULT_SORT_OPTION = "modifiedTime";

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

export function sortRecentTracks(items: Track[], sortOption: string): Track[] {
  const result = [...items];
  // Why: Track has no modifiedTime field, so recency is derived from the
  // original array position — getRecentlyPlayed already returns tracks
  // newest-first (createdAt desc), and filter() preserves relative order,
  // so the filtered index is a valid "date" proxy.
  const indexByTrack = new Map<Track, number>();
  result.forEach((track, index) => indexByTrack.set(track, index));
  const byRecency = (a: Track, b: Track) =>
    (indexByTrack.get(a) ?? 0) - (indexByTrack.get(b) ?? 0);

  switch (sortOption) {
    case "name":
      result.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "name desc":
      result.sort((a, b) => b.title.localeCompare(a.title));
      break;
    case "size":
      result.sort(compareSizeAsc);
      break;
    case "size desc":
      result.sort(compareSizeDesc);
      break;
    case "modifiedTime desc":
      result.sort((a, b) => byRecency(b, a));
      break;
    default:
      // 'modifiedTime' and any unknown/legacy option (e.g. 'recent') keep
      // the recency order — newest first, matching the default recent list.
      result.sort(byRecency);
      break;
  }
  return result;
}

export function FullRecentView({
  recent,
  onBack,
  onPlay,
  token,
  currentTrack,
  title,
}: {
  recent: Track[];
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
  const parentRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Why: the default "recent" order (newest first) maps to the Ngày option
  // without the desc suffix — sortRecentTracks keeps the array order for
  // 'modifiedTime' and reverses it for 'modifiedTime desc'.
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
    const ids = recent.map((t) => t.id).filter(Boolean);
    if (ids.length > 0) prefetchVisibleTracks(ids);
  }, [recent]);

  const filteredItems = useMemo(() => {
    // Why: search filters first, then sort runs over the filtered subset so
    // the two never interfere (e.g. "size" cannot re-introduce filtered-out
    // tracks, and "modifiedTime" still sees a monotonic recency order).
    const filtered = recent
      .filter((item) => !removedIds.includes(item.id))
      .filter((item) =>
        item.title.toLowerCase().includes(searchQuery.toLowerCase()),
      );
    return sortRecentTracks(filtered, sortOption);
  }, [recent, searchQuery, sortOption, removedIds]);

  const sortOptions = [
    { id: "name", label: t("sort.name") },
    { id: "modifiedTime", label: t("sort.date") },
    { id: "size", label: t("sort.size") },
  ];

  // eslint-disable-next-line react-hooks/incompatible-library -- the react-hooks compiler cannot analyze @tanstack/react-virtual's internals; the options object is a plain data bag and the hook result is used normally below.
  const rowVirtualizer = useVirtualizer({
    count: filteredItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 92,
    overscan: 3,
  });

  return (
    <main className="flex-1 bg-white dark:bg-[#121212] overflow-hidden flex flex-col relative transition-colors duration-300 h-full">
      <div className="sticky top-0 px-8 pt-8 pb-4 shrink-0 z-20 bg-white/95 dark:bg-[#121212]/95 backdrop-blur-md shadow-[0_4px_20px_rgba(0,0,0,0.02)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.1)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <button
              onClick={onBack}
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
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                }}
                className="w-40 sm:w-56 pl-9 pr-3 py-1.5 text-sm font-medium bg-gray-100 dark:bg-[#1a1b1e] text-gray-900 dark:text-gray-100 rounded-lg outline-none focus:ring-2 focus:ring-[#4285F4]/50 border border-transparent focus:border-transparent transition-all placeholder:text-gray-400"
              />
              {searchQuery && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Sort Dropdown */}
            <SortDropdown
              sortOption={sortOption}
              onSortChange={setSortOption}
              options={sortOptions}
              fallbackLabel={t("sort.sort_label")}
            />
          </div>
        </div>
      </div>

      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto px-8 pt-4 pb-24 min-h-0 custom-scrollbar"
      >
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
                  onPlay={(t) => {
                    onPlay(t, filteredItems);
                  }}
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
      </div>
    </main>
  );
}
