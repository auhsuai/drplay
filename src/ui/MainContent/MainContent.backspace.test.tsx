// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MainContent } from "./MainContent";
import { MOVE_PICKER_OPEN_ATTR } from "../FolderSelection/FolderSelectionScreen";
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
  useTranslation: () => ({ t: (key: string) => key }),
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

function baseProps(over: Record<string, unknown> = {}) {
  return {
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
    ...over,
  };
}

function pressBackspace(init: Record<string, unknown> = {}) {
  fireEvent.keyDown(window, { key: "Backspace", ...init });
}

describe("MainContent Backspace = navigate back (slice B)", () => {
  beforeEach(() => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    cleanup();
    document.body.removeAttribute(MOVE_PICKER_OPEN_ATTR);
    for (const el of Array.from(
      document.body.querySelectorAll('[role="menu"]'),
    )) {
      el.remove();
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  it("Backspace with history navigates back exactly once", () => {
    const onBack = vi.fn();
    render(
      <MainContent
        {...baseProps({
          onBack,
          hasHistory: true,
          folderHistory: [{ id: "parent", name: "Parent" }],
        })}
      />,
    );

    pressBackspace();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("Backspace at folder root (no history) is a no-op", () => {
    const onBack = vi.fn();
    render(<MainContent {...baseProps({ onBack, hasHistory: false })} />);

    pressBackspace();

    expect(onBack).not.toHaveBeenCalled();
  });

  it("Backspace inside the search input is a no-op and keeps the text", () => {
    const onBack = vi.fn();
    const explorer = makeExplorerState(makeItems(3));
    explorer.searchQuery = "hello";
    useDriveExplorerMock.mockReturnValue(explorer);
    render(
      <MainContent
        {...baseProps({
          onBack,
          hasHistory: true,
          folderHistory: [{ id: "parent", name: "Parent" }],
        })}
      />,
    );
    const searchInput = screen.getByPlaceholderText("search_placeholder");
    searchInput.focus();
    expect(document.activeElement).toBe(searchInput);

    pressBackspace();

    expect(onBack).not.toHaveBeenCalled();
    expect(searchInput).toHaveValue("hello");
    expect(explorer.setSearchQuery).not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }])(
    "Backspace with modifier (%o) is a no-op",
    (mod) => {
      const onBack = vi.fn();
      render(
        <MainContent
          {...baseProps({
            onBack,
            hasHistory: true,
            folderHistory: [{ id: "parent", name: "Parent" }],
          })}
        />,
      );

      pressBackspace(mod);

      expect(onBack).not.toHaveBeenCalled();
    },
  );

  it("Backspace while the New Folder modal is open is a no-op", () => {
    const onBack = vi.fn();
    render(
      <MainContent
        {...baseProps({
          onBack,
          hasHistory: true,
          folderHistory: [{ id: "parent", name: "Parent" }],
        })}
      />,
    );
    // Open the modal through the real toolbar button, then move focus back to
    // body so the editable guard cannot mask the modal guard under test.
    fireEvent.click(screen.getByText("drive.new_folder"));
    const nameInput = screen.getByPlaceholderText(
      "drive.folder_name_placeholder",
    );
    expect(nameInput).toBeTruthy();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement?.tagName).not.toBe("INPUT");

    pressBackspace();

    expect(onBack).not.toHaveBeenCalled();
  });

  it("Backspace while NowPlaying is open (prop) is a no-op", () => {
    const onBack = vi.fn();
    render(
      <MainContent
        {...baseProps({
          onBack,
          hasHistory: true,
          folderHistory: [{ id: "parent", name: "Parent" }],
          isNowPlayingOpen: true,
        })}
      />,
    );

    pressBackspace();

    expect(onBack).not.toHaveBeenCalled();
  });

  it("Backspace while the move picker flag is set is a no-op (anti double-fire)", () => {
    const onBack = vi.fn();
    document.body.setAttribute(MOVE_PICKER_OPEN_ATTR, "true");
    render(
      <MainContent
        {...baseProps({
          onBack,
          hasHistory: true,
          folderHistory: [{ id: "parent", name: "Parent" }],
        })}
      />,
    );

    // The picker owns this press (it steps back internally); the main view
    // must stand down so onBack does not fire a second navigation.
    pressBackspace();

    expect(onBack).not.toHaveBeenCalled();
  });

  it("Backspace while a context menu is open is a no-op", () => {
    const onBack = vi.fn();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    render(
      <MainContent
        {...baseProps({
          onBack,
          hasHistory: true,
          folderHistory: [{ id: "parent", name: "Parent" }],
        })}
      />,
    );

    pressBackspace();

    expect(onBack).not.toHaveBeenCalled();
  });

  it("Backspace never touches search or selection (Esc's job)", () => {
    const explorer = makeExplorerState(makeItems(3));
    explorer.isSelectionMode = true;
    explorer.selectedIds = new Set(["id0"]);
    useDriveExplorerMock.mockReturnValue(explorer);
    const onBack = vi.fn();
    render(
      <MainContent
        {...baseProps({
          onBack,
          hasHistory: true,
          folderHistory: [{ id: "parent", name: "Parent" }],
        })}
      />,
    );

    pressBackspace();

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(explorer.setSearchQuery).not.toHaveBeenCalledWith("");
    expect(explorer.setSelectedIds).not.toHaveBeenCalled();
    expect(explorer.setIsSelectionMode).not.toHaveBeenCalled();
  });
});
