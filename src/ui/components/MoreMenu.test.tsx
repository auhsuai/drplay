// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MoreMenu } from "./MoreMenu";
import { getContextMenuStyle } from "./MoreMenu/menuPositioning";
import en from "../../locales/en/translation.json";
import type { Track } from "../../types";
import type { DriveItem } from "../../types";
import { DEBUG_EVENTS } from "../debug/debugEvents";

const mocks = vi.hoisted(() => ({
  driveApi: {
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
  },
  db: {
    files: { delete: vi.fn(), update: vi.fn() },
  },
  captureError: vi.fn(),
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
  getPlaylists: vi.fn(),
  addTrackToPlaylist: vi.fn(),
}));

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

vi.mock("../../utils/driveApi", () => mocks.driveApi);
vi.mock("../../db/db", () => ({ db: mocks.db }));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
  showSuccessToast: mocks.showSuccessToast,
}));
vi.mock("../../utils/playlists", () => ({
  getPlaylists: mocks.getPlaylists,
  addTrackToPlaylist: mocks.addTrackToPlaylist,
}));

function makeTrack(over: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    title: "My Song",
    artist: "Artist",
    streamUrl: "https://example.com/song",
    size: 1000,
    parentId: "parent-1",
    parentName: "Folder One",
    ...over,
  };
}

function makeDriveItem(over: Partial<DriveItem> = {}): DriveItem {
  return {
    id: "track-1",
    title: "My Song",
    isFolder: false,
    size: 1000,
    trackInfo: makeTrack(),
    ...over,
  };
}

function menuEl(): HTMLElement {
  const menu = document.body.querySelector('[role="menu"]');
  expect(menu).not.toBeNull();
  return menu as HTMLElement;
}

function triggerEl(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-haspopup="menu"]',
  );
  expect(trigger).not.toBeNull();
  return trigger as HTMLButtonElement;
}

function openTrigger(): void {
  fireEvent.click(triggerEl());
}

function menuItemNames(): string[] {
  return within(menuEl())
    .getAllByRole("menuitem")
    .map((b) => b.textContent?.trim() ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPlaylists.mockResolvedValue([]);
  mocks.driveApi.deleteFile.mockResolvedValue({
    id: "track-1",
    name: "My Song",
    mimeType: "audio/mpeg",
    trashed: true,
    isFolder: false,
    parentId: "parent-1",
  });
});

afterEach(() => {
  cleanup();
});

describe("MoreMenu recent variant", () => {
  it("names the trigger button for assistive tech", () => {
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
      />,
    );
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
  });

  it("shows exactly 4 curated items (Delete / Download Song / Add to Playlist / Locate File) and no Select Multiple or Move to", () => {
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
      />,
    );
    openTrigger();
    expect(menuItemNames().sort()).toEqual([
      "Add to Playlist",
      "Delete",
      "Download Song",
      "Locate File",
    ]);
    expect(
      within(menuEl()).queryByRole("menuitem", {
        name: "Select multiple items",
      }),
    ).toBeNull();
    expect(
      within(menuEl()).queryByRole("menuitem", { name: "Move to..." }),
    ).toBeNull();
  });

  it("hides Delete when token is missing but keeps track-based items", () => {
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
      />,
    );
    openTrigger();
    expect(menuItemNames().sort()).toEqual([
      "Add to Playlist",
      "Download Song",
      "Locate File",
    ]);
  });

  it("hides Delete when driveItem is missing (track-only render) but keeps track-based items", () => {
    render(<MoreMenu variant="recent" track={makeTrack()} token="tok" />);
    openTrigger();
    expect(menuItemNames().sort()).toEqual([
      "Add to Playlist",
      "Download Song",
      "Locate File",
    ]);
  });

  it("dispatches the locate-file CustomEvent with fileId/parentId/parentName on Locate File", () => {
    const spy = vi.fn();
    window.addEventListener("locate-file", spy);
    const onClose = vi.fn();
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
        onClose={onClose}
      />,
    );
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("menuitem", { name: "Locate File" }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const firstCall = spy.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected event dispatch");
    const detail = (
      firstCall[0] as CustomEvent<{
        fileId: string;
        parentId: string;
        parentName: string;
      }>
    ).detail;
    expect(detail).toEqual({
      fileId: "track-1",
      parentId: "parent-1",
      parentName: "Folder One",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("opens DeleteConfirmDialog on Delete and runs the delete path on confirm", async () => {
    const onRemoveItem = vi.fn();
    const onClose = vi.fn();
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
        onRemoveItem={onRemoveItem}
        onClose={onClose}
      />,
    );
    openTrigger();
    fireEvent.click(within(menuEl()).getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText("Move to Trash?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(mocks.driveApi.deleteFile).toHaveBeenCalledWith("tok", "track-1");
    });
    await waitFor(() => {
      expect(mocks.db.files.delete).toHaveBeenCalledWith([
        "default",
        "track-1",
      ]);
    });
    await waitFor(() => {
      expect(onRemoveItem).toHaveBeenCalledWith("track-1");
    });
    expect(screen.queryByText("Move to Trash?")).toBeNull();
  });

  it("opens DownloadDialog on Download Song without crashing", () => {
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
      />,
    );
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("menuitem", { name: "Download Song" }),
    );
    expect(screen.getByText("File name")).toBeTruthy();
  });

  it("opens PlaylistsSubmenu on Add to Playlist", () => {
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
      />,
    );
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("menuitem", { name: "Add to Playlist" }),
    );
    expect(screen.getByText("Playlists")).toBeTruthy();
  });
});

