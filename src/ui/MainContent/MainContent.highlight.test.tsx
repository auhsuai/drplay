// @vitest-environment jsdom
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { MainContent } from "./MainContent";
import type { DriveItem } from "../../types";

// Phase B fix (2026-08-23): the highlight-scroll effect had no consume-once
// latch keyed by highlightedFileId.ts, so every new filteredItems identity
// inside the highlight window (upload ticks, search, Dexie writes) re-ran the
// effect and re-yanked scrollToIndex(center). These tests pin:
//   B2 — data churn with the SAME ts scrolls exactly once;
//   pagination path — switching to the target page still scrolls exactly once
//   (the latch is written at the moment scrollToIndex executes, never at
//   effect entry, or Run 2 after the page commit would skip and lose it);
//   new locate (fresh ts) scrolls again; guards stay no-ops.
// ITEMS_PER_PAGE is pinned to 5 through the module mock so the pagination math
// is deterministic (the real value differs per platform: mobile single-page).

const { useDriveExplorerMock, scrollToIndexSpy, virtualizerMock } = vi.hoisted(
  () => ({
    useDriveExplorerMock: vi.fn(),
    scrollToIndexSpy: vi.fn(),
    virtualizerMock: vi.fn(),
  }),
);

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: virtualizerMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => null,
}));

vi.mock("../../db/db", () => ({
  db: { files: { toArray: vi.fn() } },
}));

vi.mock("../../utils/streamPrefetcher", () => ({
  prefetchVisibleTracks: vi.fn(),
  clearPrefetchedStreams: vi.fn(),
}));

vi.mock("../../utils/nextTrackPrefetcher", () => ({
  clearNextTrackPrefetches: vi.fn(),
}));

vi.mock("../../utils/normalizeText", () => ({
  normalizeText: (s: string) => s.toLowerCase(),
}));

vi.mock("../../hooks/useDriveExplorer", () => ({
  useDriveExplorer: useDriveExplorerMock,
  ITEMS_PER_PAGE: 5,
}));

// uploadManager stays REAL (isUploading drives Select All); only the unmount
// cleanup hook is spied out — same split as MainContent.windowing.test.tsx.
vi.mock("../../utils/uploadManager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/uploadManager")>()),
  clearUploadedTint: vi.fn(),
}));

vi.mock("./components/SongCard", () => ({
  SongCard: vi.fn(({ item }: { item: DriveItem }) => (
    <div data-testid="song-card" data-item-id={item.id} />
  )),
}));

vi.mock("../FolderSelection/FolderSelectionScreen", () => ({
  FolderSelectionScreen: () => <div data-testid="folder-screen-stub" />,
}));

