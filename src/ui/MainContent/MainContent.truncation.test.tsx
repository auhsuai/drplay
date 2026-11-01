// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MainContent } from "./MainContent";
import type { DriveItem } from "../../types";

// S-05: the 500-result cap is deliberate, but the UI must ADMIT that the list
// it shows is truncated instead of presenting "10 pages" as everything.
// Explorer is mocked (same pattern as MainContent.searchStatus); `t` returns
// the key with its interpolation options appended so the assertions can also
// prove the counts reach i18next.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        key: i,
        size: 92,
        start: i * 92,
      })),
    getTotalSize: () => count * 92,
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
    containerRef: { current: document.createElement("div") },
  })),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts === undefined ? k : `${k}${JSON.stringify(opts)}`,
  }),
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

vi.mock("../../utils/normalizeText", () => ({
  normalizeText: (s: string) => s.toLowerCase(),
}));

const { useDriveExplorerMock } = vi.hoisted(() => ({
  useDriveExplorerMock: vi.fn(),
}));

vi.mock("../../hooks/useDriveExplorer", () => ({
  useDriveExplorer: useDriveExplorerMock,
}));

vi.mock("./components/SongCard", () => ({
  SongCard: ({ item }: { item: DriveItem }) => (
    <div data-testid="song-card" data-item-id={item.id} />
  ),
}));

vi.mock("../FolderSelection/FolderSelectionScreen", () => ({
  FolderSelectionScreen: () => null,
  MOVE_PICKER_OPEN_ATTR: "data-move-picker-open",
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

// Mirrors the real useDriveExplorer return shape. The S-05 members are
// deliberately NOT in the base object: the backward-compat test reuses this
// exact shape to prove the component tolerates explorers that predate them.
function makeExplorerState(overrides: Record<string, unknown> = {}) {
  return {
    searchQuery: "",
    setSearchQuery: vi.fn(),
    searchMode: "global" as "global" | "recursive",
    setSearchMode: vi.fn(),
    searchSort: { field: "relevance", dir: "desc" } as {
      field: "relevance" | "name" | "modifiedTime" | "size";
      dir: "asc" | "desc";
    },
    setSearchSort: vi.fn(),
    currentPage: 1,
    setCurrentPage: vi.fn(),
    totalPages: 1,
    currentItems: makeItems(3),
    filteredItems: makeItems(3),
    isSelectionMode: false,
    setIsSelectionMode: vi.fn(),
    selectedIds: new Set<string>(),
    setSelectedIds: vi.fn(),
    isCreatingFolder: false,
    isBulkOperating: false,
    handleCreateFolder: vi.fn(),
    handleBulkDelete: vi.fn(),
    handleBulkMove: vi.fn(),
    isVirtualRoot: false,
    ...overrides,
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
  sortOption: "name",
  onSortChange: vi.fn(),
};

const NOTICE = "drive.results_truncated";

describe("MainContent truncation notice (S-05)", () => {
  beforeEach(() => {
    baseProps.onSortChange = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the notice with the shown/total counts when the result set is truncated", () => {
    // Real shape: the cap delivered 500 of 900 matches.
    const cappedHits = makeItems(500);
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "song",
        searchStatus: "success",
        hasSearchQuery: true,
        searchTruncated: true,
        searchTotalMatches: 900,
        currentItems: cappedHits,
        filteredItems: cappedHits,
        totalPages: 10,
      }),
    );
    render(<MainContent {...baseProps} />);

    const notice = screen.getByTestId("search-truncated-notice");
    expect(notice.textContent).toContain(NOTICE);
    expect(notice.textContent).toContain('"shown":500');
    expect(notice.textContent).toContain('"total":900');
    // The pagination chrome still reflects the RECEIVED hits, never a faked
    // total-page count.
    expect(screen.getByTestId("main-pagination-chrome")).toBeTruthy();
  });

  it("does NOT render the notice when truncated is false", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "song",
        searchStatus: "success",
        hasSearchQuery: true,
        searchTruncated: false,
        searchTotalMatches: 120,
        totalPages: 3,
      }),
    );
    render(<MainContent {...baseProps} />);

    expect(screen.queryByTestId("search-truncated-notice")).toBeNull();
  });

  it("backward compat: an explorer without the new fields renders exactly as today", () => {
    // makeExplorerState() with no overrides is the pre-S-05 mock shape used by
    // the other MainContent component tests.
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "song",
        searchStatus: "success",
        hasSearchQuery: true,
      }),
    );
    render(<MainContent {...baseProps} />);

    expect(screen.queryByTestId("search-truncated-notice")).toBeNull();
    expect(screen.getAllByTestId("song-card").length).toBe(3);
  });

  it("does not render the notice for the plain folder listing", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({ searchTruncated: true, searchTotalMatches: 900 }),
    );
    render(<MainContent {...baseProps} />);

    expect(screen.queryByTestId("search-truncated-notice")).toBeNull();
  });
});
