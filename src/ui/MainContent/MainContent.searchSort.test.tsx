// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MainContent } from "./MainContent";
import type { DriveItem } from "../../types";
import { VIRTUAL_ROOT_ID, VIRTUAL_ROOT_NAME } from "../../utils/driveConstants";

// Phase B tests: the FileListHeader stays visible while a search is active
// (the old `searchQuery.trim() === ""` guard is gone) and its sort state is
// ISOLATED from the listing sortOption — during a search the header routes
// through explorer.searchSort/setSearchSort (relevance default), never the
// listing props. Explorer is mocked (same pattern as MainContent.virtualRoot).
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

// Mirrors the real useDriveExplorer return shape, extended with the Phase A
// search mode/sort members (I2).
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

// FileListHeader is rendered through the real component (not mocked) so the
// sort-string contract is exercised end to end.
const headerRow = () => screen.getByRole("presentation");

describe("MainContent header visibility during search (Phase B)", () => {
  beforeEach(() => {
    baseProps.onSortChange = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("empty query: header renders with the LISTING sortOption (old behavior kept)", () => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState());
    render(<MainContent {...baseProps} />);

    expect(headerRow()).toBeTruthy();
    // Name column owns the listing sort → ascending indicator present.
    expect(
      screen.getByRole("columnheader", { name: "drive.col_name" }),
    ).toHaveAttribute("aria-sort", "ascending");
  });

  it("global search active: header STAYS visible with the SEARCH sort state", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({ searchQuery: "song" }),
    );
    render(<MainContent {...baseProps} />);

    expect(headerRow()).toBeTruthy();
    // Relevance default → unknown base → every column aria-sort "none".
    for (const label of [
      "drive.col_name",
      "drive.col_date_modified",
      "drive.col_size",
    ]) {
      expect(screen.getByRole("columnheader", { name: label })).toHaveAttribute(
        "aria-sort",
        "none",
      );
    }
  });

  it("recursive search active: header STAYS visible", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({ searchQuery: "song", searchMode: "recursive" }),
    );
    render(<MainContent {...baseProps} />);

    expect(headerRow()).toBeTruthy();
    expect(
      screen.getByRole("columnheader", { name: "drive.col_name" }),
    ).toBeTruthy();
  });

  it("search with 0 results: header STAYS visible", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "zzz",
        currentItems: [],
        filteredItems: [],
      }),
    );
    render(<MainContent {...baseProps} />);

    expect(screen.getByText("drive.no_search_results")).toBeTruthy();
    expect(headerRow()).toBeTruthy();
  });

  it("search with folders + files mix: header STAYS visible", () => {
    const mixed: DriveItem[] = [
      {
        id: "folder-1",
        title: "Mix Folder",
        isFolder: true,
        parentId: "root",
      },
      ...makeItems(1),
    ];
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "mix",
        currentItems: mixed,
        filteredItems: mixed,
      }),
    );
    render(<MainContent {...baseProps} />);

    expect(headerRow()).toBeTruthy();
  });

  it("normal virtual root listing (no search): header STAYS hidden", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({ isVirtualRoot: true }),
    );
    render(
      <MainContent
        {...baseProps}
        currentFolderId={VIRTUAL_ROOT_ID}
        currentFolderName={VIRTUAL_ROOT_NAME}
      />,
    );

    // Root rows are all folders with no date/size — no sortable columns.
    expect(screen.queryByRole("presentation")).toBeNull();
  });

  it("virtual root + global search active: header VISIBLE", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "song",
        searchMode: "global",
        isVirtualRoot: true,
      }),
    );
    render(
      <MainContent
        {...baseProps}
        currentFolderId={VIRTUAL_ROOT_ID}
        currentFolderName={VIRTUAL_ROOT_NAME}
      />,
    );

    expect(headerRow()).toBeTruthy();
    // Relevance default → unknown base → every column aria-sort "none".
    expect(
      screen.getByRole("columnheader", { name: "drive.col_name" }),
    ).toHaveAttribute("aria-sort", "none");
  });

  it("virtual root + recursive search active: header VISIBLE", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "song",
        searchMode: "recursive",
        isVirtualRoot: true,
      }),
    );
    render(
      <MainContent
        {...baseProps}
        currentFolderId={VIRTUAL_ROOT_ID}
        currentFolderName={VIRTUAL_ROOT_NAME}
      />,
    );

    expect(headerRow()).toBeTruthy();
  });

  it("virtual root + search with 0 results: header STILL visible", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "zzz",
        isVirtualRoot: true,
        currentItems: [],
        filteredItems: [],
      }),
    );
    render(
      <MainContent
        {...baseProps}
        currentFolderId={VIRTUAL_ROOT_ID}
        currentFolderName={VIRTUAL_ROOT_NAME}
      />,
    );

    expect(screen.getByText("drive.no_search_results")).toBeTruthy();
    expect(headerRow()).toBeTruthy();
  });

  it("selection mode during search: header STAYS hidden (guard kept)", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({ searchQuery: "song", isSelectionMode: true }),
    );
    render(<MainContent {...baseProps} />);

    expect(screen.queryByRole("presentation")).toBeNull();
  });

  it("virtual root + search + selection mode: header STAYS hidden", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "song",
        isVirtualRoot: true,
        isSelectionMode: true,
      }),
    );
    render(
      <MainContent
        {...baseProps}
        currentFolderId={VIRTUAL_ROOT_ID}
        currentFolderName={VIRTUAL_ROOT_NAME}
      />,
    );

    expect(screen.queryByRole("presentation")).toBeNull();
  });
});

