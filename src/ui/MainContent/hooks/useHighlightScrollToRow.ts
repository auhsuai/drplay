import { useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { DriveItem } from "../../../types";
import type { VirtualizedSongListHandle } from "../components/VirtualizedSongList";
import { ITEMS_PER_PAGE } from "../../../hooks/useDriveExplorer";
import { SCROLL_HIGHLIGHT_DELAY_MS } from "../utils/layoutMetrics";

export interface UseHighlightScrollToRowParams {
  highlightedFileId?:
    { id: string; ts: number; folderId: string } | null | undefined;
  filteredItems: DriveItem[];
  currentPage: number;
  setCurrentPage: Dispatch<SetStateAction<number>>;
  listRef: RefObject<VirtualizedSongListHandle | null>;
}

// Consume-once latch for highlight scrolling: the ts of the last locate we
// actually scrolled to. Data churn (upload ticks, search, Dexie writes)
// keeps re-creating filteredItems while the SAME highlight is active — the
// effect re-runs on every new identity but must not re-yank the viewport:
// one locate = one scroll.
export function useHighlightScrollToRow({
  highlightedFileId,
  filteredItems,
  currentPage,
  setCurrentPage,
  listRef,
}: UseHighlightScrollToRowParams): void {
  const lastScrolledTsRef = useRef<number | null>(null);

  // Handle highlight scrolling — consume-once per locate (keyed by ts). The
  // latch is written ONLY where a scrollToIndex actually executes, never at
  // effect entry. The cross-page path relies on this: Run 1 only switches
  // pages and schedules the fallback timer; committing the new page re-runs
  // this effect and its cleanup cancels that timer — an entry-latch would
  // make Run 2 skip and lose the scroll entirely.
  useEffect(() => {
    if (!highlightedFileId || filteredItems.length === 0) return;
    if (lastScrolledTsRef.current === highlightedFileId.ts) return;
    const index = filteredItems.findIndex(
      (item) => item.id === highlightedFileId.id,
    );
    if (index === -1) return;
    const scrollToHighlightedRow = () => {
      listRef.current?.scrollToIndex(index % ITEMS_PER_PAGE, {
        align: "center",
      });
      lastScrolledTsRef.current = highlightedFileId.ts;
    };
    const targetPage = Math.floor(index / ITEMS_PER_PAGE) + 1;
    if (targetPage !== currentPage) {
      setCurrentPage(targetPage);
      const timerId = setTimeout(
        scrollToHighlightedRow,
        SCROLL_HIGHLIGHT_DELAY_MS,
      );
      return () => {
        clearTimeout(timerId);
      };
    }
    scrollToHighlightedRow();
    // The effect only reads the enumerated members passed in (adding the whole
    // explorer object would re-run the highlight-scroll on every render since
    // useDriveExplorer returns a fresh object each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedFileId, currentPage, filteredItems, setCurrentPage]);
}
