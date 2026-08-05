// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { MainContent } from "./MainContent";
import { DRAG_ACTIVE_EVENT } from "../components/DropZone";
import type { DriveItem } from "../../types";

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

vi.mock("../../utils/nextTrackPrefetcher", () => ({
  clearNextTrackPrefetches: vi.fn(),
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

// uploadManager stays REAL (isUploading drives Select All) except
// clearUploadedTint — spied so the unmount cleanup can be asserted.
const { clearUploadedTintMock } = vi.hoisted(() => ({
  clearUploadedTintMock: vi.fn(),
}));

vi.mock("../../utils/uploadManager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/uploadManager")>()),
  clearUploadedTint: clearUploadedTintMock,
}));

vi.mock("./components/SongCard", () => ({
  SongCard: vi.fn(({ item }: { item: DriveItem }) => (
    <div data-testid="song-card" data-item-id={item.id} />
  )),
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

describe("MainContent drag-active chrome hiding (DRAG_ACTIVE_EVENT)", () => {
  beforeEach(() => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    cleanup();
  });

  const dispatchDragActive = (active: boolean): void => {
    act(() => {
      window.dispatchEvent(
        new CustomEvent(DRAG_ACTIVE_EVENT, { detail: { active } }),
      );
    });
  };

  it("marks the file-list container as the drop region ([data-drop-region])", () => {
    render(<MainContent {...baseProps} />);
    expect(document.querySelector("[data-drop-region]")).not.toBeNull();
  });

  it("hides the header chrome (TopNavigationBar + SelectionToolbar) and pagination while dragging, restores on leave", () => {
    useDriveExplorerMock.mockReturnValue({
      ...makeExplorerState(makeItems(3)),
      totalPages: 3,
    });
    render(<MainContent {...baseProps} />);
    const chrome = screen.getByTestId("main-header-chrome");
    const pagination = screen.getByTestId("main-pagination-chrome");
    expect(chrome.className).toContain("opacity-100");
    expect(pagination.className).toContain("opacity-100");

    dispatchDragActive(true);
    expect(chrome.className).toContain("opacity-0");
    expect(chrome.className).toContain("pointer-events-none");
    expect(pagination.className).toContain("opacity-0");

    dispatchDragActive(false);
    expect(chrome.className).not.toContain("opacity-0");
    expect(pagination.className).not.toContain("opacity-0");
  });
});

describe("MainContent clears the uploaded tint on unmount (tab switch)", () => {
  beforeEach(() => {
    clearUploadedTintMock.mockClear();
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    cleanup();
  });

  it("calls clearUploadedTint when unmounting (leaving My Drive tab → every uploaded check disappears)", () => {
    const { unmount } = render(<MainContent {...baseProps} />);
    expect(clearUploadedTintMock).not.toHaveBeenCalled();
    unmount();
    expect(clearUploadedTintMock).toHaveBeenCalledTimes(1);
  });

  it("does not call clearUploadedTint while mounted", () => {
    render(<MainContent {...baseProps} />);
    expect(clearUploadedTintMock).not.toHaveBeenCalled();
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
