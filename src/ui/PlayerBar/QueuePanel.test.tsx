// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { TABS } from "../../utils/driveConstants";
import { QueuePanel } from "./QueuePanel";
import type { QueuePanelProps } from "./QueuePanel";
import { usePlayerStore } from "../../store/playerStore";
import { removeTracksByFolderFromQueue } from "../../store/queueOps";
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
  const interpolate = (value: string, options: unknown): string =>
    typeof options === "object" && options !== null
      ? value.replace(/\{\{(\w+)\}\}/g, (match, token: string) => {
          const replacement = (options as Record<string, unknown>)[token];
          return typeof replacement === "string" ||
            typeof replacement === "number"
            ? String(replacement)
            : match;
        })
      : value;
  return {
    useTranslation: () => ({
      // i18next parity for the shapes used here: plural suffix by count +
      // {{var}} interpolation (the queue renders counts via t(key, {count})).
      t: (key: string, options?: unknown): string => {
        const count =
          typeof options === "object" && options !== null
            ? (options as { count?: unknown }).count
            : undefined;
        const resolved =
          (typeof count === "number"
            ? resolveKey(`${key}_${count === 1 ? "one" : "other"}`)
            : undefined) ?? resolveKey(key);
        if (resolved !== undefined) return interpolate(resolved, options);
        return typeof options === "string" ? options : key;
      },
    }),
  };
});

// jsdom has no layout, so the real virtualizer reports an empty range and
// renders nothing. Mock it to render every item — virtualization itself is
// covered by the MainContent windowing tests; here the rows are the subject.
// Start/total stride mirrors QUEUE_ROW_HEIGHT (QueueRow) — bump together.
// scrollToIndex is shared across the per-render virtualizer objects so the
// keyboard model (QL-1) can be asserted on its calls.
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
          start: index * 84,
        })),
      getTotalSize: () => count * 84,
      measureElement: vi.fn(),
      scrollToIndex: scrollToIndexSpy,
    }),
  ),
}));

// queueOps persists through the kv store; the DB is out of scope here.
vi.mock("../../db/kv", () => ({
  set: vi.fn(() => Promise.resolve()),
}));

