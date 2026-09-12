// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { QueuePanel } from "./QueuePanel";
import { usePlayerStore } from "../../store/playerStore";
import en from "../../locales/en/translation.json";

vi.mock("react-i18next", () => {
  // Resolve keys against the real en resources so assertions read the
  // shipped copy instead of hard-coded fallbacks.
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
      t: (key: string, fallback?: string) => resolveKey(key) ?? fallback ?? key,
    }),
  };
});

// jsdom has no layout, so the real virtualizer reports an empty range and
// renders nothing. Mock it to render every item — virtualization itself is
// covered by the MainContent windowing tests; here the rows are the subject.
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
          start: index * 56,
        })),
      getTotalSize: () => count * 56,
      measureElement: vi.fn(),
      scrollToIndex: vi.fn(),
    }),
  ),
}));

// queueOps persists through the kv store; the DB is out of scope here.
vi.mock("../../db/kv", () => ({
  set: vi.fn(() => Promise.resolve()),
}));

// MoreMenu owns dropdown/portal plumbing with its own test suite; the queue
// panel only mounts it per row.
vi.mock("../components/MoreMenu", () => ({ MoreMenu: () => null }));

function makeTrack(id: string, over: Partial<Track> = {}): Track {
  return {
    id,
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    streamUrl: `/drive-stream/${id}`,
    queueItemId: `q-${id}`,
    ...over,
  };
}

const T1 = makeTrack("t1");
const T2 = makeTrack("t2");
const T3 = makeTrack("t3");

function seedQueue(): void {
  usePlayerStore.setState({
    playbackQueue: [T1, T2, T3],
    originalQueue: [T1, T2, T3],
    currentTrack: T2,
    playMode: "normal",
  });
}

function renderPanel(open = true) {
  const onClose = vi.fn();
  const onSetPlayMode = vi.fn();
  const onSelectTrack = vi.fn();
  render(
    <QueuePanel
      open={open}
      onClose={onClose}
      onSetPlayMode={onSetPlayMode}
      onSelectTrack={onSelectTrack}
    />,
  );
  return { onClose, onSetPlayMode, onSelectTrack };
}

function rowFor(title: string): HTMLElement {
  const row = screen.getByText(title).closest('[data-testid="queue-row"]');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

beforeEach(() => {
  seedQueue();
});

afterEach(() => {
  cleanup();
  usePlayerStore.setState({
    playbackQueue: [],
    originalQueue: [],
    currentTrack: null,
    playMode: "normal",
  });
});

describe("QueuePanel", () => {
  it("open=false → không render dialog", () => {
    renderPanel(false);
    expect(screen.queryByTestId("queue-panel")).toBeNull();
  });

  it("render đủ tracks; row current có aria-current và click KHÔNG gọi onSelectTrack; row khác click → onSelectTrack(track)", () => {
    const { onSelectTrack } = renderPanel();

    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);
    const currentRow = rowFor("Song t2");
    expect(currentRow.getAttribute("aria-current")).toBe("true");

    fireEvent.click(currentRow);
    expect(onSelectTrack).not.toHaveBeenCalled();

    fireEvent.click(rowFor("Song t1"));
    expect(onSelectTrack).toHaveBeenCalledTimes(1);
    expect(onSelectTrack).toHaveBeenCalledWith(T1);
  });

  it("search accent-insensitive ('co' match 'Có…') và no_results khi không khớp", () => {
    const accented = makeTrack("a1", {
      title: "Có Chàng Trai Viết Lên Cây",
      artist: "Phan Mạnh Quỳnh",
      queueItemId: "q-a1",
    });
    usePlayerStore.setState({
      playbackQueue: [accented, T2, T3],
      originalQueue: [accented, T2, T3],
      currentTrack: T2,
    });
    renderPanel();

    const input = screen.getByPlaceholderText(en.queue.search_placeholder);
    fireEvent.change(input, { target: { value: "co" } });

    expect(screen.getAllByTestId("queue-row")).toHaveLength(1);
    expect(screen.getByText("Có Chàng Trai Viết Lên Cây")).toBeTruthy();

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.queryAllByTestId("queue-row")).toHaveLength(0);
    expect(screen.getByText(en.queue.no_results)).toBeTruthy();
  });

  it("mode selector: aria-pressed đúng theo playMode; click shuffle → onSetPlayMode('shuffle')", () => {
    const { onSetPlayMode } = renderPanel();

    expect(
      screen
        .getByRole("button", { name: en.queue.mode_normal })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: en.queue.mode_shuffle })
        .getAttribute("aria-pressed"),
    ).toBe("false");

    fireEvent.click(
      screen.getByRole("button", { name: en.queue.mode_shuffle }),
    );
    expect(onSetPlayMode).toHaveBeenCalledTimes(1);
    expect(onSetPlayMode).toHaveBeenCalledWith("shuffle");
  });

  it("selection: checkbox chỉ ở row không phải current; bulk remove xoá đúng 2 item, giữ current, thoát selection mode", () => {
    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: en.queue.select_multiple }),
    );

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);

    fireEvent.click(checkboxes[0] as HTMLElement);
    fireEvent.click(checkboxes[1] as HTMLElement);

    fireEvent.click(screen.getByTestId("queue-remove-selected"));

    const state = usePlayerStore.getState();
    expect(state.playbackQueue).toEqual([T2]);
    expect(state.originalQueue).toEqual([T2]);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByTestId("queue-selection-toolbar")).toBeNull();
  });

  it("queue rỗng → hiện queue.empty (khác no_results)", () => {
    usePlayerStore.setState({
      playbackQueue: [],
      originalQueue: [],
      currentTrack: null,
    });
    renderPanel();

    expect(screen.getByText(en.queue.empty)).toBeTruthy();
    expect(screen.queryByText(en.queue.no_results)).toBeNull();
  });

  it("Escape → onClose; click overlay → onClose; click trong dialog → không đóng", () => {
    const { onClose } = renderPanel();
    const dialog = screen.getByTestId("queue-panel");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const overlay = dialog.parentElement as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