describe("MainContent search sort isolation (Phase B)", () => {
  beforeEach(() => {
    baseProps.onSortChange = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("search active: clicking Name routes through setSearchSort, NOT the listing onSortChange", () => {
    const explorer = makeExplorerState({ searchQuery: "song" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} sortOption="modifiedTime desc" />);

    fireEvent.click(screen.getByRole("button", { name: "drive.col_name" }));
    expect(explorer.setSearchSort).toHaveBeenCalledWith({
      field: "name",
      dir: "asc",
    });
    expect(baseProps.onSortChange).not.toHaveBeenCalled();
  });

  it("search active: click Date applies newest-first (modifiedTime desc) through setSearchSort", () => {
    const explorer = makeExplorerState({ searchQuery: "song" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    fireEvent.click(
      screen.getByRole("button", { name: "drive.col_date_modified" }),
    );
    expect(explorer.setSearchSort).toHaveBeenCalledWith({
      field: "modifiedTime",
      dir: "desc",
    });
    expect(baseProps.onSortChange).not.toHaveBeenCalled();
  });

  it("search active: click Size applies largest-first (size desc); active column toggles direction", () => {
    const explorer = makeExplorerState({ searchQuery: "song" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "drive.col_size" }));
    expect(explorer.setSearchSort).toHaveBeenCalledWith({
      field: "size",
      dir: "desc",
    });

    // Active column flip: searchSort = size desc → header shows "size desc"
    // → clicking Size again routes "size" (asc). Fresh render (the first
    // root stays mounted; unmount it so the size button is unique).
    const explorer2 = makeExplorerState({
      searchQuery: "song",
      searchSort: { field: "size", dir: "desc" },
    });
    useDriveExplorerMock.mockReturnValue(explorer2);
    cleanup();
    render(<MainContent {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "drive.col_size" }));
    expect(explorer2.setSearchSort).toHaveBeenCalledWith({
      field: "size",
      dir: "asc",
    });
  });

  it("search active: header reflects explorer.searchSort (name asc → aria-sort ascending on Name)", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState({
        searchQuery: "song",
        searchSort: { field: "name", dir: "asc" },
      }),
    );
    render(<MainContent {...baseProps} sortOption="modifiedTime desc" />);

    expect(
      screen.getByRole("columnheader", { name: "drive.col_name" }),
    ).toHaveAttribute("aria-sort", "ascending");
    expect(
      screen.getByRole("columnheader", { name: "drive.col_date_modified" }),
    ).toHaveAttribute("aria-sort", "none");
  });

  it("search sort changes NEVER write the listing sortOption (prop untouched after clicks)", () => {
    const explorer = makeExplorerState({ searchQuery: "song" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} sortOption="name" />);

    fireEvent.click(screen.getByRole("button", { name: "drive.col_size" }));
    fireEvent.click(screen.getByRole("button", { name: "drive.col_name" }));
    expect(baseProps.onSortChange).not.toHaveBeenCalled();
  });

  it("virtual root + search active: clicking a column routes setSearchSort only, listing sortOption untouched", () => {
    const explorer = makeExplorerState({
      searchQuery: "song",
      isVirtualRoot: true,
    });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(
      <MainContent
        {...baseProps}
        currentFolderId={VIRTUAL_ROOT_ID}
        currentFolderName={VIRTUAL_ROOT_NAME}
        sortOption="name"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "drive.col_size" }));
    expect(explorer.setSearchSort).toHaveBeenCalledWith({
      field: "size",
      dir: "desc",
    });
    expect(baseProps.onSortChange).not.toHaveBeenCalled();
  });

  it("empty query: clicks still route through the LISTING onSortChange (unchanged)", () => {
    const explorer = makeExplorerState();
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} sortOption="name" />);

    fireEvent.click(screen.getByRole("button", { name: "drive.col_size" }));
    expect(baseProps.onSortChange).toHaveBeenCalledWith("size desc");
    expect(explorer.setSearchSort).not.toHaveBeenCalled();
  });

  it("search mode toggle wiring: toolbar toggle flips explorer.searchMode, query untouched", () => {
    const explorer = makeExplorerState({ searchQuery: "song" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    fireEvent.click(
      screen.getByRole("button", { name: "search.switch_to_recursive" }),
    );
    expect(explorer.setSearchMode).toHaveBeenCalledWith("recursive");
    expect(explorer.setSearchQuery).not.toHaveBeenCalled();
  });
});