describe("MoreMenu default variant regression (file list)", () => {
  it("keeps the original 6 items (Select Multiple / Add to Queue / Move to / Delete / Download / Add to Playlist)", () => {
    render(
      <MoreMenu track={makeTrack()} driveItem={makeDriveItem()} token="tok" />,
    );
    openTrigger();
    expect(menuItemNames().sort()).toEqual([
      "Add to Playlist",
      "Add to queue",
      "Delete",
      "Download Song",
      "Move to...",
      "Select multiple items",
    ]);
  });

  it('keeps the original items even when variant is explicitly "default"', () => {
    render(
      <MoreMenu
        variant="default"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
      />,
    );
    openTrigger();
    expect(menuItemNames().sort()).toEqual([
      "Add to Playlist",
      "Add to queue",
      "Delete",
      "Download Song",
      "Move to...",
      "Select multiple items",
    ]);
  });
});

describe("MoreMenu default variant add-to-queue item", () => {
  it("renders Add to queue when driveItem and token are present", () => {
    render(
      <MoreMenu track={makeTrack()} driveItem={makeDriveItem()} token="tok" />,
    );
    openTrigger();
    expect(
      within(menuEl()).getByRole("menuitem", { name: "Add to queue" }),
    ).toBeTruthy();
  });

  it("hides Add to queue when token is missing", () => {
    render(<MoreMenu track={makeTrack()} driveItem={makeDriveItem()} />);
    openTrigger();
    expect(
      within(menuEl()).queryByRole("menuitem", { name: "Add to queue" }),
    ).toBeNull();
  });
});

describe("MoreMenu playerbar variant regression", () => {
  it("keeps the original 2 track items (Download Song / Locate File) plus shared Add to Playlist, no Delete", () => {
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    expect(menuItemNames().sort()).toEqual([
      "Add to Playlist",
      "Download Song",
      "Locate File",
    ]);
    expect(
      within(menuEl()).queryByRole("menuitem", { name: "Delete" }),
    ).toBeNull();
    expect(
      within(menuEl()).queryByRole("menuitem", {
        name: "Select multiple items",
      }),
    ).toBeNull();
  });

  it("still dispatches locate-file with the same detail as before", () => {
    const spy = vi.fn();
    window.addEventListener("locate-file", spy);
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("menuitem", { name: "Locate File" }),
    );
    const firstCall = spy.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected event dispatch");
    const detail = (
      firstCall[0] as CustomEvent<{
        fileId: string;
        parentId: string;
        parentName: string;
      }>
    ).detail;
    expect(detail).toEqual({
      fileId: "track-1",
      parentId: "parent-1",
      parentName: "Folder One",
    });
  });
});