// MoreMenu's playlist submenu loads playlists from IndexedDB when a track
// menu opens; the DB is out of scope here (the menu's own suite covers it).
vi.mock("../../utils/playlists", () => ({
  getPlaylists: vi.fn(() => Promise.resolve([])),
  addTrackToPlaylist: vi.fn(() => Promise.resolve()),
}));

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
  scrollToIndexSpy.mockClear();
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

  it("header mount MUỘN (tab content lazy) → MutationObserver đo lại, top = chiều cao header", async () => {
    const { view } = renderPanel(true);
    // Home: chưa có header nào (tab lazy chưa mount) → top 0.
    expect(screen.getByTestId("queue-panel").style.top).toBe("0px");

    // MyDrive header mount SAU khi effect đo đã chạy; scope không đổi size
    // nên ResizeObserver không fire — chỉ MutationObserver bắt được.
    mountHeader(view.container, 112, true);
    await act(async () => {});

    expect(screen.getByTestId("queue-panel").style.top).toBe("112px");
  });

  it("header mount muộn vẫn được ResizeObserver observe: đổi offsetHeight + resize → top cập nhật", async () => {
    const { view } = renderPanel(true);

    const header = mountHeader(view.container, 112, true);
    await act(async () => {});
    expect(screen.getByTestId("queue-panel").style.top).toBe("112px");

    Object.defineProperty(header, "offsetHeight", {
      configurable: true,
      value: 70,
    });
    act(() => {
      triggerResize();
    });

    expect(screen.getByTestId("queue-panel").style.top).toBe("70px");
  });

  it("header bị remove (rời tab) → MutationObserver đo lại, top về 0px", async () => {
    const { view } = renderPanel(true);

    const header = mountHeader(view.container, 112, true);
    await act(async () => {});
    expect(screen.getByTestId("queue-panel").style.top).toBe("112px");

    header.remove();
    await act(async () => {});

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

    fireEvent.click(rowFor("Song t1").firstElementChild as HTMLElement);
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

  it("search 'dan' match 'Đàn…' (normalize đ→d)", () => {
    const accented = makeTrack("d1", {
      title: "Đàn Tranh",
      artist: "Ai Đó",
      queueItemId: "q-d1",
    });
    usePlayerStore.setState({
      playbackQueue: [accented, T2, T3],
      originalQueue: [accented, T2, T3],
      currentTrack: T2,
    });
    renderPanel();

    fireEvent.change(screen.getByPlaceholderText(en.queue.search_placeholder), {
      target: { value: "dan" },
    });

    expect(screen.getAllByTestId("queue-row")).toHaveLength(1);
    expect(screen.getByText("Đàn Tranh")).toBeTruthy();
  });

  it("không còn 4 nút mode (guard chống tái xuất hiện) nhưng search + select_multiple vẫn hiện", () => {
    renderPanel();

    // Play-mode switch moved to the PlayerBar cycle: none of the 4 direct
    // mode buttons may reappear in the drawer. Labels are literals on
    // purpose — the queue.mode_* i18n keys were deleted with the buttons.
    for (const label of ["Normal", "Shuffle", "Repeat all", "Repeat one"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }

    // Search + multi-select entry point stay on the same row.
    expect(
      screen.getByPlaceholderText(en.queue.search_placeholder),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: en.queue.select_multiple }),
    ).toBeTruthy();
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

  it("Escape trong input khi query non-empty → clear query, drawer vẫn mở (QSI-1)", () => {
    const { props } = renderPanel(true);

    const input = screen.getByPlaceholderText(en.queue.search_placeholder);
    fireEvent.change(input, { target: { value: "t1" } });
    expect((input as HTMLInputElement).value).toBe("t1");

    fireEvent.keyDown(input, { key: "Escape" });

    expect((input as HTMLInputElement).value).toBe("");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);
  });

  it("Escape trong input khi query rỗng → event nổi lên window, drawer đóng như cũ (QSI-1)", () => {
    const { props } = renderPanel(true);

    fireEvent.keyDown(
      screen.getByPlaceholderText(en.queue.search_placeholder),
      {
        key: "Escape",
      },
    );

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape khi row menu mở → chỉ menu đóng, drawer KHÔNG đóng (QP-3)", () => {
    const { props } = renderPanel(true);

    fireEvent.click(within(rowFor("Song t1")).getByRole("button"));
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();

    // Dispatch on an element (not window): only a real propagation path can
    // prove the menu's document listener stops the press before the drawer's
    // window listener.
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("Escape khi DownloadDialog mở trên drawer → chỉ dialog đóng, drawer giữ nguyên (QP-3)", () => {
    const { props } = renderPanel(true);

    fireEvent.click(within(rowFor("Song t1")).getByRole("button"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: en.menu.download_song }),
    );
    expect(screen.getByText(en.menu.download_title)).not.toBeNull();

    fireEvent.keyDown(screen.getByText(en.menu.download_title), {
      key: "Escape",
    });

    expect(screen.queryByText(en.menu.download_title)).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("QueueList grid semantics + keyboard model (QL-1)", () => {
  it("container là grid có tên; mỗi entry là row với aria-rowindex + gridcell; row đang phát selected", () => {
    renderPanel();

    const grid = screen.getByRole("grid", { name: en.queue.title });
    expect(grid.getAttribute("aria-rowcount")).toBe("3");
    expect(grid.getAttribute("aria-colcount")).toBe("1");
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(3);
    rows.forEach((row, index) => {
      expect(row.getAttribute("aria-rowindex")).toBe(String(index + 1));
      expect(within(row).getAllByRole("gridcell")).toHaveLength(1);
    });
    // T2 is the playing row (index 1) → the selected row.
    expect(rows[1]?.getAttribute("aria-selected")).toBe("true");
    expect(rows[0]?.getAttribute("aria-selected")).toBe("false");
  });

  it("ArrowDown/End/Home di chuyển aria-activedescendant + scrollToIndex; Enter activate row đang active", () => {
    const { props } = renderPanel();

    const grid = screen.getByRole("grid");
    expect(grid.getAttribute("aria-activedescendant")).toBeNull();

    // No active row yet → navigation starts from the playing row (index 1).
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("queue-option-2");
    expect(scrollToIndexSpy).toHaveBeenCalledWith(2, { align: "auto" });

    fireEvent.keyDown(grid, { key: "Enter" });
    expect(props.onSelectTrack).toHaveBeenCalledWith(T3);

    fireEvent.keyDown(grid, { key: "Home" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("queue-option-0");

    fireEvent.keyDown(grid, { key: "End" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("queue-option-2");
  });

  it("Enter khi active là row đang phát → không activate (playing row không phải control)", () => {
    const { props } = renderPanel();

    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("queue-option-2");

    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(grid.getAttribute("aria-activedescendant")).toBe("queue-option-1");

    fireEvent.keyDown(grid, { key: "Enter" });
    expect(props.onSelectTrack).not.toHaveBeenCalled();
  });

  it("aria-multiselectable=true chỉ khi selection mode bật (APG multi-select grid)", () => {
    renderPanel();
    expect(
      screen.getByRole("grid").getAttribute("aria-multiselectable"),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: en.queue.select_multiple }),
    );

    expect(screen.getByRole("grid").getAttribute("aria-multiselectable")).toBe(
      "true",
    );
  });
});

describe("QueuePanel card rows (SongCard clone) + 1 nút close", () => {
  it("drawer chỉ còn 1 nút close (X), không có nút Close footer", () => {
    renderPanel(true);

    expect(
      screen.getAllByRole("button", { name: en.settings.close }),
    ).toHaveLength(1);
  });

  it("hàng queue clone SongCard: card bg + hover lift/shadow, cao 84px", () => {
    renderPanel(true);

    // Row presentation now clones SongCard (48px tile + p-3 card): the idle
    // card bg, hover lift and shadow live on the inner card, the outer row
    // root pins QUEUE_ROW_HEIGHT (84 = 72 card [48 tile + 12+12 padding]
    // + 12 gap mirroring the file tab pb-3 spacing).
    const row = rowFor("Song t1");
    const card = row.firstElementChild as HTMLElement;
    expect(card.className).toContain("bg-[#F8F9FA]");
    expect(card.className).toContain("hover:shadow-md");
    expect(card.className).toContain("group-hover:-translate-y-1");
    expect(row.style.height).toBe("84px");
  });
});

describe("QueuePanel folder drill-down", () => {
  const F1A = makeTrack("f1a", {
    folderGroupId: "f1",
    folderGroupName: "Album F1",
  });
  const F1B = makeTrack("f1b", {
    folderGroupId: "f1",
    folderGroupName: "Album F1",
  });
  const F1C = makeTrack("f1c", {
    folderGroupId: "f1",
    folderGroupName: "Album F1",
  });
  const LOOSE = makeTrack("loose");

  function seedFolderQueue(currentTrack: Track | null = null): void {
    usePlayerStore.setState({
      playbackQueue: [F1A, F1B, LOOSE, F1C],
      originalQueue: [F1A, F1B, LOOSE, F1C],
      currentTrack,
      playMode: "normal",
    });
  }

  it("root view: folder row hiện 1 lần (tên + count), 3 bài con ẩn, loose track hiện", () => {
    seedFolderQueue();
    renderPanel();

    const folderRows = screen.getAllByTestId("queue-folder-row");
    expect(folderRows).toHaveLength(1);
    expect(folderRows[0]?.textContent).toContain("Album F1");
    expect(folderRows[0]?.textContent).toContain("3 songs");

    expect(screen.queryByText("Song f1a")).toBeNull();
    expect(screen.queryByText("Song f1b")).toBeNull();
    expect(screen.queryByText("Song f1c")).toBeNull();
    expect(screen.getByText("Song loose")).toBeTruthy();
    expect(screen.getAllByTestId("queue-row")).toHaveLength(1);
  });

  it("click folder row → drill-down: 3 file con + nút back; click back → về root", () => {
    seedFolderQueue();
    renderPanel();

    openFolderRow();

    expect(screen.queryByTestId("queue-folder-row")).toBeNull();
    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);
    for (const title of ["Song f1a", "Song f1b", "Song f1c"]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.queryByText("Song loose")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: en.queue.back }));

    expect(screen.getAllByTestId("queue-folder-row")).toHaveLength(1);
    expect(screen.getAllByTestId("queue-row")).toHaveLength(1);
    expect(screen.getByText("Song loose")).toBeTruthy();
  });

  it("containsCurrent: current nằm trong folder → title folder row dùng text-brand-text!", () => {
    seedFolderQueue(F1B);
    renderPanel();

    const title = screen.getByTestId("queue-folder-row").querySelector("h3");
    expect(title?.className).toContain("text-brand-text!");
    expect(title?.className).not.toContain("text-gray-800");
  });

  it("xoá hết member khi đang mở folder → tự về root, không kẹt view", () => {
    seedFolderQueue();
    renderPanel();
    openFolderRow();
    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);

    act(() => {
      removeTracksByFolderFromQueue("f1");
    });

    expect(screen.queryByTestId("queue-folder-row")).toBeNull();
    expect(screen.queryByRole("button", { name: en.queue.back })).toBeNull();
    expect(screen.getByText("Song loose")).toBeTruthy();
    expect(screen.getAllByTestId("queue-row")).toHaveLength(1);
  });

  it("regression: search theo tên folder đang hiển thị ('album f1') → 1 folder row count 3, loose ẩn; drill-down vẫn đủ members", () => {
    seedFolderQueue();
    renderPanel();

    fireEvent.change(screen.getByPlaceholderText(en.queue.search_placeholder), {
      target: { value: "album f1" },
    });

    const folderRows = screen.getAllByTestId("queue-folder-row");
    expect(folderRows).toHaveLength(1);
    expect(folderRows[0]?.textContent).toContain("Album F1");
    expect(folderRows[0]?.textContent).toContain("3 songs");
    expect(screen.queryByText("Song loose")).toBeNull();
    expect(screen.queryByText(en.queue.no_results)).toBeNull();

    openFolderRow();

    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);
    expect(screen.queryByText(en.queue.no_results)).toBeNull();
  });

  it("regression: re-add lại đúng folder cũ sau khi xoá hết member → vẫn ở root, không tự drill-down", () => {
    seedFolderQueue();
    renderPanel();
    openFolderRow();
    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);

    act(() => {
      removeTracksByFolderFromQueue("f1");
    });
    expect(screen.queryByRole("button", { name: en.queue.back })).toBeNull();

    act(() => {
      usePlayerStore.setState({
        playbackQueue: [F1A, LOOSE],
        originalQueue: [F1A, LOOSE],
      });
    });

    expect(screen.queryByRole("button", { name: en.queue.back })).toBeNull();
    expect(screen.getAllByTestId("queue-folder-row")).toHaveLength(1);
    expect(screen.getByText("Song loose")).toBeTruthy();
  });

  it("search trong folder view lọc children đúng", () => {
    seedFolderQueue();
    renderPanel();
    openFolderRow();

    fireEvent.change(screen.getByPlaceholderText(en.queue.search_placeholder), {
      target: { value: "f1b" },
    });

    expect(screen.getAllByTestId("queue-row")).toHaveLength(1);
    expect(screen.getByText("Song f1b")).toBeTruthy();
    expect(screen.queryByText("Song f1a")).toBeNull();
  });

  it("đóng rồi mở lại panel → luôn về root view", () => {
    seedFolderQueue();
    const { props, view } = renderPanel(true);
    openFolderRow();
    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);

    view.rerender(<QueuePanel {...props} open={false} />);
    view.rerender(<QueuePanel {...props} open={true} />);

    expect(screen.getAllByTestId("queue-folder-row")).toHaveLength(1);
    expect(screen.getAllByTestId("queue-row")).toHaveLength(1);
    expect(screen.getByText("Song loose")).toBeTruthy();
  });

  function openFolderRow(): void {
    // The card is the activation target (row root is layout-only).
    fireEvent.click(
      screen.getByTestId("queue-folder-row").firstElementChild as HTMLElement,
    );
  }

  function openFolderMenu(): void {
    const trigger = screen
      .getByTestId("queue-folder-row")
      .querySelector('[aria-haspopup="menu"]');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger as HTMLElement);
  }

  function openMenuButtonNames(): string[] {
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    return within(menu as HTMLElement)
      .getAllByRole("menuitem")
      .map((b) => b.textContent?.trim() ?? "");
  }

  it("folder row có menu: mở thấy đúng Navigate + Remove Folder from Queue, không mở drill-down", () => {
    seedFolderQueue();
    renderPanel();

    openFolderMenu();

    // Root view stays: no drill-down (no back button, no child rows).
    expect(screen.queryByRole("button", { name: en.queue.back })).toBeNull();
    expect(screen.queryByText("Song f1a")).toBeNull();
    expect(screen.getByTestId("queue-folder-row")).toBeTruthy();
    // Exactly the 2 folder actions — no download/playlist/remove-single leak.
    expect(openMenuButtonNames()).toEqual([
      en.menu.navigate,
      en.queue.remove_folder,
    ]);
  });

  it("mở menu folder → focus vào menuitem đầu tiên (P2-08-1)", () => {
    seedFolderQueue();
    renderPanel();

    openFolderMenu();

    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    const items = within(menu).getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
  });

  it("click Remove Folder from Queue → cả group rời queue, ở lại root, không drill-down", () => {
    seedFolderQueue();
    renderPanel();

    openFolderMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: en.queue.remove_folder }),
    );

    const state = usePlayerStore.getState();
    expect(state.playbackQueue).toEqual([LOOSE]);
    expect(state.originalQueue).toEqual([LOOSE]);

    expect(screen.queryByTestId("queue-folder-row")).toBeNull();
    expect(screen.queryByRole("button", { name: en.queue.back })).toBeNull();
    expect(screen.getByText("Song loose")).toBeTruthy();
    expect(screen.getAllByTestId("queue-row")).toHaveLength(1);
  });

  it("click Navigate → locate-file CHỈ { fileId: 'f1' }, không mở drill-down", () => {
    const spy = vi.fn();
    window.addEventListener("locate-file", spy);
    try {
      seedFolderQueue();
      renderPanel();

      openFolderMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: en.menu.navigate }));

      expect(spy).toHaveBeenCalledTimes(1);
      const [event] = spy.mock.calls[0] as [CustomEvent];
      expect(event.detail).toEqual({ fileId: "f1" });

      expect(screen.getAllByTestId("queue-folder-row")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: en.queue.back })).toBeNull();
      expect(screen.queryByText("Song f1a")).toBeNull();
    } finally {
      window.removeEventListener("locate-file", spy);
    }
  });

  it("selectionMode → folder row KHÔNG render menu", () => {
    seedFolderQueue();
    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: en.queue.select_multiple }),
    );

    const folderRow = screen.getByTestId("queue-folder-row");
    expect(folderRow.querySelector('[aria-haspopup="menu"]')).toBeNull();
  });

  it("regression: menu track row giữ nguyên items cũ, không lộ remove_folder", () => {
    renderPanel();
    fireEvent.click(within(rowFor("Song t1")).getByRole("button"));

    expect(openMenuButtonNames()).toEqual([
      en.menu.download_song,
      en.menu.navigate,
      en.queue.remove_from_queue,
      en.menu.add_to_playlist,
    ]);
    // Add to Playlist is the submenu toggle: a parent menuitem since P2-09a-1.
    expect(
      screen.getByRole("menuitem", { name: en.menu.add_to_playlist }),
    ).toBeTruthy();
  });
});

