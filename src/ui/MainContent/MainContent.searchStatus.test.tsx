// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MainContent } from "./MainContent";
import type { DriveItem } from "../../types";

// S-03/S-04: the empty state must distinguish "search in flight" from "search
// settled with zero hits", and must use the SAME trimmed query condition the
// data selection uses. Explorer is mocked (same pattern as
// MainContent.searchSort); `t` returns the key so assertions read as i18n keys.
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

// Mirrors the real useDriveExplorer return shape. The S-03/S-04 members are
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

describe("MainContent search status + trimmed empty state (S-03/S-04)", () => {
  beforeEach(() => {
    baseProps.onSortChange = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("pending search shows the searching label and NOT the no-results label", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "song",
        searchStatus: "pending",
        hasSearchQuery: true,
        currentItems: [],
        filteredItems: [],
      }),
    );
    render(<MainContent {...baseProps} />);

    expect(screen.getByText("drive.searching")).toBeTruthy();
    expect(screen.queryByText("drive.no_search_results")).toBeNull();
    expect(screen.queryByText("drive.no_audio")).toBeNull();
  });

  it("settled zero-hit search shows the no-results label only", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "song",
        searchStatus: "success",
        hasSearchQuery: true,
        currentItems: [],
        filteredItems: [],
      }),
    );
    render(<MainContent {...baseProps} />);

    expect(screen.getByText("drive.no_search_results")).toBeTruthy();
    expect(screen.queryByText("drive.searching")).toBeNull();
  });

  it("S-04: a whitespace-only query in an empty folder shows no_audio, not no_search_results", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "   ",
        searchStatus: "idle",
        hasSearchQuery: false,
        currentItems: [],
        filteredItems: [],
      }),
    );
    render(<MainContent {...baseProps} />);

    expect(screen.getByText("drive.no_audio")).toBeTruthy();
    expect(screen.queryByText("drive.no_search_results")).toBeNull();
    expect(screen.queryByText("drive.searching")).toBeNull();
  });

  it("a whitespace-only query with items still renders the listing", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "   ",
        searchStatus: "idle",
        hasSearchQuery: false,
      }),
    );
    render(<MainContent {...baseProps} />);

    expect(screen.getAllByTestId("song-card").length).toBe(3);
    expect(screen.queryByText("drive.no_search_results")).toBeNull();
  });

  it("backward compat: an explorer without the new fields still shows no_search_results", () => {
    // makeExplorerState() with no overrides is the pre-S-03 mock shape.
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "song",
        currentItems: [],
        filteredItems: [],
      }),
    );
    render(<MainContent {...baseProps} />);

    expect(screen.getByText("drive.no_search_results")).toBeTruthy();
    expect(screen.queryByText("drive.searching")).toBeNull();
  });
});
