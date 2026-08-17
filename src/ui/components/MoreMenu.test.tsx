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
  getPlaylists: vi.fn(),
  addTrackToPlaylist: vi.fn(),
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
      expect(mocks.db.files.delete).toHaveBeenCalledWith("track-1");
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
        "This item is already uploading. Please wait.",
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
      "This item is already uploading. Please wait.",
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
    expect(btn.title).toBe("This item is already uploading. Please wait.");
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
      "This item is already uploading. Please wait.",
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
      "This item is already uploading. Please wait.",
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
