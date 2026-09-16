// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import type { QueueViewItem } from "./queueView";
import { QueueList } from "./QueueList";
import type { QueueListProps } from "./QueueList";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string): string => key }),
}));

// jsdom has no layout, so the real virtualizer renders nothing. Mock it to
// render every item (same harness as VirtualizedSongList.test/QueuePanel.test);
// virtualization itself is covered elsewhere and is not the subject here.
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
          start: index * 84,
        })),
      getTotalSize: () => count * 84,
      measureElement: vi.fn(),
      scrollToIndex: vi.fn(),
    }),
  ),
}));

// Row content is a separate unit (QueueRow/QueuePanel suites); the subject
// here is the focus-modality ring QueueList puts on the row wrapper, so stub
// the children to keep the metadata/auth/menu chain out of this file.
vi.mock("./QueueRow", () => ({
  QUEUE_ROW_HEIGHT: 84,
  QueueRow: () => null,
}));
vi.mock("./QueueFolderRow", () => ({
  QueueFolderRow: () => null,
}));

function makeTrack(id: string): Track {
  return {
    id,
    title: `Song ${id}`,
    artist: "",
    streamUrl: "",
    queueItemId: `q-${id}`,
  };
}

function makeItems(): QueueViewItem[] {
  return [
    { kind: "track", key: "q-t1", track: makeTrack("t1") },
    { kind: "track", key: "q-t2", track: makeTrack("t2") },
  ];
}

function renderQueue(overrides: Partial<QueueListProps> = {}) {
  const props: QueueListProps = {
    items: makeItems(),
    currentTrack: null,
    selectionMode: false,
    selected: new Set<string>(),
    emptyText: "empty",
    onSelectTrack: vi.fn(),
    onToggleSelected: vi.fn(),
    onRemoveFromQueue: vi.fn(),
    onRemoveFolderFromQueue: vi.fn(),
    onOpenFolder: vi.fn(),
    ...overrides,
  };
  const view = render(<QueueList {...props} />);
  return { props, view };
}

function rowAt(index: number): HTMLElement {
  const row = screen.getAllByRole("row")[index];
  if (!row) throw new Error(`missing row ${String(index)}`);
  return row;
}

afterEach(() => {
  cleanup();
});

describe("QueueList focus ring theo modality (Slice B)", () => {
  it("B1: focus nguồn chuột (pointerdown trên grid) → KHÔNG ring, active vẫn được set", () => {
    renderQueue();

    const grid = screen.getByRole("grid");
    fireEvent.pointerDown(grid);
    fireEvent.focus(grid);

    expect(grid.getAttribute("aria-activedescendant")).toBe("queue-option-0");
    expect(rowAt(0).className).not.toContain("ring-2");
  });

  it("B2: focus nguồn bàn phím (không pointerdown) → ring trên active row", () => {
    renderQueue();

    fireEvent.focus(screen.getByRole("grid"));

    expect(rowAt(0).className).toContain("ring-2");
  });

  it("B3: blur → ring biến mất", () => {
    renderQueue();

    const grid = screen.getByRole("grid");
    fireEvent.focus(grid);
    expect(rowAt(0).className).toContain("ring-2");

    fireEvent.blur(grid);
    expect(rowAt(0).className).not.toContain("ring-2");
  });

  it("B4: sau pointer interaction, focus bàn phím kế tiếp vẫn ring (không stale flag)", async () => {
    renderQueue();

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