function makeItems(n: number): DriveItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id${String(i)}`,
    title: `Song ${String(i)}`,
    isFolder: false,
    trackInfo: {
      id: `id${String(i)}`,
      title: `Song ${String(i)}`,
      artist: "",
      streamUrl: "",
      size: 1000,
      originalName: `song${String(i)}.mp3`,
    },
  }));
}

// Mirrors the return shape of the real useDriveExplorer hook
// (src/hooks/useDriveExplorer.ts) — same helper as the windowing suite.
function makeExplorerState(items: DriveItem[]) {
  return {
    searchQuery: "",
    setSearchQuery: vi.fn(),
    currentPage: 1,
    setCurrentPage: vi.fn(),
    totalPages: 1,
    currentItems: items,
    filteredItems: items,
    isSelectionMode: false,
    setIsSelectionMode: vi.fn(),
    selectedIds: new Set<string>(),
    setSelectedIds: vi.fn(),
    isCreatingFolder: false,
    isBulkOperating: false,
    handleCreateFolder: vi.fn(),
    handleBulkDelete: vi.fn(),
    handleBulkMove: vi.fn(),
  };
}

const baseProps = {
  activeTab: "My Drive" as const,
  onPlay: vi.fn(),
  isLoading: false,
  onOpenFolder: vi.fn(),
  onBack: vi.fn(),
  hasHistory: false,
  folderHistory: [] as { id: string; name: string }[],
  currentFolderName: "Root",
  onBreadcrumbClick: vi.fn(),
  token: "tok",
  currentFolderId: "root",
  onRefresh: vi.fn(),
  currentTrack: null,
};

// MainContent is React.memo-wrapped: a props-identical rerender is skipped and
// useDriveExplorer is never re-called, so every simulated churn step swaps in
// a fresh onRefresh identity (zero UI impact) alongside the new explorer
// state — same trick the windowing suite uses with isLoading. The SAME
// highlight object is carried through every churn: its ts is what must stop
// the re-scroll while the data identity changes underneath it. The churned
// listing keeps the SAME shape (itemCount) so any highlighted id stays
// resolvable — only the array identity is new, like real Dexie/upload ticks.
function simulateDataChurn(
  rerender: (ui: React.ReactElement) => void,
  highlight: { id: string; ts: number; folderId: string },
  itemCount = 3,
): void {
  useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(itemCount)));
  rerender(
    <MainContent
      {...baseProps}
      highlightedFileId={highlight}
      onRefresh={vi.fn()}
    />,
  );
}

// Must exceed SCROLL_HIGHLIGHT_DELAY_MS (50ms) so the fallback timer fires.
const FALLBACK_DELAY_PROBE_MS = 60;

describe("MainContent highlight-scroll consume-once latch (Phase B fix 2026-08-23)", () => {
  beforeEach(() => {
    virtualizerMock.mockImplementation(({ count }: { count: number }) => ({
      getVirtualItems: () =>
        Array.from({ length: count }, (_, i) => ({
          index: i,
          key: i,
          size: 92,
          start: i * 92,
        })),
      getTotalSize: () => count * 92,
      measureElement: vi.fn(),
      scrollToIndex: scrollToIndexSpy,
      containerRef: { current: document.createElement("div") },
    }));
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    cleanup();
    if (vi.isFakeTimers()) vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("B2: scrolls once for a locate, then ignores data churn carrying the same ts (new filteredItems identities)", () => {
    const highlight = { id: "id1", ts: 1000, folderId: "root" };
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
    const { rerender } = render(
      <MainContent {...baseProps} highlightedFileId={highlight} />,
    );

    expect(scrollToIndexSpy).toHaveBeenCalledTimes(1);
    expect(scrollToIndexSpy).toHaveBeenCalledWith(1, { align: "center" });

    // Upload tick / search / Dexie write: brand-new array identities, same ts.
    simulateDataChurn(rerender, highlight);
    simulateDataChurn(rerender, highlight);

    expect(scrollToIndexSpy).toHaveBeenCalledTimes(1);
  });

  it("pagination path: switching to the target page scrolls exactly once after the commit (latch written at scroll time, not at effect entry)", () => {
    const items12 = makeItems(12);
    const explorerPage1 = makeExplorerState(items12);
    useDriveExplorerMock.mockReturnValue(explorerPage1);
    const highlight = { id: "id11", ts: 2000, folderId: "root" };

    const { rerender } = render(
      <MainContent {...baseProps} highlightedFileId={highlight} />,
    );

    // Run 1: targetPage = floor(11 / 5) + 1 = 3 ≠ 1 — switch pages, schedule
    // the fallback timer, and DO NOT scroll yet.
    expect(explorerPage1.setCurrentPage).toHaveBeenCalledTimes(1);
    expect(explorerPage1.setCurrentPage).toHaveBeenCalledWith(3);
    expect(scrollToIndexSpy).not.toHaveBeenCalled();

    // The page commit lands (real hook flips currentPage and slices
    // currentItems; filteredItems stays the FULL list). Its rerun cancels the
    // pending timer and takes the same-page branch.
    useDriveExplorerMock.mockReturnValue({
      ...makeExplorerState(items12),
      currentPage: 3,
      currentItems: makeItems(12).slice(10),
    });
    rerender(
      <MainContent
        {...baseProps}
        highlightedFileId={highlight}
        onRefresh={vi.fn()}
      />,
    );

    // Exactly one scroll, for row 11 % 5 = 1 of the committed page.
    expect(scrollToIndexSpy).toHaveBeenCalledTimes(1);
    expect(scrollToIndexSpy).toHaveBeenNthCalledWith(1, 1, {
      align: "center",
    });
  });

  it("a NEW locate (fresh ts) scrolls again after the previous one was consumed", () => {
    const firstLocate = { id: "id1", ts: 1000, folderId: "root" };
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
    const { rerender } = render(
      <MainContent {...baseProps} highlightedFileId={firstLocate} />,
    );
    expect(scrollToIndexSpy).toHaveBeenCalledTimes(1);

    const secondLocate = { id: "id2", ts: 2000, folderId: "root" };
    rerender(
      <MainContent
        {...baseProps}
        highlightedFileId={secondLocate}
        onRefresh={vi.fn()}
      />,
    );

    expect(scrollToIndexSpy).toHaveBeenCalledTimes(2);
    expect(scrollToIndexSpy).toHaveBeenNthCalledWith(2, 2, {
      align: "center",
    });
  });

  it("slow-commit fallback: the 50ms timer scrolls once and later churn with the same ts cannot scroll again", () => {
    vi.useFakeTimers();
    const items12 = makeItems(12);
    const explorerPage1 = makeExplorerState(items12);
    useDriveExplorerMock.mockReturnValue(explorerPage1);
    const highlight = { id: "id11", ts: 3000, folderId: "root" };

    const { rerender } = render(
      <MainContent {...baseProps} highlightedFileId={highlight} />,
    );
    expect(scrollToIndexSpy).not.toHaveBeenCalled();

    // No page-commit rerender arrives before the delay elapses — the
    // fallback timer performs the scroll (and consumes the latch).
    act(() => {
      vi.advanceTimersByTime(FALLBACK_DELAY_PROBE_MS);
    });
    expect(scrollToIndexSpy).toHaveBeenCalledTimes(1);
    expect(scrollToIndexSpy).toHaveBeenNthCalledWith(1, 1, {
      align: "center",
    });

    // Data churn after the fired scroll, same ts, SAME listing shape (id11
    // still resolvable): no further scroll even across another fallback-delay
    // window — the fired timer consumed the latch.
    simulateDataChurn(rerender, highlight, 12);
    act(() => {
      vi.advanceTimersByTime(FALLBACK_DELAY_PROBE_MS);
    });
    expect(scrollToIndexSpy).toHaveBeenCalledTimes(1);
  });

  it("stays a no-op when there is nothing to scroll to: null highlight, unknown id, empty items", () => {
    // No highlight at all.
    const noHighlight = render(<MainContent {...baseProps} />);
    expect(scrollToIndexSpy).not.toHaveBeenCalled();
    noHighlight.unmount();

    // Highlight whose id is absent from the listing.
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
    const missingId = render(
      <MainContent
        {...baseProps}
        highlightedFileId={{ id: "missing", ts: 4000, folderId: "root" }}
      />,
    );
    expect(scrollToIndexSpy).not.toHaveBeenCalled();
    missingId.unmount();

    // Empty listing.
    useDriveExplorerMock.mockReturnValue(makeExplorerState([]));
    render(
      <MainContent
        {...baseProps}
        highlightedFileId={{ id: "id1", ts: 5000, folderId: "root" }}
      />,
    );
    expect(scrollToIndexSpy).not.toHaveBeenCalled();
  });
});

describe("MainContent scroll-to-top folder-awareness (B3 fix 2026-08-23)", () => {
  // jsdom ships no Element.scrollTo — install an assertable prototype stub
  // for each test and remove it afterwards so other suites stay untouched.
  let scrollTopSpy: Mock;

  beforeEach(() => {
    scrollTopSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value: scrollTopSpy,
    });
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    const proto = HTMLElement.prototype as unknown as { scrollTo?: unknown };
    delete proto.scrollTo;
  });

  it("B3 fix: manual navigation to folder Z while ANOTHER folder's highlight is alive still scrolls to top", () => {
    const highlight = { id: "id1", ts: 1000, folderId: "folder-y" };
    const { rerender } = render(
      <MainContent
        {...baseProps}
        currentFolderId="folder-y"
        highlightedFileId={highlight}
      />,
    );
    expect(scrollTopSpy).not.toHaveBeenCalled();

    rerender(
      <MainContent
        {...baseProps}
        currentFolderId="folder-z"
        highlightedFileId={highlight}
      />,
    );

    expect(scrollTopSpy).toHaveBeenCalledTimes(1);
    expect(scrollTopSpy).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("B3 lock: destination-folder highlight still suppresses scroll-to-top (locate flow owns the viewport)", () => {
    const highlight = { id: "id1", ts: 1000, folderId: "folder-z" };
    const { rerender } = render(
      <MainContent
        {...baseProps}
        currentFolderId="root"
        highlightedFileId={highlight}
      />,
    );
    expect(scrollTopSpy).not.toHaveBeenCalled();

    rerender(
      <MainContent
        {...baseProps}
        currentFolderId="folder-z"
        highlightedFileId={highlight}
      />,
    );

    expect(scrollTopSpy).not.toHaveBeenCalled();
  });

  it("B3 lock: cleared (expired) highlight no longer suppresses scroll-to-top", () => {
    const { rerender } = render(
      <MainContent
        {...baseProps}
        currentFolderId="root"
        highlightedFileId={null}
      />,
    );
    expect(scrollTopSpy).not.toHaveBeenCalled();

    rerender(
      <MainContent
        {...baseProps}
        currentFolderId="folder-z"
        highlightedFileId={null}
      />,
    );

    expect(scrollTopSpy).toHaveBeenCalledTimes(1);
    expect(scrollTopSpy).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});

// GUARD (Phase B removal 2026-08-23): the producer of "enable-selection-mode"
// (GlobalContextMenu.tsx) was deleted in commit 0cdd5d7 ("chore: remove dead
// GlobalContextMenu component (replaced by MoreMenu)"); the MainContent
// listener it fed was orphaned dead code and has been removed alongside.
// This test pins the removal: dispatching that event must NOT enable
// selection mode, so a reintroduced producer-less listener fails here.
describe("MainContent 'enable-selection-mode' dead-listener guard (Phase B removal 2026-08-23)", () => {
  it("dispatching 'enable-selection-mode' does not enable selection mode (producer removed in 0cdd5d7)", () => {
    const explorer = makeExplorerState(makeItems(3));
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("enable-selection-mode", { detail: { id: "id1" } }),
      );
    });

    expect(explorer.setIsSelectionMode).not.toHaveBeenCalled();
    expect(explorer.setSelectedIds).not.toHaveBeenCalled();
  });
});