// Ctrl+D (Cmd+D on macOS) toggles the search scope without the mouse. It
// mirrors the toolbar mode toggle's semantics (explorer.setSearchMode with the
// flipped value) and stays available while the caret is in the search input
// (the main use case), while other editable targets and auto-repeat presses
// stand it down. The shared overlay guard (modal/menu open) still stands the
// whole handler down.
describe("MainContent Ctrl+D toggles search scope", () => {
  beforeEach(() => {
    baseProps.onSortChange = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("Ctrl+D in global mode switches to recursive and prevents the browser default", () => {
    const explorer = makeExplorerState({ searchQuery: "song" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    const notCancelled = fireEvent.keyDown(window, { key: "d", ctrlKey: true });

    // dispatchEvent returns false when preventDefault() was honoured.
    expect(notCancelled).toBe(false);
    expect(explorer.setSearchMode).toHaveBeenCalledWith("recursive");
    expect(explorer.setSearchMode).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+D in recursive mode switches back to global", () => {
    const explorer = makeExplorerState({
      searchQuery: "song",
      searchMode: "recursive",
    });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    fireEvent.keyDown(window, { key: "d", ctrlKey: true });

    expect(explorer.setSearchMode).toHaveBeenCalledWith("global");
    expect(explorer.setSearchMode).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+D fires while the caret is inside the search input (no editable guard)", () => {
    const explorer = makeExplorerState({ searchQuery: "son" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    const searchInput = screen.getByPlaceholderText("search_placeholder");
    searchInput.focus();
    expect(document.activeElement).toBe(searchInput);

    fireEvent.keyDown(searchInput, { key: "d", ctrlKey: true });

    expect(explorer.setSearchMode).toHaveBeenCalledWith("recursive");
    expect(explorer.setSearchQuery).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(searchInput);
  });

  it("Ctrl+Shift+D and Ctrl+Alt+D do NOT toggle the search scope", () => {
    const explorer = makeExplorerState({ searchQuery: "song" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    fireEvent.keyDown(window, { key: "D", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "d", ctrlKey: true, altKey: true });

    expect(explorer.setSearchMode).not.toHaveBeenCalled();
  });

  it("Ctrl+D stands down while an overlay (new-folder modal) owns the keyboard", () => {
    const explorer = makeExplorerState({ searchQuery: "song" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    fireEvent.click(screen.getByText("drive.new_folder"));
    expect(
      screen.getByPlaceholderText("drive.folder_name_placeholder"),
    ).toBeTruthy();

    fireEvent.keyDown(window, { key: "d", ctrlKey: true });

    expect(explorer.setSearchMode).not.toHaveBeenCalled();
  });

  it("Cmd+D toggles too, and keeps the query and the search-input focus", () => {
    const explorer = makeExplorerState({ searchQuery: "son" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);
    const searchInput = screen.getByPlaceholderText("search_placeholder");
    searchInput.focus();

    fireEvent.keyDown(searchInput, { key: "d", metaKey: true });

    expect(explorer.setSearchMode).toHaveBeenCalledWith("recursive");
    expect(explorer.setSearchQuery).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(searchInput);
  });

  it("Ctrl+D fires when focus is NOT in an editable field", () => {
    const explorer = makeExplorerState({ searchQuery: "song" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);
    // Focus sits on a toolbar button (not editable) — the chord still works.
    screen.getByRole("button", { name: "drive.new_folder" }).focus();

    fireEvent.keyDown(window, { key: "d", ctrlKey: true });

    expect(explorer.setSearchMode).toHaveBeenCalledWith("recursive");
  });

  it("Ctrl+D does NOT toggle from ANOTHER input / a textarea / a contenteditable", () => {
    const explorer = makeExplorerState({ searchQuery: "song" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(
      <div>
        <MainContent {...baseProps} />
        <input data-testid="foreign-input" type="text" />
        <textarea data-testid="foreign-textarea" />
        <div
          data-testid="foreign-editable"
          contentEditable
          suppressContentEditableWarning
        />
      </div>,
    );

    for (const id of [
      "foreign-input",
      "foreign-textarea",
      "foreign-editable",
    ]) {
      const el = screen.getByTestId(id);
      el.focus();
      expect(document.activeElement).toBe(el);
      fireEvent.keyDown(el, { key: "d", ctrlKey: true });
    }

    expect(explorer.setSearchMode).not.toHaveBeenCalled();
  });

  it("auto-repeat (held chord) does not flip the scope repeatedly", () => {
    const explorer = makeExplorerState({ searchQuery: "song" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    // The browser fires one non-repeat keydown, then repeats while held.
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    fireEvent.keyDown(window, { key: "d", ctrlKey: true, repeat: true });
    fireEvent.keyDown(window, { key: "d", ctrlKey: true, repeat: true });

    expect(explorer.setSearchMode).toHaveBeenCalledTimes(1);
    expect(explorer.setSearchMode).toHaveBeenCalledWith("recursive");
  });

  it("a repeat press does NOT preventDefault (the browser default survives)", () => {
    const explorer = makeExplorerState({ searchQuery: "song" });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    const notCancelled = fireEvent.keyDown(window, {
      key: "d",
      ctrlKey: true,
      repeat: true,
    });

    // dispatchEvent returns true when nothing called preventDefault().
    expect(notCancelled).toBe(true);
    expect(explorer.setSearchMode).not.toHaveBeenCalled();
  });
});
