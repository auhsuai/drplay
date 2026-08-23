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

// Batch back-button fix (2026-08-17): MoreMenu's portal-hosted sub-dialogs
// (DownloadDialog / DeleteConfirmDialog / FolderSelectionScreen) and the menu
// dropdown itself must all register a hardware-back handler — otherwise the
// native back falls through the App-level chain to the MyDrive tab layer and
// jumps Home (or out of the app). The fix calls handleGlobalBack() with the
// real module-level stack (no mock) so the same LIFO ordering the native
// listener uses is exercised end-to-end.
describe("MoreMenu hardware-back closes UI (batch fix 2026-08-17)", () => {
  // Real-world behavior (verified by reading DefaultMenuItems / useMenuDownload):
  // every menu item closes the dropdown THEN opens its dialog/screen — so the
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
    // calls setIsOpen(false) — verified by reading useMenuDownload).
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
    // actually do this because the dialog backdrop blocks further clicks —
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

    // Reopen menu + open Delete — Delete sits "above" Move in the
    // handler's priority (innermost = first peeled).
    openTrigger();
    fireEvent.click(within(menuEl()).getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Move to Trash?")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Move to..." })).toBeTruthy();

    // Reopen menu + open Download — Download is the topmost layer.
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