describe("QueuePanel selection scope + prune + focus restore (UQS-1/UQS-3/QST-2)", () => {
  const F1A = makeTrack("f1a", {
    folderGroupId: "f1",
    folderGroupName: "Album F1",
  });
  const F1B = makeTrack("f1b", {
    folderGroupId: "f1",
    folderGroupName: "Album F1",
  });
  const F1C = makeTrack("f1c", {
    folderGroupId: "f1",
    folderGroupName: "Album F1",
  });
  const LOOSE = makeTrack("loose");

  function seedFolderQueue(): void {
    usePlayerStore.setState({
      playbackQueue: [F1A, F1B, LOOSE, F1C],
      originalQueue: [F1A, F1B, LOOSE, F1C],
      currentTrack: null,
      playMode: "normal",
    });
  }

  function enterSelectionMode(): void {
    fireEvent.click(
      screen.getByRole("button", { name: en.queue.select_multiple }),
    );
  }

  function clickSelectAll(): void {
    fireEvent.click(screen.getByRole("button", { name: en.queue.select_all }));
  }

  function setSearch(value: string): void {
    fireEvent.change(screen.getByPlaceholderText(en.queue.search_placeholder), {
      target: { value },
    });
  }

  function checkboxFor(title: string): HTMLInputElement {
    return within(rowFor(title)).getByRole("checkbox");
  }

  it("UQS-1 root view (folder collapsed): Select all chỉ chọn row đang hiện (LOOSE), member ẩn không bị xoá", () => {
    seedFolderQueue();
    renderPanel();
    enterSelectionMode();

    // Folder collapsed → the 3 members render no checkbox, only LOOSE does.
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);

    clickSelectAll();
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(checkboxFor("Song loose").checked).toBe(true);

    fireEvent.click(screen.getByTestId("queue-remove-selected"));

    // Only the visible entry is gone; the collapsed folder keeps all members.
    expect(usePlayerStore.getState().playbackQueue).toEqual([F1A, F1B, F1C]);
    const folderRow = screen.getByTestId("queue-folder-row");
    expect(folderRow.textContent).toContain("3 songs");
    expect(screen.queryByText("Song loose")).toBeNull();
  });

  it("UQS-1 search filtered: Select all chỉ chọn kết quả đang hiện, entry bị lọc không bị xoá", () => {
    renderPanel();
    setSearch("t1");
    enterSelectionMode();

    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    clickSelectAll();
    expect(screen.getByText("1 selected")).toBeTruthy();

    fireEvent.click(screen.getByTestId("queue-remove-selected"));

    expect(usePlayerStore.getState().playbackQueue).toEqual([T2, T3]);
  });

  it("UQS-1 drill-down folder: Select all chọn đủ 3 member đang hiện; Remove xoá folder, giữ loose", () => {
    seedFolderQueue();
    renderPanel();
    fireEvent.click(
      screen.getByTestId("queue-folder-row").firstElementChild as HTMLElement,
    );
    enterSelectionMode();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);

    clickSelectAll();
    expect(screen.getByText("3 selected")).toBeTruthy();

    fireEvent.click(screen.getByTestId("queue-remove-selected"));

    expect(usePlayerStore.getState().playbackQueue).toEqual([LOOSE]);
    expect(screen.queryByTestId("queue-folder-row")).toBeNull();
    expect(screen.getByText("Song loose")).toBeTruthy();
  });

  it("UQS-1 indicator theo scope visible: partial → Select all; đủ → Unselect all; bấm lại → 0 selected", () => {
    renderPanel();
    enterSelectionMode();

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0] as HTMLElement);
    expect(
      screen.getByRole("button", { name: en.queue.select_all }),
    ).toBeTruthy();

    clickSelectAll();
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: en.queue.unselect_all }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: en.queue.unselect_all }),
    );
    expect(screen.getByText("0 selected")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: en.queue.select_all }),
    ).toBeTruthy();
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect((checkbox as HTMLInputElement).checked).toBe(false);
    }
  });

  it("UQS-1 selection ẩn được giữ nguyên khi toggle select-all ở view khác", () => {
    renderPanel();

    setSearch("t1");
    enterSelectionMode();
    clickSelectAll();
    expect(screen.getByText("1 selected")).toBeTruthy();

    // Clear the filter: visible T1 + T3, so "Select all" adds T3 only.
    setSearch("");
    expect(
      screen.getByRole("button", { name: en.queue.select_all }),
    ).toBeTruthy();
    clickSelectAll();
    expect(screen.getByText("2 selected")).toBeTruthy();

    // Narrow again: every VISIBLE row is selected → toggle reads "Unselect all".
    setSearch("t1");
    expect(
      screen.getByRole("button", { name: en.queue.unselect_all }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: en.queue.unselect_all }),
    );

    // Only the visible key (T1) is dropped; the filtered-out T3 stays selected.
    expect(screen.getByText("1 selected")).toBeTruthy();
    setSearch("");
    expect(checkboxFor("Song t1").checked).toBe(false);
    expect(checkboxFor("Song t3").checked).toBe(true);
  });

  it("UQS-3 auto-advance khi đang selection: entry vừa thành current bị prune, Remove không xoá nhầm", () => {
    const A = makeTrack("a");
    const B = makeTrack("b");
    usePlayerStore.setState({
      playbackQueue: [A, B],
      originalQueue: [A, B],
      currentTrack: A,
      playMode: "normal",
    });
    renderPanel();
    enterSelectionMode();

    fireEvent.click(screen.getByRole("checkbox")); // B
    expect(screen.getByText("1 selected")).toBeTruthy();

    act(() => {
      usePlayerStore.setState({ currentTrack: B });
    });

    // B is current now → its checkbox is gone, the stale key is pruned and
    // Remove cannot delete anything (disabled).
    expect(screen.queryAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("0 selected")).toBeTruthy();
    fireEvent.click(screen.getByTestId("queue-remove-selected"));
    expect(usePlayerStore.getState().playbackQueue).toEqual([A, B]);
  });

  it("QST-2 thoát selection mode (toolbar unmount) → focus về nút toggle selection", () => {
    renderPanel();
    const toggle = screen.getByRole("button", {
      name: en.queue.select_multiple,
    });
    enterSelectionMode();

    const exit = screen.getByRole("button", { name: en.queue.exit_selection });
    exit.focus();
    expect(document.activeElement).toBe(exit);

    fireEvent.click(exit);

    expect(screen.queryByTestId("queue-selection-toolbar")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
});

describe("QueuePanel live regions (WCAG 4.1.3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("search announce số kết quả sau debounce 400ms vào vùng role=status sr-only", () => {
    renderPanel();

    const status = screen.getByTestId("queue-search-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.className).toContain("sr-only");
    expect(status.textContent).toBe("");

    fireEvent.change(screen.getByPlaceholderText(en.queue.search_placeholder), {
      target: { value: "t1" },
    });
    // Debounce chưa hết → không announce từng ký tự.
    expect(status.textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(status.textContent).toBe("1 result");
  });

  it("search không khớp → announce no_results sau debounce", () => {
    renderPanel();

    fireEvent.change(screen.getByPlaceholderText(en.queue.search_placeholder), {
      target: { value: "zzz" },
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.getByTestId("queue-search-status").textContent).toBe(
      en.queue.no_results,
    );
  });

  it("count selected trong toolbar là role=status aria-atomic, text đổi theo toggle", () => {
    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: en.queue.select_multiple }),
    );

    const toolbar = screen.getByTestId("queue-selection-toolbar");
    const count = within(toolbar).getByRole("status");
    expect(count.getAttribute("aria-atomic")).toBe("true");
    expect(count.textContent).toBe("0 selected");

    fireEvent.click(screen.getByRole("checkbox", { name: "Song t1" }));
    expect(within(toolbar).getByRole("status").textContent).toBe("1 selected");
  });
});