describe("MoreMenu WAI-ARIA roles + keyboard navigation (P2-08)", () => {
  function renderRecent(): void {
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
      />,
    );
  }

  function menuItems(): HTMLElement[] {
    return within(menuEl()).getAllByRole("menuitem");
  }

  function pressOnActive(key: string): void {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key });
  }

  it("names the menu container and exposes items as buttons with role=menuitem", () => {
    renderRecent();
    openTrigger();
    expect(screen.getByRole("menu", { name: "More actions" })).toBe(menuEl());
    expect(
      within(menuEl())
        .getByRole("menuitem", { name: "Delete" })
        .getAttribute("type"),
    ).toBe("button");
  });

  it("focuses the first enabled menuitem when opened from the trigger", () => {
    renderRecent();
    openTrigger();
    expect(menuItems()[0]).toBe(document.activeElement);
    expect(document.activeElement?.textContent?.trim()).toBe("Delete");
  });

  it("focuses the first enabled menuitem when opened as an anchor context menu", () => {
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
        forceOpen
        anchorPoint={{ x: 40, y: 40 }}
      />,
    );
    expect(menuItems()[0]).toBe(document.activeElement);
  });

  it("keeps tabIndex=0 on the active item only (roving tabindex)", () => {
    renderRecent();
    openTrigger();
    const items = menuItems();
    expect(items[0]?.tabIndex).toBe(0);
    expect(items[1]?.tabIndex).toBe(-1);
    expect(items[2]?.tabIndex).toBe(-1);

    pressOnActive("ArrowDown");

    expect(items[0]?.tabIndex).toBe(-1);
    expect(items[1]?.tabIndex).toBe(0);
  });

  it("ArrowDown/ArrowUp wrap around the enabled items", () => {
    renderRecent();
    openTrigger();
    const items = menuItems();

    pressOnActive("ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    pressOnActive("ArrowDown");
    expect(document.activeElement).toBe(items[2]);
    pressOnActive("ArrowDown");
    expect(document.activeElement).toBe(items[3]); // Add to Playlist (last)
    pressOnActive("ArrowDown"); // last -> first
    expect(document.activeElement).toBe(items[0]);
    pressOnActive("ArrowUp"); // first -> last
    expect(document.activeElement).toBe(items[3]);
  });

  it("Home/End jump to the first/last enabled item", () => {
    renderRecent();
    openTrigger();
    const items = menuItems();

    pressOnActive("End");
    expect(document.activeElement).toBe(items[3]);
    pressOnActive("Home");
    expect(document.activeElement).toBe(items[0]);
  });

  it("roving skips disabled items (queue variant)", () => {
    render(
      <MoreMenu
        variant="queue"
        track={makeTrack()}
        disableRemoveFromQueue
        onRemoveFromQueue={() => {}}
        onRemoveFolderFromQueue={() => {}}
      />,
    );
    openTrigger();
    const items = menuItems();
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Download Song",
      "Locate File",
      "Remove from Queue",
      "Remove Folder from Queue",
      "Add to Playlist",
    ]);
    expect(items[2]?.tabIndex).toBe(-1);

    pressOnActive("ArrowDown"); // -> Locate File
    pressOnActive("ArrowDown"); // skips the disabled entry
    expect(document.activeElement).toBe(items[3]);
  });

  it("ArrowDown/ArrowUp on the trigger open the menu and focus first/last item", () => {
    renderRecent();
    const trigger = triggerEl();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(menuItems()[0]).toBe(document.activeElement);

    pressOnActive("Escape");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const items = menuItems();
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("Enter on the focused item activates it (native button)", async () => {
    const user = userEvent.setup();
    renderRecent();
    openTrigger();
    expect(document.activeElement).toBe(menuItems()[0]);

    await user.keyboard("{Enter}");

    expect(screen.getByText("Move to Trash?")).toBeTruthy();
  });

  it("Space on the focused item activates it (native button)", async () => {
    const user = userEvent.setup();
    renderRecent();
    openTrigger();
    pressOnActive("ArrowDown"); // Download Song

    await user.keyboard(" ");

    expect(screen.getByText("File name")).toBeTruthy();
  });

  it("does not hijack arrow keys while typing in the playlists search input", () => {
    renderRecent();
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("menuitem", { name: "Add to Playlist" }),
    );
    const input = screen.getByRole("textbox", { name: "Search..." });
    input.focus();

    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(document.activeElement).toBe(input);
  });
});

