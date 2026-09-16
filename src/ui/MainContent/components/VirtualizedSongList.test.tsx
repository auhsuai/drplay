// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, RefObject, SetStateAction } from "react";
import type { DriveItem } from "../../../types";
import en from "../../../locales/en/translation.json";
import { VirtualizedSongList } from "./VirtualizedSongList";

// Resolve keys against the real en resources (same harness as QueuePanel.test):
// assertions read the shipped copy instead of hard-coded fallbacks.
vi.mock("react-i18next", () => {
  const resolveKey = (key: string): string | undefined => {
    let acc: unknown = en;
    for (const part of key.split(".")) {
      if (typeof acc === "object" && acc !== null) {
        acc = (acc as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return typeof acc === "string" ? acc : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string, fallback?: unknown): string =>
        resolveKey(key) ?? (typeof fallback === "string" ? fallback : key),
    }),
    // MoreMenu's import chain reaches src/i18n, which calls
    // i18n.use(initReactI18next) — stub it like SongCard.test does.
    initReactI18next: { type: "3rdParty", init: () => {} },
  };
});

// jsdom has no layout, so the real virtualizer renders nothing. Mock it to
// render every item (virtualization itself is covered by the MainContent
// windowing tests); the rows are the subject here. scrollToIndex is shared
// across per-render virtualizer objects so the keyboard model can assert it.
const scrollToIndexSpy = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn(
    ({
      count,
      getItemKey,
    }: {
      count: number;
      getItemKey?: (index: number) => string | number;
    }) => ({
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          key: getItemKey ? getItemKey(index) : index,
          start: index * 92,
        })),
      getTotalSize: () => count * 92,
      measureElement: vi.fn(),
      scrollToIndex: scrollToIndexSpy,
      containerRef: { current: null },
    }),
  ),
}));

// Metadata loading (Drive API + debounce) is out of scope here; the card only
// needs a deterministic title so click/keyboard expectations stay stable.
vi.mock("../hooks/useSongCardMetadata", () => ({
  useSongCardMetadata: ({ item }: { item: DriveItem }) => ({
    meta: {
      title: item.title,
      artist: null,
      duration: 0,
      durationEstimated: false,
      size: 0,
      loaded: false,
    },
    coverUrl: null,
    clearCover: vi.fn(),
  }),
}));

function makeItem(index: number, over: Partial<DriveItem> = {}): DriveItem {
  return {
    id: `id${String(index)}`,
    title: `Song ${String(index)}`,
    isFolder: false,
    trackInfo: {
      id: `id${String(index)}`,
      title: `Song ${String(index)}`,
      artist: "",
      streamUrl: "",
      size: 1000,
      originalName: `song${String(index)}.mp3`,
    },
    ...over,
  };
}

function makeItems(count: number): DriveItem[] {
  return Array.from({ length: count }, (_, index) => makeItem(index));
}

const scrollElementRef: RefObject<HTMLElement | null> = { current: null };

type ListProps = ComponentProps<typeof VirtualizedSongList>;

function renderList(overrides: Partial<ListProps> = {}) {
  const props: ListProps = {
    items: makeItems(3),
    scrollElementRef,
    onPlay: vi.fn(),
    onOpenFolder: vi.fn(),
    token: "tok",
    currentFolderId: "root",
    currentFolderName: "Root",
    folderHistory: [],
    highlightedFileId: null,
    isPlaying: undefined,
    onRefresh: vi.fn(),
    isSelectionMode: false,
    selectedIds: new Set<string>(),
    setSelectedIds: vi.fn(),
    setIsSelectionMode: vi.fn(),
    onBulkMoveClick: vi.fn(),
    onBulkDeleteClick: vi.fn(),
    ...overrides,
  };
  const view = render(<VirtualizedSongList {...props} />);
  return { props, view };
}

function rowAt(index: number): HTMLElement {
  const row = screen.getAllByRole("row")[index];
  if (!row) throw new Error(`missing row ${String(index)}`);
  return row;
}

