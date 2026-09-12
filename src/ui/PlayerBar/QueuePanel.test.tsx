// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { TABS } from "../../utils/driveConstants";
import { QueuePanel } from "./QueuePanel";
import type { QueuePanelProps } from "./QueuePanel";
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

type ResizeCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver,
) => void;

// jsdom ships no ResizeObserver. The stub captures the callbacks so a test
// can simulate a layout change after mounting a measurable header.
let resizeCallbacks: ResizeCallback[] = [];

class ResizeObserverStub {
  constructor(callback: ResizeCallback) {
    resizeCallbacks.push(callback);
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function triggerResize(): void {
  for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
}

// jsdom implements no layout: offsetParent is always null and offsetHeight 0.
// Tests define both explicitly to mimic a rendered sticky header.
function mountHeader(
  container: HTMLElement,
  height: number,
  visible = true,
): HTMLElement {
  const header = document.createElement("div");
  header.setAttribute("data-view-header", "");
  Object.defineProperty(header, "offsetHeight", {
    configurable: true,
    value: height,
  });
  Object.defineProperty(header, "offsetParent", {
    configurable: true,
    value: visible ? document.body : null,
  });
  container.appendChild(header);
  return header;
}

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

function makeProps(open: boolean): QueuePanelProps {
  return {
    open,
    onClose: vi.fn(),
    onSetPlayMode: vi.fn(),
    onSelectTrack: vi.fn(),
    activeTab: TABS.home,
  };
}

function renderPanel(open = true) {
  const props = makeProps(open);
  const view = render(<QueuePanel {...props} />);
  return { props, view };
}

function rowFor(title: string): HTMLElement {
  const row = screen.getByText(title).closest('[data-testid="queue-row"]');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  seedQueue();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  usePlayerStore.setState({
    playbackQueue: [],
    originalQueue: [],
    currentTrack: null,
    playMode: "normal",
  });
});

describe("QueuePanel drawer shell", () => {
  it("chưa từng mở → shell nằm ngoài mép phải, aria-hidden + inert, KHÔNG render nội dung", () => {
    renderPanel(false);

    const pane = screen.getByTestId("queue-panel");
    expect(pane.className).toContain("translate-x-full");
    expect(pane.getAttribute("aria-hidden")).toBe("true");
    expect(pane.hasAttribute("inert")).toBe(true);
    expect(screen.queryByTestId("queue-overlay")).toBeNull();
    // QueuePanelDialog is lazy: nothing inside the shell before the first open.
    expect(screen.queryByText(en.queue.title)).toBeNull();
  });

  it("open=true → nội dung render, translate-x-0, bỏ overlay/backdrop", () => {
    renderPanel(true);

    const pane = screen.getByTestId("queue-panel");
    expect(pane.className).toContain("translate-x-0");
    expect(pane.className).not.toContain("translate-x-full");
    expect(pane.getAttribute("aria-hidden")).toBe("false");
    expect(pane.hasAttribute("inert")).toBe(false);
    expect(pane.className).not.toContain("backdrop-blur");
    expect(screen.queryByTestId("queue-overlay")).toBeNull();
    expect(screen.getByText(en.queue.title)).toBeTruthy();
  });

  it("đóng sau khi mở → nội dung VẪN mount (exit animation) + trượt ra ngoài", () => {
    const { props, view } = renderPanel(true);
    expect(screen.getByText(en.queue.title)).toBeTruthy();

    view.rerender(<QueuePanel {...props} open={false} />);

    const pane = screen.getByTestId("queue-panel");
    expect(pane.className).toContain("translate-x-full");
    expect(pane.getAttribute("aria-hidden")).toBe("true");
    expect(pane.hasAttribute("inert")).toBe(true);
    expect(screen.getByText(en.queue.title)).toBeTruthy();
  });
});

describe("QueuePanel top offset (sticky view header)", () => {
  it("top = chiều cao header ĐANG HIỂN THỊ (bỏ qua header ẩn của view keep-alive)", () => {
    const { view } = renderPanel(true);

    mountHeader(view.container, 50, false);
    mountHeader(view.container, 80, true);

    act(() => {
      triggerResize();
    });

    expect(screen.getByTestId("queue-panel").style.top).toBe("80px");
  });

  it("không có header hiển thị → top = 0px", () => {
    const { view } = renderPanel(true);
    expect(screen.getByTestId("queue-panel").style.top).toBe("0px");

    mountHeader(view.container, 50, false);
    act(() => {
      triggerResize();
    });

    expect(screen.getByTestId("queue-panel").style.top).toBe("0px");
  });
});

describe("QueuePanel content", () => {
  it("render đủ tracks; row current có aria-current và click KHÔNG gọi onSelectTrack; row khác click → onSelectTrack(track)", () => {
    const { props } = renderPanel();

    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);
    const currentRow = rowFor("Song t2");
    expect(currentRow.getAttribute("aria-current")).toBe("true");

    fireEvent.click(currentRow);
    expect(props.onSelectTrack).not.toHaveBeenCalled();

    fireEvent.click(rowFor("Song t1"));
    expect(props.onSelectTrack).toHaveBeenCalledTimes(1);
    expect(props.onSelectTrack).toHaveBeenCalledWith(T1);
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
    const { props } = renderPanel();

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
    expect(props.onSetPlayMode).toHaveBeenCalledTimes(1);
    expect(props.onSetPlayMode).toHaveBeenCalledWith("shuffle");
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

  it("Escape → onClose chỉ khi pane đang mở; click trong pane KHÔNG đóng", () => {
    const { props } = renderPanel(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("queue-panel"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape khi pane đã đóng → KHÔNG gọi onClose", () => {
    const { props, view } = renderPanel(true);
    view.rerender(<QueuePanel {...props} open={false} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("QueuePanel flat rows (không hiệu ứng khối) + 1 nút close", () => {
  it("drawer chỉ còn 1 nút close (X), không có nút Close footer", () => {
    renderPanel(true);

    expect(
      screen.getAllByRole("button", { name: en.settings.close }),
    ).toHaveLength(1);
  });

  it("hàng queue phẳng, không hiệu ứng khối", () => {
    renderPanel(true);

    const row = rowFor("Song t1");
    expect(row.className).not.toContain("hover:-translate-y-1");
    expect(row.className).not.toContain("shadow-md");
    expect(row.className).not.toContain("bg-[#F8F9FA]");
    expect(row.className).toContain("hover:bg-gray-100");
    expect(row.style.height).toBe("56px");
  });
});
