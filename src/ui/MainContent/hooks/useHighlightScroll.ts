import { useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { DriveItem } from "../../../types";
import type { VirtualizedSongListHandle } from "../components/VirtualizedSongList";
import { ITEMS_PER_PAGE } from "../../../hooks/useDriveExplorer";

// Fallback delay for the cross-page highlight scroll: normally the page
// commit itself re-runs the highlight effect, whose cleanup cancels this
// timer before it fires; the timeout only performs the scroll when the new
// page renders slower than the delay (slow devices/commits).
const SCROLL_HIGHLIGHT_DELAY_MS = 50;

export function useHighlightScroll({
  mainRef,
  virtualizedListRef,
  currentFolderId,
  highlightedFileId,
  filteredItems,
  currentPage,
  setCurrentPage,
}: {
  mainRef: RefObject<HTMLElement | null>;
  virtualizedListRef: RefObject<VirtualizedSongListHandle | null>;
  currentFolderId: string;
  highlightedFileId?:
    { id: string; ts: number; folderId: string } | null | undefined;
  filteredItems: DriveItem[];
  currentPage: number;
  setCurrentPage: Dispatch<SetStateAction<number>>;
}): void {
  // Scroll to top on folder change — unless a LIVE locate highlight belongs
  // to the destination folder itself (the highlight effect will land on the
  // row anyway). The highlight carries the folderId it was produced for, so a
  // highlight from another folder no longer suppresses this scroll when the
  // user navigates manually within the 5s window (audit B3: the old check was
  // folder-blind and skipped scroll-to-top unfairly).
  const prevFolderRef = useRef(currentFolderId);
  useEffect(() => {
    if (mainRef.current) {
      const isFolderChange = currentFolderId !== prevFolderRef.current;
      const isLiveHighlightForDestination =
        highlightedFileId != null &&
        highlightedFileId.folderId === currentFolderId;
      if (isFolderChange && !isLiveHighlightForDestination) {
        mainRef.current.scrollTo({ top: 0, behavior: "smooth" });
      }
      prevFolderRef.current = currentFolderId;
    }
  }, [currentFolderId, highlightedFileId, mainRef]);

  // Consume-once latch for highlight scrolling: the ts of the last locate we
  // actually scrolled to. Data churn (search refreshes, Dexie writes)
  // keeps re-creating filteredItems while the SAME highlight is active — the
  // effect re-runs on every new identity but must not re-yank the viewport:
  // one locate = one scroll.
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
      virtualizedListRef.current?.scrollToIndex(index % ITEMS_PER_PAGE, {
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
    // The effect only reads the enumerated explorer members (adding the whole
    // explorer object would re-run the highlight-scroll on every render since
    // useDriveExplorer returns a fresh object each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedFileId, currentPage, filteredItems, setCurrentPage]);
}