beforeEach(() => {
  scrollToIndexSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("VirtualizedSongList grid semantics (P2-03-2)", () => {
  it("container là grid có tên; mỗi item là row với aria-rowindex + gridcell", () => {
    renderList();

    const grid = screen.getByRole("grid", { name: en.drive.song_list });
    expect(grid.getAttribute("aria-rowcount")).toBe("3");
    expect(grid.getAttribute("aria-colcount")).toBe("1");
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3);
    rows.forEach((row, index) => {
      expect(row.getAttribute("aria-rowindex")).toBe(String(index + 1));
      expect(within(row).getAllByRole("gridcell")).toHaveLength(1);
    });
  });

  it("không selection mode: row đang phát aria-selected=true, không có aria-multiselectable", () => {
    renderList({ isPlaying: "id1" });

    expect(
      screen.getByRole("grid").getAttribute("aria-multiselectable"),
    ).toBeNull();
    expect(rowAt(1).getAttribute("aria-selected")).toBe("true");
    expect(rowAt(0).getAttribute("aria-selected")).toBe("false");
  });

  it("selection mode: aria-multiselectable=true + aria-selected theo selectedIds", () => {
    renderList({ isSelectionMode: true, selectedIds: new Set(["id1"]) });

    expect(screen.getByRole("grid").getAttribute("aria-multiselectable")).toBe(
      "true",
    );
    expect(rowAt(1).getAttribute("aria-selected")).toBe("true");
    expect(rowAt(0).getAttribute("aria-selected")).toBe("false");
  });

  it("focus vào grid → active bắt đầu từ row đang phát", () => {
    renderList({ isPlaying: "id1" });

    const grid = screen.getByRole("grid");
    expect(grid.getAttribute("aria-activedescendant")).toBeNull();

    fireEvent.focus(grid);
    expect(grid.getAttribute("aria-activedescendant")).toBe("song-row-1");
  });

  it("ArrowDown/Up (wrap), Home/End, PageDown/Up đổi active + scrollToIndex; focus quay về grid", () => {
    renderList({ items: makeItems(12) });

    const grid = screen.getByRole("grid");
    expect(grid.getAttribute("aria-activedescendant")).toBeNull();

    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("song-row-0");
    expect(scrollToIndexSpy).toHaveBeenLastCalledWith(0, { align: "auto" });

    fireEvent.keyDown(grid, { key: "End" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("song-row-11");

    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("song-row-0");

    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("song-row-11");

    fireEvent.keyDown(grid, { key: "PageUp" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("song-row-1");

    fireEvent.keyDown(grid, { key: "PageDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("song-row-11");

    fireEvent.keyDown(grid, { key: "Home" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("song-row-0");
    expect(document.activeElement).toBe(grid);
  });

  it("Enter/Space activate row đang active: folder → onOpenFolder, track → onPlay", () => {
    const folder = makeItem(0, {
      isFolder: true,
      trackInfo: undefined,
      title: "My Folder",
    });
    const { props } = renderList({ items: [folder, makeItem(1)] });

    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("song-row-0");

    fireEvent.keyDown(grid, { key: "Enter" });
    expect(props.onOpenFolder).toHaveBeenCalledWith("id0", "My Folder");

    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: " " });
    expect(props.onPlay).toHaveBeenCalledWith(
      expect.objectContaining({ id: "id1" }),
    );
  });

  it("folder có parentId (search hit) → activate truyền parentId như click SongCard", () => {
    const folder = makeItem(0, {
      isFolder: true,
      trackInfo: undefined,
      parentId: "parent-x",
    });
    const { props } = renderList({ items: [folder] });

    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "Enter" });

    expect(props.onOpenFolder).toHaveBeenCalledWith(
      "id0",
      "Song 0",
      "parent-x",
    );
  });

  it("selection mode: Enter trên track toggle selection thay vì play", () => {
    let selected = new Set<string>();
    const setSelectedIds = vi.fn(
      (updater: SetStateAction<Set<string>>): void => {
        selected = typeof updater === "function" ? updater(selected) : updater;
      },
    );
    const { props } = renderList({ isSelectionMode: true, setSelectedIds });

    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "Enter" });

    expect(selected.has("id0")).toBe(true);
    expect(props.onPlay).not.toHaveBeenCalled();
    expect(props.onOpenFolder).not.toHaveBeenCalled();
  });

  it("guard: phím trên control con (menu trigger) do menu xử lý, grid không điều hướng", () => {
    renderList();

    const menuTrigger = within(rowAt(0)).getByRole("button", {
      name: en.common.more_actions,
    });
    fireEvent.keyDown(menuTrigger, { key: "ArrowDown" });

    // The trigger consumed the key (APG: ArrowDown opens the menu)…
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    // …and the grid did not run its own navigation (no scrollToIndex).
    expect(scrollToIndexSpy).not.toHaveBeenCalled();
  });

  it("Enter trên card đang focus: card tự activate, grid KHÔNG activate lần hai", () => {
    const { props } = renderList();

    const card = within(rowAt(1)).getAllByRole("button")[0] as HTMLElement;
    fireEvent.keyDown(card, { key: "Enter" });

    expect(props.onPlay).toHaveBeenCalledTimes(1);
    expect(props.onPlay).toHaveBeenCalledWith(
      expect.objectContaining({ id: "id1" }),
    );
  });
});

describe("VirtualizedSongList focus ring theo modality (Slice B)", () => {
  it("B1: focus nguồn chuột (pointerdown trên grid) → KHÔNG ring, active vẫn được set", () => {
    renderList();

    const grid = screen.getByRole("grid");
    fireEvent.pointerDown(grid);
    fireEvent.focus(grid);

    expect(grid.getAttribute("aria-activedescendant")).toBe("song-row-0");
    expect(rowAt(0).className).not.toContain("ring-2");
  });

  it("B2: focus nguồn bàn phím (không pointerdown) → ring trên active row", () => {
    renderList();

    fireEvent.focus(screen.getByRole("grid"));

    expect(rowAt(0).className).toContain("ring-2");
  });

  it("B3: blur → ring biến mất", () => {
    renderList();

    const grid = screen.getByRole("grid");
    fireEvent.focus(grid);
    expect(rowAt(0).className).toContain("ring-2");

    fireEvent.blur(grid);
    expect(rowAt(0).className).not.toContain("ring-2");
  });

  it("B4: sau pointer interaction, focus bàn phím kế tiếp vẫn ring (không stale flag)", async () => {
    renderList();

    const grid = screen.getByRole("grid");
    fireEvent.pointerDown(grid);
    fireEvent.focus(grid);
    expect(rowAt(0).className).not.toContain("ring-2");

    fireEvent.blur(grid);
    // The pointer flag only lives for the pointerdown macrotask; flush it so
    // the next focus is a clean keyboard focus (the stale-flag regression).
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });

    fireEvent.focus(grid);
    expect(rowAt(0).className).toContain("ring-2");
  });
});
