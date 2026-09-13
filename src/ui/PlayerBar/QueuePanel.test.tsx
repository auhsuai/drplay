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

    fireEvent.click(screen.getByTestId("queue-folder-row"));

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

  it("containsCurrent: current nằm trong folder → title folder row dùng text-brand-primary!", () => {
    seedFolderQueue(F1B);
    renderPanel();

    const title = screen.getByTestId("queue-folder-row").querySelector("h3");
    expect(title?.className).toContain("text-brand-primary!");
    expect(title?.className).not.toContain("text-gray-800");
  });

  it("xoá hết member khi đang mở folder → tự về root, không kẹt view", () => {
    seedFolderQueue();
    renderPanel();
    fireEvent.click(screen.getByTestId("queue-folder-row"));
    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);

    act(() => {
      removeTracksByFolderFromQueue("f1");
    });

    expect(screen.queryByTestId("queue-folder-row")).toBeNull();
    expect(screen.queryByRole("button", { name: en.queue.back })).toBeNull();
    expect(screen.getByText("Song loose")).toBeTruthy();
    expect(screen.getAllByTestId("queue-row")).toHaveLength(1);
  });

  it("search trong folder view lọc children đúng", () => {
    seedFolderQueue();
    renderPanel();
    fireEvent.click(screen.getByTestId("queue-folder-row"));

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
    fireEvent.click(screen.getByTestId("queue-folder-row"));
    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);

    view.rerender(<QueuePanel {...props} open={false} />);
    view.rerender(<QueuePanel {...props} open={true} />);

    expect(screen.getAllByTestId("queue-folder-row")).toHaveLength(1);
    expect(screen.getAllByTestId("queue-row")).toHaveLength(1);
    expect(screen.getByText("Song loose")).toBeTruthy();
  });

  function openFolderMenu(): void {
    fireEvent.click(
      within(screen.getByTestId("queue-folder-row")).getByRole("button"),
    );
  }

  function openMenuButtonNames(): string[] {
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    return within(menu as HTMLElement)
      .getAllByRole("button")
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

  it("click Remove Folder from Queue → cả group rời queue, ở lại root, không drill-down", () => {
    seedFolderQueue();
    renderPanel();

    openFolderMenu();
    fireEvent.click(
      screen.getByRole("button", { name: en.queue.remove_folder }),
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
      fireEvent.click(screen.getByRole("button", { name: en.menu.navigate }));

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
    expect(within(folderRow).queryByRole("button")).toBeNull();
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
  });
});
