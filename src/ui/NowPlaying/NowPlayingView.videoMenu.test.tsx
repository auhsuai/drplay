// @vitest-environment jsdom
/**
 * Slice 2 integration: right-click on the video area and the bar's More button
 * are TWO entry points into ONE DrPlay menu. These tests drive the REAL chain
 * (NowPlayingView -> VideoPlayerBar -> useVideoMenu -> VideoMenu -> menuModel)
 * and assert the two paths cannot drift, that neither opens a native menu, and
 * that only one trigger button exists.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";

// The native half must be unreachable from this path.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const nativeMenuMock = vi.hoisted(() => ({ showContextMenu: vi.fn() }));
vi.mock("../../lib/nativeMenu", () => nativeMenuMock);

// Only the engine snapshot is stubbed (it would otherwise round-trip through
// mpvControl); buildContextMenuModel + runMenuEntry stay REAL, so the entries
// and the dispatch below are the shipped ones.
const snapshotMock = vi.hoisted(() => ({ takeVideoMenuSnapshot: vi.fn() }));
vi.mock("../../player/menuModel", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../player/menuModel")>();
  return {
    ...actual,
    takeVideoMenuSnapshot: snapshotMock.takeVideoMenuSnapshot,
  };
});

const audioMock = vi.hoisted(() => ({
  getVolume: vi.fn(() => 0.5),
  isMuted: vi.fn(() => false),
  toggleMute: vi.fn(() => false),
  setVolume: vi.fn(),
  on: vi.fn(() => () => {}),
  getCurrentTime: vi.fn(() => 0),
}));
vi.mock("../../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
}));
vi.mock("../components/SeekBar", () => ({
  SeekBar: () => <div data-testid="seekbar-stub" />,
}));
vi.mock("./hooks/useNowPlayingMetadata", () => ({
  useNowPlayingMetadata: () => ({
    coverUrl: null,
    setCoverUrl: vi.fn(),
    realTitle: "Title",
    realArtist: "Artist",
    bgColor: null,
    bgPalette: [],
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { NowPlayingView } from "./NowPlayingView";
import { VideoMenu } from "../components/MoreMenu/VideoMenu";
import { useVideoMenu } from "../../player/useVideoMenu";
import type { PlayerCommandContext } from "../../player/commands";
import type { MenuSection } from "../../player/menuModel";

const VIDEO: Track = {
  id: "v1",
  title: "Movie",
  artist: "",
  streamUrl: "/drive-stream/v1",
  originalName: "Movie.mkv",
};

/**
 * The production chain minus App's shell: the view owns the right-click and the
 * bar, one useVideoMenu owns the state, one VideoMenu renders it.
 */
function Harness({ ctx }: { ctx: PlayerCommandContext }) {
  const menu = useVideoMenu({
    ctx,
    isFullscreen: true,
    onMenuOpenChange: vi.fn(),
  });
  return (
    <div>
      <NowPlayingView
        currentTrack={VIDEO}
        isPlaying
        onTogglePlay={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        playMode="normal"
        onTogglePlayMode={vi.fn()}
        onBack={vi.fn()}
        isOpen
        token="tok"
        isShellLocked={false}
        isFullscreen
        onToggleFullscreen={vi.fn()}
        onOpenPlayerMenu={(section: MenuSection, anchor) => {
          menu.open(section, anchor);
        }}
        onOpenVideoMenuAt={(x, y) => {
          menu.open("full", { kind: "point", x, y });
        }}
      />
      <VideoMenu
        isOpen={menu.isOpen}
        entries={menu.entries}
        anchorPoint={menu.anchorPoint}
        buttonRect={menu.buttonRect}
        trigger={menu.trigger}
        onSelect={menu.select}
        onClose={menu.close}
      />
    </div>
  );
}

function makeCtx(): PlayerCommandContext {
  return {
    audio: audioMock as unknown as PlayerCommandContext["audio"],
    isFullscreen: true,
    toggleFullscreen: vi.fn(),
    toggleQueue: vi.fn(),
    isQueueOpen: false,
    selectTrack: vi.fn(),
    togglePlay: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    togglePlayMode: vi.fn(),
    setPlayMode: vi.fn(),
  };
}

let ctx: PlayerCommandContext;

function renderHarness(): void {
  ctx = makeCtx();
  render(<Harness ctx={ctx} />);
}

/** The engine snapshot: paused, fullscreen, one audio + one sub track. */
const SNAPSHOT = {
  isPaused: false,
  isFullscreen: true,
  isMuted: false,
  tracks: [
    { id: 1, type: "audio", title: "Commentary", lang: "en", selected: true },
    { id: 2, type: "sub", title: "English", lang: "en", selected: true },
  ],
  audioTrackId: 1,
  subtitleTrackId: 2,
  subtitleVisible: true,
  secondarySubtitleId: null,
  devices: [],
  currentDevice: null,
  chapters: [],
  currentChapter: -1,
  speed: 1,
  aspect: 0,
  crop: "",
  deinterlace: "no",
  subDelay: 0,
  audioDelay: 0,
  abLoop: { a: null, b: null },
  queue: [],
  currentTrackId: null,
  playMode: "normal",
  videoWidth: 1920,
  videoHeight: 1080,
} as unknown as Awaited<
  ReturnType<typeof import("../../player/menuModel").takeVideoMenuSnapshot>
>;

async function findMenu(): Promise<HTMLElement> {
  // The snapshot resolves asynchronously, so the panel appears first and the
  // rows land a tick later: wait for the ROWS, not just the container.
  await waitFor(() => {
    expect(
      document.body.querySelectorAll('[role="menu"] [role="menuitem"]').length,
    ).toBeGreaterThan(0);
  });
  const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
  if (!menu) throw new Error("video menu not rendered");
  return menu;
}

function rowSignature(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole("menuitem")
    .map(
      (el) => `${String(el.dataset["menuId"])}=${el.textContent?.trim() ?? ""}`,
    );
}

function moreButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "player.more" });
}

