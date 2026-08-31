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
import { MoreMenu } from "./MoreMenu";
import { getContextMenuStyle } from "./MoreMenu/menuPositioning";
import en from "../../locales/en/translation.json";
import type { Track } from "../../types";
import type { DriveItem } from "../../types";
import { DEBUG_EVENTS } from "../debug/debugEvents";
import { handleGlobalBack } from "../../hooks/useHardwareBack";

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
  getPlaylists: vi.fn(),
  addTrackToPlaylist: vi.fn(),
  // PlaylistPickerModal (Slice 2) manages playlists inline: the modal imports
  // these util functions, so the mock must export them even though the
  // MoreMenu-level tests only exercise pick/add-track flows.
  createPlaylist: vi.fn(),
  updatePlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  uploadManager: {
    isUploading: vi.fn(),
    subscribe: vi.fn((cb: () => void) => {
      void cb;
      return () => {};
    }),
  },
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

// Slice 1/2: mobile compaction + the playlist-picker modal are gated by
// IS_MOBILE. The getter keeps the named-export binding live so each test can
// flip the platform mid-file (SeekBar.test / PlayerBar.test pattern).
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

vi.mock("../../utils/driveApi", () => mocks.driveApi);
vi.mock("../../db/db", () => ({ db: mocks.db }));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
}));
vi.mock("../../utils/uploadManager", () => mocks.uploadManager);
vi.mock("../../utils/playlists", () => ({
  getPlaylists: mocks.getPlaylists,
  addTrackToPlaylist: mocks.addTrackToPlaylist,
  createPlaylist: mocks.createPlaylist,
  updatePlaylist: mocks.updatePlaylist,
  deletePlaylist: mocks.deletePlaylist,
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

function openTrigger(): void {
  const trigger = document.querySelector(
    '[aria-haspopup="menu"]',
  ) as HTMLButtonElement;
  expect(trigger).not.toBeNull();
  fireEvent.click(trigger);
}

function menuButtonNames(): string[] {
  return within(menuEl())
    .getAllByRole("button")
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
    expect(menuButtonNames().sort()).toEqual([
      "Add to Playlist",
      "Delete",
      "Download Song",
      "Locate File",
    ]);
    expect(
      within(menuEl()).queryByRole("button", { name: "Select multiple items" }),
    ).toBeNull();
    expect(
      within(menuEl()).queryByRole("button", { name: "Move to..." }),
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
    expect(menuButtonNames().sort()).toEqual([
      "Add to Playlist",
      "Download Song",
      "Locate File",
    ]);
  });

  it("hides Delete when driveItem is missing (track-only render) but keeps track-based items", () => {
    render(<MoreMenu variant="recent" track={makeTrack()} token="tok" />);
    openTrigger();
    expect(menuButtonNames().sort()).toEqual([
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
      within(menuEl()).getByRole("button", { name: "Locate File" }),
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
    fireEvent.click(within(menuEl()).getByRole("button", { name: "Delete" }));
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
      within(menuEl()).getByRole("button", { name: "Download Song" }),
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
      within(menuEl()).getByRole("button", { name: "Add to Playlist" }),
    );
    expect(screen.getByText("Playlists")).toBeTruthy();
  });
});

describe("MoreMenu default variant regression (file list)", () => {
  it("keeps the original 5 items (Select Multiple / Move to / Delete / Download / Add to Playlist)", () => {
    render(
      <MoreMenu track={makeTrack()} driveItem={makeDriveItem()} token="tok" />,
    );
    openTrigger();
    expect(menuButtonNames().sort()).toEqual([
      "Add to Playlist",
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
    expect(menuButtonNames().sort()).toEqual([
      "Add to Playlist",
      "Delete",
      "Download Song",
      "Move to...",
      "Select multiple items",
    ]);
  });
});

describe("MoreMenu playerbar variant regression", () => {
  it("keeps the original 2 track items (Download Song / Locate File) plus shared Add to Playlist, no Delete", () => {
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    expect(menuButtonNames().sort()).toEqual([
      "Add to Playlist",
      "Download Song",
      "Locate File",
    ]);
    expect(
      within(menuEl()).queryByRole("button", { name: "Delete" }),
    ).toBeNull();
    expect(
      within(menuEl()).queryByRole("button", { name: "Select multiple items" }),
    ).toBeNull();
  });

  it("still dispatches locate-file with the same detail as before", () => {
    const spy = vi.fn();
    window.addEventListener("locate-file", spy);
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("button", { name: "Locate File" }),
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

describe("MoreMenu playerbar favorite item (heart moved into menu)", () => {
  it("renders an Add to favorites item when isFavorite + onToggleFavorite are both provided", () => {
    render(
      <MoreMenu
        isPlayerBarMode
        track={makeTrack()}
        isFavorite={false}
        onToggleFavorite={vi.fn()}
      />,
    );
    openTrigger();
    expect(
      within(menuEl()).getByRole("button", { name: "Add to favorites" }),
    ).toBeTruthy();
    expect(menuButtonNames().sort()).toEqual([
      "Add to Playlist",
      "Add to favorites",
      "Download Song",
      "Locate File",
    ]);
  });

  it("switches the label to Remove from favorites when the track is liked", () => {
    render(
      <MoreMenu
        isPlayerBarMode
        track={makeTrack()}
        isFavorite={true}
        onToggleFavorite={vi.fn()}
      />,
    );
    openTrigger();
    expect(
      within(menuEl()).getByRole("button", { name: "Remove from favorites" }),
    ).toBeTruthy();
    expect(
      within(menuEl()).queryByRole("button", { name: "Add to favorites" }),
    ).toBeNull();
  });

  it("clicking the item calls onToggleFavorite and closes the menu", () => {
    const onToggleFavorite = vi.fn();
    render(
      <MoreMenu
        isPlayerBarMode
        track={makeTrack()}
        isFavorite={false}
        onToggleFavorite={onToggleFavorite}
      />,
    );
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("button", { name: "Add to favorites" }),
    );
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("does not render the heart item when only one of the two props is provided", () => {
    render(
      <MoreMenu
        isPlayerBarMode
        track={makeTrack()}
        isFavorite={false}
        onToggleFavorite={undefined}
      />,
    );
    openTrigger();
    expect(
      within(menuEl()).queryByRole("button", { name: "Add to favorites" }),
    ).toBeNull();
    expect(
      within(menuEl()).queryByRole("button", { name: "Remove from favorites" }),
    ).toBeNull();
  });

  it("does not render the heart item in default mode even with the props provided", () => {
    render(
      <MoreMenu
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
        isFavorite={false}
        onToggleFavorite={vi.fn()}
      />,
    );
    openTrigger();
    expect(
      within(menuEl()).queryByRole("button", { name: "Add to favorites" }),
    ).toBeNull();
    expect(menuButtonNames().sort()).toEqual([
      "Add to Playlist",
      "Delete",
      "Download Song",
      "Move to...",
      "Select multiple items",
    ]);
  });
});

describe("MoreMenu upload race guards", () => {
  let notify: (() => void) | undefined;

  beforeEach(() => {
    notify = undefined;
    mocks.uploadManager.isUploading.mockReset();
    mocks.uploadManager.isUploading.mockReturnValue(false);
    mocks.uploadManager.subscribe.mockImplementation((cb: () => void) => {
      notify = cb;
      return () => {};
    });
  });

  it("disables every destructive item with the blocking tooltip when driveItem is uploading (default variant)", () => {
    mocks.uploadManager.isUploading.mockReturnValue(true);
    render(
      <MoreMenu track={makeTrack()} driveItem={makeDriveItem()} token="tok" />,
    );
    openTrigger();
    const buttons = within(menuEl()).getAllByRole("button");
    for (const name of [
      "Select multiple items",
      "Move to...",
      "Delete",
      "Download Song",
      "Add to Playlist",
    ]) {
      const btn = buttons.find((b) => b.textContent?.trim() === name);
      expect(btn, `button ${name} should exist`).toBeDefined();
      expect(
        (btn as HTMLButtonElement).disabled,
        `button ${name} disabled`,
      ).toBe(true);
      expect((btn as HTMLButtonElement).title, `button ${name} tooltip`).toBe(
        "This item is already uploading. Wait a moment.",
      );
    }
  });

  it("leaves all items enabled and tooltip-free when the item is not uploading (old behavior)", () => {
    render(
      <MoreMenu track={makeTrack()} driveItem={makeDriveItem()} token="tok" />,
    );
    openTrigger();
    const buttons = within(menuEl()).getAllByRole("button");
    for (const name of [
      "Select multiple items",
      "Move to...",
      "Delete",
      "Download Song",
      "Add to Playlist",
    ]) {
      const btn = buttons.find((b) => b.textContent?.trim() === name);
      expect(btn, `button ${name} should exist`).toBeDefined();
      expect(
        (btn as HTMLButtonElement).disabled,
        `button ${name} not disabled`,
      ).toBe(false);
      expect(
        (btn as HTMLButtonElement).title,
        `button ${name} no tooltip`,
      ).toBe("");
    }
  });

  it("disables Download Song + Add to Playlist for a track uploading in playerbar mode, keeps Locate File enabled", () => {
    mocks.uploadManager.isUploading.mockReturnValue(true);
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    const buttons = within(menuEl()).getAllByRole("button");
    const byName = (name: string) =>
      buttons.find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
    expect(byName("Download Song").disabled).toBe(true);
    expect(byName("Add to Playlist").disabled).toBe(true);
    expect(byName("Locate File").disabled).toBe(false);
    expect(byName("Locate File").title).toBe("");
  });

  it("disables Delete for an uploading driveItem in recent variant, keeps Locate File enabled", () => {
    mocks.uploadManager.isUploading.mockReturnValue(true);
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
      />,
    );
    openTrigger();
    const buttons = within(menuEl()).getAllByRole("button");
    const byName = (name: string) =>
      buttons.find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
    expect(byName("Delete").disabled).toBe(true);
    expect(byName("Delete").title).toBe(
      "This item is already uploading. Wait a moment.",
    );
    expect(byName("Locate File").disabled).toBe(false);
  });

  it("re-renders and disables the destructive items when an upload starts while the menu is open (subscription)", () => {
    render(
      <MoreMenu track={makeTrack()} driveItem={makeDriveItem()} token="tok" />,
    );
    openTrigger();
    expect(
      within(menuEl()).getByRole<HTMLButtonElement>("button", {
        name: "Delete",
      }).disabled,
    ).toBe(false);

    mocks.uploadManager.isUploading.mockReturnValue(true);
    act(() => {
      notify?.();
    });

    const btn = within(menuEl()).getByRole<HTMLButtonElement>("button", {
      name: "Delete",
    });
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("This item is already uploading. Wait a moment.");
  });

  it("blocks adding to playlist when the upload starts after the submenu is already open (handler guard)", async () => {
    mocks.getPlaylists.mockResolvedValue([{ id: "p1", name: "Playlist One" }]);
    render(
      <MoreMenu track={makeTrack()} driveItem={makeDriveItem()} token="tok" />,
    );
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("button", { name: "Add to Playlist" }),
    );
    expect(screen.getByText("Playlists")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Playlist One" })).toBeTruthy();
    });

    mocks.uploadManager.isUploading.mockReturnValue(true);
    act(() => notify?.());

    fireEvent.click(screen.getByRole("button", { name: "Playlist One" }));
    expect(mocks.addTrackToPlaylist).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).toHaveBeenCalledWith(
      "This item is already uploading. Wait a moment.",
    );
  });

  it("blocks the delete confirm action when the upload starts after the dialog is open (handler guard)", () => {
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
        onRefresh={vi.fn()}
      />,
    );
    openTrigger();
    fireEvent.click(within(menuEl()).getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Move to Trash?")).toBeTruthy();

    mocks.uploadManager.isUploading.mockReturnValue(true);
    act(() => notify?.());

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(mocks.driveApi.deleteFile).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).toHaveBeenCalledWith(
      "This item is already uploading. Wait a moment.",
    );
  });
});

describe("MoreMenu compact trigger (Task 13 mobile sizing)", () => {
  it("compact renders the smaller trigger (h-7 w-7 target, 16px ellipsis)", () => {
    render(<MoreMenu isPlayerBarMode compact track={makeTrack()} />);
    const trigger = document.querySelector(
      '[aria-haspopup="menu"]',
    ) as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.className).toContain("h-7");
    expect(trigger.className).toContain("w-7");
    expect(trigger.className).not.toContain("h-8");
    expect(trigger.innerHTML).toContain("w-4 h-4");
  });

  it("keeps the desktop trigger size when compact is absent (p-2, 20px ellipsis)", () => {
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    const trigger = document.querySelector(
      '[aria-haspopup="menu"]',
    ) as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.className).toContain("p-2");
    expect(trigger.className).not.toContain("h-8");
    expect(trigger.innerHTML).toContain("w-5 h-5");
  });
});

// Slice 1 (mobile menu compaction): every row, its icon and the dropdown
// panel shrink on IS_MOBILE. Desktop tokens must stay byte-identical.
describe("MoreMenu mobile compact rows (Slice 1)", () => {
  afterEach(() => {
    platformMock.IS_MOBILE = false;
    cleanup();
  });

  function rowButton(name: string): HTMLElement {
    return within(menuEl()).getByRole("button", { name });
  }

  function classesOf(el: Element | null): string[] {
    return (el?.getAttribute("class") ?? "").split(/\s+/);
  }

  it("mobile: playerbar rows carry the compact tokens (px-2.5 py-1.5 text-[13px] mb-0.5)", () => {
    platformMock.IS_MOBILE = true;
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    const row = classesOf(rowButton("Download Song"));
    expect(row).toEqual(
      expect.arrayContaining(["px-2.5", "py-1.5", "text-[13px]", "mb-0.5"]),
    );
    expect(row).not.toContain("py-2");
    expect(row).not.toContain("text-sm");
  });

  it("mobile: the dropdown panel uses p-1 instead of p-1.5 (w-60 untouched)", () => {
    platformMock.IS_MOBILE = true;
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    const menu = classesOf(menuEl());
    expect(menu).toContain("p-1");
    expect(menu).not.toContain("p-1.5");
    expect(menu).toContain("w-60");
  });

  it("mobile: default row icons shrink to w-3.5 h-3.5", () => {
    platformMock.IS_MOBILE = true;
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    const icon = classesOf(rowButton("Locate File").querySelector("svg"));
    expect(icon).toEqual(expect.arrayContaining(["w-3.5", "h-3.5"]));
    expect(icon).not.toContain("w-4");
  });

  it("mobile: an explicit iconClassName override still wins", () => {
    platformMock.IS_MOBILE = true;
    render(
      <MoreMenu track={makeTrack()} driveItem={makeDriveItem()} token="tok" />,
    );
    openTrigger();
    const icon = classesOf(
      rowButton("Select multiple items").querySelector("svg"),
    );
    expect(icon).toEqual(expect.arrayContaining(["w-4", "h-4"]));
    expect(icon).not.toContain("w-3.5");
  });

  it("mobile: the recent-variant Delete row (delete-class variant) is compact too", () => {
    platformMock.IS_MOBILE = true;
    render(
      <MoreMenu
        variant="recent"
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
      />,
    );
    openTrigger();
    const row = classesOf(rowButton("Delete"));
    expect(row).toEqual(
      expect.arrayContaining(["px-2.5", "py-1.5", "text-[13px]", "mb-0.5"]),
    );
  });

  it("desktop: rows keep the original tokens byte-identical (px-3 py-2 text-sm mb-1)", () => {
    platformMock.IS_MOBILE = false;
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    const row = classesOf(rowButton("Download Song"));
    expect(row).toEqual(
      expect.arrayContaining(["px-3", "py-2", "text-sm", "mb-1"]),
    );
    expect(row).not.toContain("text-[13px]");
  });

  it("desktop: panel keeps p-1.5 and default icons stay w-4 h-4", () => {
    platformMock.IS_MOBILE = false;
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    expect(classesOf(menuEl())).toContain("p-1.5");
    const icon = classesOf(rowButton("Locate File").querySelector("svg"));
    expect(icon).toEqual(expect.arrayContaining(["w-4", "h-4"]));
    expect(icon).not.toContain("w-3.5");
  });
});

// Slice 2 (mobile playlist picker): on IS_MOBILE the Add to Playlist item
// must open a standalone modal â€” the nested submenu clips off-screen near
// the player bar's bottom-right edge. Desktop keeps the submenu flow.
describe("MoreMenu mobile playlist picker (Slice 2)", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = true;
    mocks.uploadManager.isUploading.mockReset();
    mocks.uploadManager.isUploading.mockReturnValue(false);
    mocks.addTrackToPlaylist.mockResolvedValue(undefined);
  });

  afterEach(() => {
    platformMock.IS_MOBILE = false;
    cleanup();
  });

  async function openPicker(): Promise<void> {
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    // The playlists fetch resolves after the menu's effect runs; flush the
    // microtask BEFORE opening the picker (a real user's tap latency). Once
    // the menu closes, the hook's ignore-guard would skip the late result â€”
    // same pre-existing race the desktop submenu has.
    await act(async () => {});
    fireEvent.click(
      within(menuEl()).getByRole("button", { name: "Add to Playlist" }),
    );
  }

  it("mobile: Add to Playlist opens the picker dialog, not the nested submenu", async () => {
    mocks.getPlaylists.mockResolvedValue([
      {
        id: "p1",
        userEmail: "me@example.com",
        name: "Playlist One",
        createdAt: 1,
        tracks: [],
      },
    ]);
    await openPicker();
    await act(async () => {});

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(screen.queryByText("Playlists")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByPlaceholderText("Search...")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Playlist One" })).toBeTruthy();
  });

  it("mobile: picking a playlist calls addTrackToPlaylist with the right id and closes dialog + menu", async () => {
    const track = makeTrack();
    mocks.getPlaylists.mockResolvedValue([
      {
        id: "p1",
        userEmail: "me@example.com",
        name: "Playlist One",
        createdAt: 1,
        tracks: [],
      },
    ]);
    render(<MoreMenu isPlayerBarMode track={track} />);
    openTrigger();
    await act(async () => {});
    fireEvent.click(
      within(menuEl()).getByRole("button", { name: "Add to Playlist" }),
    );
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Playlist One" }));
    await waitFor(() => {
      expect(mocks.addTrackToPlaylist).toHaveBeenCalledWith("p1", track);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("mobile: an upload that starts after the picker opens shows the toast and keeps the dialog open", async () => {
    mocks.getPlaylists.mockResolvedValue([
      {
        id: "p1",
        userEmail: "me@example.com",
        name: "Playlist One",
        createdAt: 1,
        tracks: [],
      },
    ]);
    await openPicker();
    // Rows come from the modal's own open-fetch (localPlaylists), so flush
    // the microtask before clicking a row.
    await act(async () => {});
    expect(screen.getByRole("dialog")).toBeTruthy();

    mocks.uploadManager.isUploading.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Playlist One" }));

    await waitFor(() => {
      expect(mocks.showErrorToast).toHaveBeenCalledWith(
        "This item is already uploading. Wait a moment.",
      );
    });
    expect(mocks.addTrackToPlaylist).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("desktop: Add to Playlist still opens the nested submenu and never the dialog", () => {
    platformMock.IS_MOBILE = false;
    render(<MoreMenu isPlayerBarMode track={makeTrack()} />);
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("button", { name: "Add to Playlist" }),
    );
    expect(screen.getByText("Playlists")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
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

// Batch back-button fix (2026-08-17): MoreMenu's portal-hosted sub-dialogs
// (DownloadDialog / DeleteConfirmDialog / FolderSelectionScreen) and the menu
// dropdown itself must all register a hardware-back handler â€” otherwise the
// native back falls through the App-level chain to the MyDrive tab layer and
// jumps Home (or out of the app). The fix calls handleGlobalBack() with the
// real module-level stack (no mock) so the same LIFO ordering the native
// listener uses is exercised end-to-end.
describe("MoreMenu hardware-back closes UI (batch fix 2026-08-17)", () => {
  // Real-world behavior (verified by reading DefaultMenuItems / useMenuDownload):
  // every menu item closes the dropdown THEN opens its dialog/screen â€” so the
  // back handler never has to peel dialog-off-menu, only dialog-or-menu.

  beforeEach(() => {
    // Earlier describe blocks (upload race guards) leave isUploading returning
    // truthy across tests; reset it so the new test renders the live menu.
    mocks.uploadManager.isUploading.mockReset();
    mocks.uploadManager.isUploading.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  function pressBack(): boolean {
    // Wrap in act() so the state updates the back handler triggers (e.g.
    // setIsOpen(false)) flush through to the DOM before we assert.
    let consumed = false;
    act(() => {
      consumed = handleGlobalBack();
    });
    return consumed;
  }

  it("closes the dropdown menu when open (no dialogs) -> handleGlobalBack() true, then false", () => {
    render(<MoreMenu track={makeTrack()} token="tok" />);
    openTrigger();
    expect(menuEl()).toBeTruthy();

    expect(pressBack()).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    expect(pressBack()).toBe(false);
  });

  it("closes the DownloadDialog when open (menu auto-closed by item click)", () => {
    render(<MoreMenu track={makeTrack()} token="tok" />);
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("button", { name: "Download Song" }),
    );
    expect(screen.getByText("File name")).toBeTruthy();
    // Menu auto-closed when Download Song was clicked (handleDownloadClick
    // calls setIsOpen(false) â€” verified by reading useMenuDownload).
    expect(document.querySelector('[role="menu"]')).toBeNull();

    expect(pressBack()).toBe(true);
    expect(screen.queryByText("File name")).toBeNull();

    expect(pressBack()).toBe(false);
  });

  it("closes the DeleteConfirmDialog when open (menu auto-closed by item click)", () => {
    render(
      <MoreMenu track={makeTrack()} driveItem={makeDriveItem()} token="tok" />,
    );
    openTrigger();
    fireEvent.click(within(menuEl()).getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Move to Trash?")).toBeTruthy();
    expect(document.querySelector('[role="menu"]')).toBeNull();

    expect(pressBack()).toBe(true);
    expect(screen.queryByText("Move to Trash?")).toBeNull();

    expect(pressBack()).toBe(false);
  });

  it("closes the Move FolderSelectionScreen when open (menu auto-closed by item click)", () => {
    render(
      <MoreMenu
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
        currentFolderId="parent-1"
        currentFolderName="Folder One"
      />,
    );
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("button", { name: "Move to..." }),
    );
    // FolderSelectionScreen renders the title in an <h1>.
    expect(screen.getByRole("heading", { name: "Move to..." })).toBeTruthy();
    expect(document.querySelector('[role="menu"]')).toBeNull();

    expect(pressBack()).toBe(true);
    expect(screen.queryByRole("heading", { name: "Move to..." })).toBeNull();

    expect(pressBack()).toBe(false);
  });

  it("prioritizes DownloadDialog > DeleteConfirm > MoveScreen > Menu", () => {
    // The default-variant menu item order is: Select Multiple / Move to /
    // Delete / Download Song / Add to Playlist. Each item closes the menu
    // and opens its own dialog. We re-open the menu between clicks to layer
    // each dialog on top of the previous one (the real product can't
    // actually do this because the dialog backdrop blocks further clicks â€”
    // this test simulates the layering by re-opening the menu manually).
    const { rerender } = render(
      <MoreMenu
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
        currentFolderId="parent-1"
        currentFolderName="Folder One"
      />,
    );

    // Layer 1: open Move (menu closes, screen shows).
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("button", { name: "Move to..." }),
    );
    expect(screen.getByRole("heading", { name: "Move to..." })).toBeTruthy();

    // Reopen menu + open Delete â€” Delete sits "above" Move in the
    // handler's priority (innermost = first peeled).
    openTrigger();
    fireEvent.click(within(menuEl()).getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Move to Trash?")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Move to..." })).toBeTruthy();

    // Reopen menu + open Download â€” Download is the topmost layer.
    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("button", { name: "Download Song" }),
    );
    expect(screen.getByText("File name")).toBeTruthy();
    expect(screen.getByText("Move to Trash?")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Move to..." })).toBeTruthy();

    // First back peels Download only.
    expect(pressBack()).toBe(true);
    expect(screen.queryByText("File name")).toBeNull();
    expect(screen.getByText("Move to Trash?")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Move to..." })).toBeTruthy();

    // Second back peels Delete.
    expect(pressBack()).toBe(true);
    expect(screen.queryByText("Move to Trash?")).toBeNull();
    expect(screen.getByRole("heading", { name: "Move to..." })).toBeTruthy();

    // Third back peels Move.
    expect(pressBack()).toBe(true);
    expect(screen.queryByRole("heading", { name: "Move to..." })).toBeNull();

    // Fourth back with everything closed falls through.
    expect(pressBack()).toBe(false);

    // Touch rerender so the variable is "used" (lint suppression).
    expect(rerender).toBeDefined();
  });

  it("calls onClose when back closes the menu itself", () => {
    const onClose = vi.fn();
    render(<MoreMenu track={makeTrack()} token="tok" onClose={onClose} />);
    openTrigger();

    expect(pressBack()).toBe(true);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("removes the back handler on unmount (no leak across tests)", () => {
    const { unmount } = render(<MoreMenu track={makeTrack()} token="tok" />);
    openTrigger();
    unmount();

    expect(pressBack()).toBe(false);
  });
});

// Bugfix (2026-08-23): the document-level Escape listener in useMoreMenuEvents
// closed the dropdown even when a portal dialog was stacked above it,
// orphaning the dialog. Escape must mirror the exact LIFO priority of the
// hardware-back handler in MoreMenu.tsx (Download > Delete > Move > menu).
describe("MoreMenu Escape respects overlay priority (bugfix 2026-08-23)", () => {
  beforeEach(() => {
    mocks.uploadManager.isUploading.mockReset();
    mocks.uploadManager.isUploading.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  function pressEscape(): void {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
  }

  function layerAllThreeOverlays(): void {
    render(
      <MoreMenu
        track={makeTrack()}
        driveItem={makeDriveItem()}
        token="tok"
        currentFolderId="parent-1"
        currentFolderName="Folder One"
      />,
    );

    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("button", { name: "Move to..." }),
    );
    expect(screen.getByRole("heading", { name: "Move to..." })).toBeTruthy();

    openTrigger();
    fireEvent.click(within(menuEl()).getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Move to Trash?")).toBeTruthy();

    openTrigger();
    fireEvent.click(
      within(menuEl()).getByRole("button", { name: "Download Song" }),
    );
    expect(screen.getByText("File name")).toBeTruthy();

    // Re-open the dropdown on top of all three dialogs (the real product
    // cannot do this because the dialog backdrop blocks clicks â€” same
    // simulated-layering trick as the hardware-back priority test above).
    openTrigger();
    expect(menuEl()).toBeTruthy();
  }

  it("peels DownloadDialog > DeleteConfirm > MoveScreen > menu, one per Escape", () => {
    layerAllThreeOverlays();

    // First Escape peels only Download; menu and lower layers stay.
    pressEscape();
    expect(screen.queryByText("File name")).toBeNull();
    expect(screen.getByText("Move to Trash?")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Move to..." })).toBeTruthy();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // Second Escape peels Delete; menu still open.
    pressEscape();
    expect(screen.queryByText("Move to Trash?")).toBeNull();
    expect(screen.getByRole("heading", { name: "Move to..." })).toBeTruthy();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // Third Escape peels Move; menu still open.
    pressEscape();
    expect(screen.queryByRole("heading", { name: "Move to..." })).toBeNull();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // Fourth Escape finally closes the dropdown itself.
    pressEscape();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("closes the DeleteConfirmDialog when the menu is already closed (real item-click flow)", () => {
    render(
      <MoreMenu track={makeTrack()} driveItem={makeDriveItem()} token="tok" />,
    );
    openTrigger();
    fireEvent.click(within(menuEl()).getByRole("button", { name: "Delete" }));
    // Real flow: clicking Delete closes the menu THEN opens its dialog, so
    // the keydown listener must stay armed while only a dialog is open.
    expect(screen.getByText("Move to Trash?")).toBeTruthy();
    expect(document.querySelector('[role="menu"]')).toBeNull();

    pressEscape();
    expect(screen.queryByText("Move to Trash?")).toBeNull();
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
      name: "identity: long-press point fits left+down â†’ values unchanged",
      vw: 1280,
      vh: 800,
      anchorPoint: { x: 100, y: 100 },
      buttonRect: null,
      openUpwards: false,
      expected: { left: 100, top: 100 },
    },
    {
      name: "identity: trigger rect fits right+down (open downwards) â†’ values unchanged",
      vw: 1280,
      vh: 800,
      buttonRect: makeRect(100, 140, 400),
      openUpwards: false,
      expected: { right: 1280 - 400, top: 148 },
    },
    {
      name: "identity: trigger rect fits right+up (open upwards) â†’ values unchanged",
      vw: 1280,
      vh: 800,
      buttonRect: makeRect(700, 740, 400),
      openUpwards: true,
      expected: { right: 880, bottom: 800 - 700 + GAP },
    },
    {
      name: "long-press near right edge of a narrow screen â†’ menu shifted flush right",
      vw: 360,
      vh: 640,
      anchorPoint: { x: 150, y: 100 },
      buttonRect: null,
      openUpwards: false,
      expected: { left: 360 - W, top: 100 },
    },
    {
      name: "long-press right-half but too close to left edge â†’ menu pinned flush left",
      vw: 360,
      vh: 640,
      anchorPoint: { x: 200, y: 600 },
      buttonRect: null,
      openUpwards: false,
      expected: { right: 360 - W, bottom: 40 },
    },
    {
      name: "long-press in upper half too low for the menu height â†’ top clamped",
      vw: 800,
      vh: 400,
      anchorPoint: { x: 100, y: 180 },
      buttonRect: null,
      openUpwards: false,
      expected: { left: 100, top: 400 - H },
    },
    {
      name: "long-press in lower half too high for the menu height â†’ bottom clamped",
      vw: 800,
      vh: 400,
      anchorPoint: { x: 700, y: 220 },
      buttonRect: null,
      openUpwards: false,
      expected: { right: 100, bottom: 400 - H },
    },
    {
      name: "trigger near left edge on a narrow screen â†’ menu pinned flush left",
      vw: 360,
      vh: 640,
      buttonRect: makeRect(300, 340, 100),
      openUpwards: true,
      expected: { right: 360 - W, bottom: 640 - 300 + GAP },
    },
    {
      name: "trigger opens upwards but not enough room above â†’ bottom clamped",
      vw: 800,
      vh: 400,
      buttonRect: makeRect(50, 90, 500),
      openUpwards: true,
      expected: { right: 800 - 500, bottom: 400 - H },
    },
    {
      name: "trigger opens downwards but not enough room below â†’ top clamped",
      vw: 800,
      vh: 400,
      buttonRect: makeRect(160, 200, 500),
      openUpwards: false,
      expected: { right: 800 - 500, top: 400 - H },
    },
    {
      name: "window smaller than the menu on both axes â†’ pinned to top-left, no negative offsets",
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
