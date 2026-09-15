// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MainContent } from "./MainContent";
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

describe("MainContent Escape exits selection mode (slice A)", () => {
  beforeEach(() => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    cleanup();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  it("Esc outside any input while selection is on resets selection (2-line reset)", () => {
    const explorer = makeExplorerState(makeItems(3));
    explorer.isSelectionMode = true;
    explorer.selectedIds = new Set(["id0", "id1"]);
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);
    // Focus is on body (outside every input).
    expect(document.activeElement?.tagName).not.toBe("INPUT");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(explorer.setSelectedIds).toHaveBeenCalledTimes(1);
    expect(explorer.setSelectedIds).toHaveBeenCalledWith(new Set());
    expect(explorer.setIsSelectionMode).toHaveBeenCalledTimes(1);
    expect(explorer.setIsSelectionMode).toHaveBeenCalledWith(false);
  });

  it("Esc in the search input keeps the old behavior (blur + clear) and does not exit selection in the same press", () => {
    const explorer = makeExplorerState(makeItems(3));
    explorer.searchQuery = "hello";
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);
    const searchInput = screen.getByPlaceholderText("search_placeholder");
    searchInput.focus();
    expect(document.activeElement).toBe(searchInput);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(document.activeElement).not.toBe(searchInput);
    expect(explorer.setSearchQuery).toHaveBeenCalledWith("");
    expect(explorer.setIsSelectionMode).not.toHaveBeenCalled();
    expect(explorer.setSelectedIds).not.toHaveBeenCalled();
  });

  it("Esc outside any input while selection is off is a no-op", () => {
    const explorer = makeExplorerState(makeItems(3));
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(explorer.setIsSelectionMode).not.toHaveBeenCalled();
    expect(explorer.setSelectedIds).not.toHaveBeenCalled();
  });

  it("Esc inside a non-search input does not trigger the search-clear path (no double-fire)", () => {
    const explorer = makeExplorerState(makeItems(3));
    useDriveExplorerMock.mockReturnValue(explorer);
    render(
      <div>
        <MainContent {...baseProps} />
        <input data-testid="foreign-input" type="text" />
      </div>,
    );
    const foreign = screen.getByTestId("foreign-input");
    foreign.focus();
    expect(document.activeElement).toBe(foreign);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(explorer.setSearchQuery).not.toHaveBeenCalledWith("");
    expect(explorer.setIsSelectionMode).not.toHaveBeenCalled();
    expect(explorer.setSelectedIds).not.toHaveBeenCalled();
  });
});

describe("MainContent keyboard overlay guards (UMK-1/2/4 fix 2026-09-14)", () => {
  beforeEach(() => {
    useDriveExplorerMock.mockReturnValue(makeExplorerState(makeItems(3)));
  });

  afterEach(() => {
    cleanup();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  // Opens the real BulkDeleteConfirmModal through the real toolbar button so
  // the background keyboard handler stands down for a real overlay: it owns
  // an Escape handler (capture) AND the background handler bails on its own
  // overlay guard (useMainContentKeyboard's showBulkDeleteConfirm flag).
  function renderWithBulkDeleteModalOpen() {
    const explorer = makeExplorerState(makeItems(3));
    explorer.isSelectionMode = true;
    explorer.selectedIds = new Set(["id0", "id1"]);
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);
    fireEvent.click(screen.getByText("drive.delete"));
    expect(screen.getByText("drive.bulk_delete_title")).toBeTruthy();
    return explorer;
  }

  it("UMK-1: Escape while the bulk-delete confirm is open does not exit selection behind the modal", () => {
    const explorer = renderWithBulkDeleteModalOpen();
    expect(document.activeElement?.tagName).not.toBe("INPUT");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(explorer.setSelectedIds).not.toHaveBeenCalled();
    expect(explorer.setIsSelectionMode).not.toHaveBeenCalled();
  });

  it("Esc trong bulk-delete modal: modal đóng + focus về nút Delete + selection giữ nguyên", () => {
    const explorer = makeExplorerState(makeItems(3));
    explorer.isSelectionMode = true;
    explorer.selectedIds = new Set(["id0", "id1"]);
    useDriveExplorerMock.mockReturnValue(explorer);
    render(<MainContent {...baseProps} />);

    const deleteButton = screen.getByRole("button", { name: "drive.delete" });
    deleteButton.focus();
    fireEvent.click(deleteButton);
    expect(screen.getByText("drive.bulk_delete_title")).toBeTruthy();

    // Focus inside the modal, so the APG focus-return is actually exercised
    // (not a focus already sitting on the invoker).
    const cancelButton = screen.getByText("menu.cancel");
    cancelButton.focus();
    expect(document.activeElement).toBe(cancelButton);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByText("drive.bulk_delete_title")).toBeNull();
    expect(document.activeElement).toBe(deleteButton);
    expect(explorer.setSelectedIds).not.toHaveBeenCalled();
    expect(explorer.setIsSelectionMode).not.toHaveBeenCalled();
  });

  it("UMK-2: Ctrl+F matches the upper-case key reported under CapsLock/Shift", () => {
    render(<MainContent {...baseProps} />);
    const searchInput = screen.getByPlaceholderText("search_placeholder");

    fireEvent.keyDown(window, { key: "F", ctrlKey: true });

    expect(document.activeElement).toBe(searchInput);
  });

  it("UMK-4: Ctrl+F while the modal is open does not pull focus to the background search input", () => {
    render(<MainContent {...baseProps} />);
    const searchInput = screen.getByPlaceholderText("search_placeholder");
    // New Folder modal (search input still present in the background, so the
    // focus-steal is observable).
    fireEvent.click(screen.getByText("drive.new_folder"));
    const nameInput = screen.getByPlaceholderText(
      "drive.folder_name_placeholder",
    );
    nameInput.focus();
    expect(document.activeElement).toBe(nameInput);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    expect(document.activeElement).toBe(nameInput);
    expect(document.activeElement).not.toBe(searchInput);
  });
});
