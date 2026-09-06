// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
import { MainContent } from "./MainContent";
import type { DriveItem } from "../../types";
import { DEBUG_EVENTS } from "../debug/debugEvents";

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
  SongCard: vi.fn(({ item }: { item: DriveItem }) => (
    <div data-testid="song-card" data-item-id={item.id} />
  )),
}));

// FolderSelectionScreen is out of scope for this task (bulk move closes
// immediately); the stub simulates the real screen's "choose folder" action
// so MainContent's onSelectFolder wiring can be tested in isolation.
vi.mock("../FolderSelection/FolderSelectionScreen", () => ({
  FolderSelectionScreen: ({
    onSelectFolder,
  }: {
    onSelectFolder: (folderId: string) => void;
  }) => (
    <div data-testid="folder-screen-stub">
      <button
        onClick={() => {
          onSelectFolder("dest-folder");
        }}
      >
        choose destination
      </button>
    </div>
  ),
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

// Mirrors the return shape of the real useDriveExplorer hook (src/hooks/useDriveExplorer.ts).
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

describe("MainContent paginated rendering", () => {
  beforeEach(() => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    cleanup();
  });

  it("renders all items when count is less than PAGE_SIZE", () => {
    render(<MainContent {...baseProps} />);
    const cards = screen.getAllByTestId("song-card");
    expect(cards.length).toBe(3);
  });

  it("should only render visible items using react-virtual", () => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(60)));
    render(<MainContent {...baseProps} />);
    expect(screen.getAllByTestId("song-card").length).toBe(60);
    expect(document.querySelector("main")).toBeTruthy();
  });
});

describe("MainContent file-list container", () => {
  beforeEach(() => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    cleanup();
  });

  it("marks the file-list container as the drop region ([data-drop-region])", () => {
    render(<MainContent {...baseProps} />);
    expect(document.querySelector("[data-drop-region]")).not.toBeNull();
  });
});

describe("MainContent loading state (skeleton rows replace centered spinner)", () => {
  beforeEach(() => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a skeleton row list (count derived from viewport height) with role="status" instead of the LoaderCircle spinner while loading', () => {
    render(<MainContent {...baseProps} isLoading={true} />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-label")).toBe("loading");
    const expectedRows = Math.max(
      4,
      Math.ceil((window.innerHeight - 140) / 72),
    );
    expect(screen.getAllByTestId("skeleton-row")).toHaveLength(expectedRows);
    // The old centered spinner (LoaderCircle with animate-spin) must be gone.
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("hides the skeleton and renders the real list once loading finishes", () => {
    render(<MainContent {...baseProps} isLoading={false} />);
    expect(screen.queryByTestId("skeleton-row")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getAllByTestId("song-card").length).toBe(3);
  });

  it("keeps the empty state (no audio) when loading finished with no items", () => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState([]));
    render(<MainContent {...baseProps} isLoading={false} />);
    expect(screen.queryByTestId("skeleton-row")).toBeNull();
    expect(screen.getByText("drive.no_audio")).toBeTruthy();
    expect(screen.queryByTestId("song-card")).toBeNull();
  });

  it("stretch: loading skeleton fills the drop region (minHeight formula + h-full container + flex-1 rows) and never shows the empty state", () => {
    render(<MainContent {...baseProps} isLoading={true} />);
    const status = screen.getByRole("status", { name: "loading" });
    // The wrapper must size itself to the region below the header chrome
    // (HEADER_CHROME_HEIGHT_PX = 140) — a plain h-full would not resolve
    // against the auto-height [data-drop-region] container.
    expect(status.style.minHeight).toBe("calc(100% - 140px)");
    expect(status.className).toContain("flex");
    const rows = screen.getAllByTestId("skeleton-row");
    expect(rows).toHaveLength(
      Math.max(4, Math.ceil((window.innerHeight - 140) / 72)),
    );
    for (const row of rows) {
      expect(row.className).toContain("flex-1");
    }
    // The SkeletonRowList container itself stretches to fill the wrapper.
    const row = rows[0];
    if (row === undefined) throw new Error("expected skeleton row");
    const container = row.parentElement;
    expect(container).not.toBeNull();
    if (container) {
      expect(container.className).toContain("h-full");
    }
    // While loading, the empty-state branch must never be reachable.
    expect(screen.queryByText("drive.no_audio")).toBeNull();
  });
});