describe("MoreMenu close-path focus return + resize + Esc submenu (P2-08b)", () => {
  function renderRecent(): void {
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
      />,
    );
  }

  function menuItems(): HTMLElement[] {
    return within(menuEl()).getAllByRole("menuitem");
  }

  function toggleItem(): HTMLElement {
    return within(menuEl()).getByRole("menuitem", { name: "Add to Playlist" });
  }

  function menuClosed(): boolean {
    return document.body.querySelector('[role="menu"]') === null;
  }

  it("returns focus to the trigger when Escape closes the menu (item handler)", () => {
    renderRecent();
    openTrigger();
    expect(document.activeElement).toBe(menuItems()[0]);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });

    expect(menuClosed()).toBe(true);
    expect(document.activeElement).toBe(triggerEl());
  });

  it("returns focus to the trigger when Escape is dispatched on document", () => {
    renderRecent();
    openTrigger();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(menuClosed()).toBe(true);
    expect(document.activeElement).toBe(triggerEl());
  });

  it("returns focus to the trigger on an outside mousedown while focus sits in the dropdown", () => {
    renderRecent();
    openTrigger();
    expect(document.activeElement).toBe(menuItems()[0]);

    fireEvent.mouseDown(document.body);

    expect(menuClosed()).toBe(true);
    expect(document.activeElement).toBe(triggerEl());
  });

  it("does not steal focus on an outside mousedown when another control owns it", () => {
    renderRecent();
    openTrigger();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    fireEvent.mouseDown(outside);

    expect(menuClosed()).toBe(true);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("closes the menu on window resize (stale-rect policy)", () => {
    renderRecent();
    openTrigger();
    expect(menuClosed()).toBe(false);

    fireEvent(window, new Event("resize"));

    expect(menuClosed()).toBe(true);
  });

  it("Escape closes the playlists submenu first and returns focus to its toggle, then closes the menu", () => {
    renderRecent();
    openTrigger();
    const toggle = toggleItem();
    fireEvent.click(toggle);
    const input = screen.getByRole("textbox", { name: "Search..." });
    input.focus();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByText("Playlists")).toBeNull();
    expect(menuClosed()).toBe(false);
    expect(document.activeElement).toBe(toggle);

    fireEvent.keyDown(toggle, { key: "Escape" });

    expect(menuClosed()).toBe(true);
    expect(document.activeElement).toBe(triggerEl());
  });

  it("does not return focus when the menu was opened as an anchor context menu", () => {
    const onClose = vi.fn();
    function AnchorHarness() {
      const [open, setOpen] = useState(true);
      return (
        <MoreMenu
          variant="recent"
          track={makeTrack()}
          driveItem={makeDriveItem()}
          token="tok"
          forceOpen={open}
          anchorPoint={{ x: 40, y: 40 }}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        />
      );
    }
    render(<AnchorHarness />);
    const first = menuItems()[0];
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first as HTMLElement, { key: "Escape" });

    expect(menuClosed()).toBe(true);
    expect(onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("marks the Add to Playlist toggle as a menuitem exposing haspopup + expanded", () => {
    renderRecent();
    openTrigger();
    const toggle = toggleItem();
    expect(toggle.getAttribute("aria-haspopup")).toBe("menu");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("MoreMenu debug download toast trigger", () => {
  afterEach(() => {
    cleanup();
  });

  function dispatchDownloadToast(message: string) {
    act(() => {
      window.dispatchEvent(
        new CustomEvent(DEBUG_EVENTS.DOWNLOAD_TOAST, { detail: { message } }),
      );
    });
  }

  it("DOWNLOAD_TOAST dispatch renders the DownloadToast with the message", () => {
    render(<MoreMenu track={makeTrack()} token="tok" />);

    dispatchDownloadToast("Downloaded: debug-test.mp3");

    expect(screen.getByText("Downloaded: debug-test.mp3")).not.toBeNull();
  });

  it("a second DOWNLOAD_TOAST replaces the message (latest wins)", () => {
    render(<MoreMenu track={makeTrack()} token="tok" />);
    dispatchDownloadToast("Downloaded: first.mp3");
    expect(screen.getByText("Downloaded: first.mp3")).not.toBeNull();

    dispatchDownloadToast("Downloaded: second.mp3");

    expect(screen.getByText("Downloaded: second.mp3")).not.toBeNull();
    expect(screen.queryByText("Downloaded: first.mp3")).toBeNull();
  });

  it("unmount -> dispatching DOWNLOAD_TOAST is a no-op (listener cleaned up)", () => {
    const { unmount } = render(<MoreMenu track={makeTrack()} token="tok" />);
    unmount();

    expect(() => {
      dispatchDownloadToast("Downloaded: debug-test.mp3");
    }).not.toThrow();
  });
});

describe("MoreMenu popup positioning clamps to viewport (P1)", () => {
  const originalVw = window.innerWidth;
  const originalVh = window.innerHeight;

  // jsdom exposes innerWidth/innerHeight as configurable own properties, so
  // defineProperty is the reliable way to stub them per-case.
  function setViewport(vw: number, vh: number): void {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: vw,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: vh,
    });
  }

  // Only right/top/bottom are read by getContextMenuStyle; the rest completes
  // the DOMRect shape (structurally assignable, no cast needed).
  function makeRect(top: number, bottom: number, right: number): DOMRect {
    return {
      top,
      right,
      bottom,
      left: right - 40,
      x: right - 40,
      y: top,
      width: 40,
      height: bottom - top,
      toJSON: () => {},
    };
  }

  afterEach(() => {
    setViewport(originalVw, originalVh);
  });

  interface Case {
    name: string;
    vw: number;
    vh: number;
    anchorPoint?: { x: number; y: number } | null;
    buttonRect?: DOMRect | null;
    openUpwards?: boolean;
    expected: Record<string, number>;
  }

  const W = 240; // w-60 on the dropdown portal
  const H = 250; // MENU_ESTIMATED_HEIGHT_PX
  const GAP = 8;

  it.each<Case>([
    {
      name: "identity: long-press point fits left+down → values unchanged",
      vw: 1280,
      vh: 800,
      anchorPoint: { x: 100, y: 100 },
      buttonRect: null,
      openUpwards: false,
      expected: { left: 100, top: 100 },
    },
    {
      name: "identity: trigger rect fits right+down (open downwards) → values unchanged",
      vw: 1280,
      vh: 800,
      buttonRect: makeRect(100, 140, 400),
      openUpwards: false,
      expected: { right: 1280 - 400, top: 148 },
    },
    {
      name: "identity: trigger rect fits right+up (open upwards) → values unchanged",
      vw: 1280,
      vh: 800,
      buttonRect: makeRect(700, 740, 400),
      openUpwards: true,
      expected: { right: 880, bottom: 800 - 700 + GAP },
    },
    {
      name: "long-press near right edge of a narrow screen → menu shifted flush right",
      vw: 360,
      vh: 640,
      anchorPoint: { x: 150, y: 100 },
      buttonRect: null,
      openUpwards: false,
      expected: { left: 360 - W, top: 100 },
    },
    {
      name: "long-press right-half but too close to left edge → menu pinned flush left",
      vw: 360,
      vh: 640,
      anchorPoint: { x: 200, y: 600 },
      buttonRect: null,
      openUpwards: false,
      expected: { right: 360 - W, bottom: 40 },
    },
    {
      name: "long-press in upper half too low for the menu height → top clamped",
      vw: 800,
      vh: 400,
      anchorPoint: { x: 100, y: 180 },
      buttonRect: null,
      openUpwards: false,
      expected: { left: 100, top: 400 - H },
    },
    {
      name: "long-press in lower half too high for the menu height → bottom clamped",
      vw: 800,
      vh: 400,
      anchorPoint: { x: 700, y: 220 },
      buttonRect: null,
      openUpwards: false,
      expected: { right: 100, bottom: 400 - H },
    },
    {
      name: "trigger near left edge on a narrow screen → menu pinned flush left",
      vw: 360,
      vh: 640,
      buttonRect: makeRect(300, 340, 100),
      openUpwards: true,
      expected: { right: 360 - W, bottom: 640 - 300 + GAP },
    },
    {
      name: "trigger opens upwards but not enough room above → bottom clamped",
      vw: 800,
      vh: 400,
      buttonRect: makeRect(50, 90, 500),
      openUpwards: true,
      expected: { right: 800 - 500, bottom: 400 - H },
    },
    {
      name: "trigger opens downwards but not enough room below → top clamped",
      vw: 800,
      vh: 400,
      buttonRect: makeRect(160, 200, 500),
      openUpwards: false,
      expected: { right: 800 - 500, top: 400 - H },
    },
    {
      name: "window smaller than the menu on both axes → pinned to top-left, no negative offsets",
      vw: 200,
      vh: 300,
      anchorPoint: { x: 100, y: 150 },
      buttonRect: null,
      openUpwards: false,
      expected: { left: 0, top: Math.max(300 - H, 0) },
    },
  ])("$name", (c) => {
    setViewport(c.vw, c.vh);
    expect(
      getContextMenuStyle({
        anchorPoint: c.anchorPoint,
        buttonRect: c.buttonRect ?? null,
        openUpwards: c.openUpwards ?? false,
      }),
    ).toEqual(c.expected);
  });

  it("renders the long-press menu inside a narrow viewport through the real component", () => {
    setViewport(360, 640);
    render(
      <MoreMenu
        track={makeTrack()}
        anchorPoint={{ x: 150, y: 100 }}
        forceOpen
      />,
    );

    const menu = menuEl();
    expect(menu.style.left).toBe(String(360 - W) + "px");
    expect(menu.style.top).toBe("100px");
  });
});
