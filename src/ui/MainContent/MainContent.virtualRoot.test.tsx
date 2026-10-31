// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MainContent } from "./MainContent";
import type { DriveItem } from "../../types";
import { VIRTUAL_ROOT_ID, VIRTUAL_ROOT_NAME } from "../../utils/driveConstants";

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
  SongCard: ({
    item,
    hideMenu,
    hideColumns,
    onOpenFolder,
  }: {
    item: DriveItem;
    hideMenu?: boolean;
    hideColumns?: boolean;
    onOpenFolder: (id: string, name: string, parentId?: string) => void;
  }) => (
    <button
      type="button"
      data-testid="song-card"
      data-item-id={item.id}
      data-hide-menu={String(hideMenu)}
      data-hide-columns={String(hideColumns)}
      onClick={() => {
        onOpenFolder(item.id, item.title, item.parentId);
      }}
    />
  ),
}));

vi.mock("../FolderSelection/FolderSelectionScreen", () => ({
  FolderSelectionScreen: () => <div data-testid="folder-screen-stub" />,
}));

function makeRootItems(): DriveItem[] {
  return [
    {
      id: "root-A",
      title: "Root A",
      isFolder: true,
      parentId: VIRTUAL_ROOT_ID,
    },
    {
      id: "root-B",
      title: "Root B",
      isFolder: true,
      parentId: VIRTUAL_ROOT_ID,
    },
  ];
}

function makeFileItems(): DriveItem[] {
  return [
    {
      id: "file-1",
      title: "Song 1",
      isFolder: false,
      trackInfo: {
        id: "file-1",
        title: "Song 1",
        artist: "",
        streamUrl: "",
        size: 1000,
        originalName: "song1.mp3",
      },
    },
  ];
}

function makeExplorerState(items: DriveItem[], isVirtualRoot: boolean) {
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
    isVirtualRoot,
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

describe("MainContent virtual root (multi-root)", () => {
  afterEach(() => {
    cleanup();
  });

  it("hides New Folder + selection UI, row menus and the Date/Size columns, but keeps root rows clickable", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState(makeRootItems(), true),
    );

    render(
      <MainContent
        {...baseProps}
        currentFolderId={VIRTUAL_ROOT_ID}
        currentFolderName={VIRTUAL_ROOT_NAME}
      />,
    );

    expect(screen.queryByText("drive.new_folder")).toBeNull();
    expect(screen.queryByText("drive.select_all")).toBeNull();

    const cards = screen.getAllByTestId("song-card");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.getAttribute("data-hide-menu")).toBe("true");
      // Root rows have no real date/size and the header is hidden here, so the
      // two "—" column placeholders must be suppressed too.
      expect(card.getAttribute("data-hide-columns")).toBe("true");
    }

    fireEvent.click(cards[0] as HTMLElement);
    expect(baseProps.onOpenFolder).toHaveBeenCalledWith(
      "root-A",
      "Root A",
      VIRTUAL_ROOT_ID,
    );
  });
});

describe("MainContent normal folder (virtual root off)", () => {
  beforeEach(() => {
    baseProps.onOpenFolder.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the New Folder button and row menus (and columns) for a real folder", () => {
    useDriveExplorerMock.mockReturnValue(
      makeExplorerState(makeFileItems(), false),
    );

    render(<MainContent {...baseProps} currentFolderId="folder-1" />);

    expect(screen.getByText("drive.new_folder")).toBeTruthy();
    const card = screen.getByTestId("song-card");
    expect(card.getAttribute("data-hide-menu")).toBe("false");
    expect(card.getAttribute("data-hide-columns")).toBe("false");
  });
});