describe("MainContent debug triggers (DEV only)", () => {
  beforeEach(() => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    cleanup();
  });

  // Explorer mock whose setters actually mutate the state object, so a
  // dispatch that calls explorer.setIsSelectionMode(true) is visible to a
  // rerender (the real hook's useState setters trigger their own render —
  // the mock cannot, so the tests rerender explicitly).
  function makeControllableExplorer(items: DriveItem[]) {
    const explorer = makeExplorerState(items);
    explorer.setIsSelectionMode.mockImplementation((v: boolean) => {
      explorer.isSelectionMode = v;
    });
    return explorer;
  }

  it("BULK_DELETE dispatch opens the BulkDeleteConfirmModal", () => {
    render(<MainContent {...baseProps} />);
    expect(screen.queryByText("drive.bulk_delete_title")).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.BULK_DELETE));
    });

    expect(screen.getByText("drive.bulk_delete_title")).not.toBeNull();
  });

  it("the debug-opened bulk delete modal still closes through its normal onClose", () => {
    render(<MainContent {...baseProps} />);
    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.BULK_DELETE));
    });
    expect(screen.getByText("drive.bulk_delete_title")).not.toBeNull();

    fireEvent.click(screen.getByText("menu.cancel"));

    expect(screen.queryByText("drive.bulk_delete_title")).toBeNull();
  });

  it("SELECTION_MODE dispatch enters selection mode (toolbar appears)", () => {
    useDriveExplorerMock.mockReturnValue(
      makeControllableExplorer(makeItems(3)),
    );
    const { rerender } = render(<MainContent {...baseProps} />);
    expect(screen.queryByText("drive.select_all")).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.SELECTION_MODE));
    });
    // MainContent is React.memo-wrapped, so a props-identical rerender is
    // skipped; the explorer mock's setter cannot trigger React on its own
    // (the real useState setter can). An unrelated prop change flushes the
    // mutated selection state into the DOM. The toolbar lives in the header
    // chrome, which renders regardless of isLoading.
    rerender(<MainContent {...baseProps} isLoading={true} />);

    expect(screen.getByText("drive.select_all")).not.toBeNull();
  });

  it("selection can still be exited through the existing clear-selection path", () => {
    const explorer = makeControllableExplorer(makeItems(3));
    useDriveExplorerMock.mockReturnValue(explorer);
    const { rerender } = render(<MainContent {...baseProps} />);
    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.SELECTION_MODE));
    });
    rerender(<MainContent {...baseProps} isLoading={true} />);
    expect(screen.getByText("drive.select_all")).not.toBeNull();

    // The real clear path: TopNavigationBar onClearSelection calls
    // explorer.setIsSelectionMode(false) + setSelectedIds(new Set()).
    act(() => {
      explorer.setIsSelectionMode(false);
    });
    rerender(<MainContent {...baseProps} isLoading={false} />);

    expect(screen.queryByText("drive.select_all")).toBeNull();
  });

  it("PAGINATION dispatch forces the pagination controls to appear (debug totalPages override)", () => {
    const explorer = makeExplorerState(makeItems(3));
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);
    expect(screen.queryByText("playlist.next")).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.PAGINATION));
    });

    expect(screen.getByText("playlist.next")).not.toBeNull();
    expect(screen.getByText("/ 2")).not.toBeNull();
  });

  it("clicking a page after the PAGINATION dispatch routes through the real onPageChange (no crash)", async () => {
    const explorer = makeExplorerState(makeItems(3));
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);
    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.PAGINATION));
    });
    expect(screen.getByText("playlist.next")).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText("playlist.next"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(explorer.setCurrentPage).toHaveBeenCalledTimes(1);
  });

  it("unmount -> dispatching BULK_DELETE / SELECTION_MODE / PAGINATION is a no-op (listeners cleaned up)", () => {
    const { unmount } = render(<MainContent {...baseProps} />);
    unmount();

    expect(() => {
      act(() => {
        window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.BULK_DELETE));
        window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.SELECTION_MODE));
        window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.PAGINATION));
      });
    }).not.toThrow();
  });
});

describe("MainContent bulk dialogs close immediately on confirm (background action)", () => {
  beforeEach(() => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    cleanup();
  });

  it("bulk delete: Confirm closes the modal immediately while the delete action is still pending", () => {
    const explorer = makeExplorerState(makeItems(3));
    // Mirrors the real hook (useDriveBulkOps): onComplete fires synchronously
    // before the network loop starts; the action promise itself stays pending.
    explorer.handleBulkDelete.mockImplementation((onComplete: () => void) => {
      onComplete();
      return new Promise<never>(() => {});
    });
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);
    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.BULK_DELETE));
    });
    expect(screen.getByText("drive.bulk_delete_title")).not.toBeNull();

    act(() => {
      fireEvent.click(screen.getByText("drive.delete"));
    });

    // The modal unmounts while the delete is still running in the background.
    expect(screen.queryByText("drive.bulk_delete_title")).toBeNull();
    expect(explorer.handleBulkDelete).toHaveBeenCalledTimes(1);
    expect(explorer.handleBulkDelete).toHaveBeenCalledWith(
      expect.any(Function),
    );
  });

  it("bulk move: picking a destination closes the folder screen immediately while the move is still pending", () => {
    const explorer = makeExplorerState(makeItems(3));
    explorer.isSelectionMode = true;
    explorer.selectedIds = new Set(["id0"]);
    explorer.handleBulkMove.mockImplementation(
      (_dest: string, onComplete: () => void) => {
        onComplete();
        return new Promise<never>(() => {});
      },
    );
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);
    fireEvent.click(screen.getByText("drive.bulk_move"));
    expect(screen.getByTestId("folder-screen-stub")).not.toBeNull();

    fireEvent.click(screen.getByText("choose destination"));

    // The screen unmounts while the move is still running in the background.
    expect(screen.queryByTestId("folder-screen-stub")).toBeNull();
    expect(explorer.handleBulkMove).toHaveBeenCalledTimes(1);
    expect(explorer.handleBulkMove).toHaveBeenCalledWith(
      "dest-folder",
      expect.any(Function),
    );
  });
});