function rightClickAt(x: number, y: number): MouseEvent {
  const area = screen.getByTestId("video-area");
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  area.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  nativeMenuMock.showContextMenu.mockReset();
  snapshotMock.takeVideoMenuSnapshot.mockReset();
  snapshotMock.takeVideoMenuSnapshot.mockResolvedValue(SNAPSHOT);
});

afterEach(() => {
  cleanup();
});

describe("video menu: two entry points, one menu", () => {
  it("the More button opens the DrPlay menu and never the native popup", async () => {
    renderHarness();
    expect(document.body.querySelector('[role="menu"]')).toBeNull();

    fireEvent.click(moreButton());
    const menu = await findMenu();

    // Real menuModel labels for the "full" section.
    const ids = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.dataset["menuId"]);
    // Top-level rows come from the real buildContextMenuModel("full").
    expect(ids).toContain("PLAYER_PLAY_PAUSE");
    expect(ids).toContain("menu:audio");
    expect(ids).toContain("menu:video");
    expect(ids).toContain("menu:subtitle");
    expect(ids).toContain("menu:playback");
    expect(ids).toContain("menu:playlist");
    expect(nativeMenuMock.showContextMenu).not.toHaveBeenCalled();
    expect(
      invokeMock.mock.calls.some((call) => call[0] === "show_context_menu"),
    ).toBe(false);
  });

  it("right-click opens the SAME menu, anchored at the pointer", async () => {
    renderHarness();

    rightClickAt(140, 260);
    const menu = await findMenu();

    expect(menu.style.left).toBe("140px");
    expect(menu.style.top).toBe("260px");
    expect(nativeMenuMock.showContextMenu).not.toHaveBeenCalled();
  });

  it("both entry points render identical entries (same ids AND labels)", async () => {
    renderHarness();

    fireEvent.click(moreButton());
    const fromButton = rowSignature(await findMenu());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitForClosed();

    rightClickAt(140, 260);
    const fromPoint = rowSignature(await findMenu());

    expect(fromPoint).toEqual(fromButton);
    expect(fromButton.length).toBeGreaterThan(5);
  });

  it("right-click does not open a native or browser context menu", async () => {
    renderHarness();
    const before = invokeMock.mock.calls.length;

    const event = rightClickAt(10, 10);
    await findMenu();

    expect(event.defaultPrevented).toBe(true);
    expect(nativeMenuMock.showContextMenu).not.toHaveBeenCalled();
    // The snapshot already reads what it needs from the store, so opening the
    // menu adds no IPC at all — in particular no show_context_menu.
    expect(invokeMock.mock.calls.length).toBe(before);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === "show_context_menu"),
    ).toBe(false);
  });

  it("selecting an entry dispatches through the command path exactly once", async () => {
    renderHarness();

    fireEvent.click(moreButton());
    const menu = await findMenu();
    // Selected by id: menuModel resolves the label through i18next, which is not
    // initialised in this suite, so the label is the key.
    fireEvent.click(
      menu.querySelector<HTMLElement>(
        '[role="menuitem"][data-menu-id="PLAYER_PLAY_PAUSE"]',
      ) as HTMLElement,
    );

    expect(ctx.togglePlay).toHaveBeenCalledTimes(1);
    await waitForClosed();
  });

  it("a submenu (audio tracks) renders and opens in the DrPlay style", async () => {
    renderHarness();

    rightClickAt(50, 50);
    const menu = await findMenu();
    fireEvent.click(
      menu.querySelector<HTMLElement>(
        '[role="menuitem"][data-menu-id="menu:audio"]',
      ) as HTMLElement,
    );

    const submenu = await waitFor(() => {
      const el = document.body.querySelector<HTMLElement>(
        '[role="menu"][data-submenu="true"]',
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(submenu.className).toContain("dark:bg-[#2a2b2f]");
    expect(submenu.className).toContain("rounded-xl");
    // The audio section is itself the parent of the track/device/delay rows —
    // the tree menuModel builds, nested one level deeper.
    expect(
      Array.from(submenu.querySelectorAll("[data-menu-id]")).map(
        (el) => (el as HTMLElement).dataset["menuId"],
      ),
    ).toEqual(
      expect.arrayContaining([
        "menu:audio-track",
        "menu:audio-device",
        "PLAYER_MUTE",
        "menu:audio-delay",
      ]),
    );

    // Drill into the audio TRACKS: "No audio" plus the snapshot's track.
    fireEvent.click(
      submenu.querySelector<HTMLElement>(
        '[data-menu-id="menu:audio-track"]',
      ) as HTMLElement,
    );
    await waitFor(() => {
      expect(
        document.body.querySelectorAll('[role="menu"][data-submenu="true"]')
          .length,
      ).toBe(2);
    });
    const tracks = Array.from(
      document.body.querySelectorAll('[data-menu-id^="menu:audio:"]'),
    ).map((el) => (el as HTMLElement).dataset["menuId"]);
    expect(tracks).toContain("menu:audio:no");
    expect(tracks).toContain("menu:audio:1");
  });

  it("Escape closes the menu from either entry point", async () => {
    renderHarness();

    fireEvent.click(moreButton());
    await findMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitForClosed();

    rightClickAt(30, 30);
    await findMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitForClosed();
  });

  it("exactly ONE trigger button exists (the menu adds no second More)", async () => {
    renderHarness();

    fireEvent.click(moreButton());
    await findMenu();

    // One ⋯ on the bar (labelled player.more), and the portaled menu adds none.
    expect(screen.getAllByRole("button", { name: "player.more" })).toHaveLength(
      1,
    );
    // MoreMenu's own trigger would be labelled common.more_actions.
    expect(
      document.body.querySelectorAll('[aria-label="common.more_actions"]'),
    ).toHaveLength(0);
    // The menu's aria-haspopup rows are MENU rows (they carry data-menu-id),
    // never trigger buttons.
    const popupRows = Array.from(
      document.body.querySelectorAll<HTMLElement>('[aria-haspopup="menu"]'),
    );
    expect(popupRows.length).toBeGreaterThan(0);
    for (const row of popupRows) {
      expect(row.tagName).toBe("BUTTON");
      expect(row.getAttribute("role")).toBe("menuitem");
      expect(row.dataset["menuId"]).toBeTruthy();
    }
  });

  it("normal pointer input still works while the menu is open", async () => {
    renderHarness();

    rightClickAt(5, 5);
    const menu = await findMenu();
    fireEvent.click(
      menu.querySelector<HTMLElement>(
        '[role="menuitem"][data-menu-id="PLAYER_PLAY_PAUSE"]',
      ) as HTMLElement,
    );
    await waitForClosed();

    fireEvent.click(moreButton());
    await findMenu();
  });
});

async function waitForClosed(): Promise<void> {
  await screen.findByTestId("video-surface");
  if (document.body.querySelector('[role="menu"]') !== null) {
    // still closing: flush one more microtask turn
    await Promise.resolve();
  }
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
}
