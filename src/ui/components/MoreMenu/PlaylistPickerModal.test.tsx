// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";
import type { TFunction } from "i18next";
import { PlaylistPickerModal } from "./PlaylistPickerModal";
import type { Playlist } from "../../../utils/playlists";
import type { Track } from "../../../types";
import en from "../../../locales/en/translation.json";

// Same hoisted platform pattern as MoreMenu.test: the picker compacts its
// rows on IS_MOBILE, so each case picks its platform.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../../../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

// Slice 2 (playlist management): the modal owns its data after mutations â€”
// the util module is mocked so API calls (create/rename/delete) and the
// refresh fetch are asserted, not executed.
const playlistsMock = vi.hoisted(() => ({
  getPlaylists: vi.fn(),
  createPlaylist: vi.fn(),
  updatePlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  addTrackToPlaylist: vi.fn(),
}));
vi.mock("../../../utils/playlists", () => ({
  getPlaylists: playlistsMock.getPlaylists,
  createPlaylist: playlistsMock.createPlaylist,
  updatePlaylist: playlistsMock.updatePlaylist,
  deletePlaylist: playlistsMock.deletePlaylist,
  addTrackToPlaylist: playlistsMock.addTrackToPlaylist,
}));

// Invalid-name feedback goes through the shared toast util.
const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }));
vi.mock("../../../utils/simpleToast", () => ({
  showErrorToast: toastMock.showErrorToast,
}));

// t is passed as a prop (PlaylistsSubmenu.test pattern), so react-i18next is
// never initialized here â€” keys resolve against the real en resources.
const t = ((key: string, fallback?: string) => {
  let acc: unknown = en;
  for (const part of key.split(".")) {
    if (typeof acc === "object" && acc !== null) {
      acc = (acc as Record<string, unknown>)[part];
    } else {
      return fallback ?? "";
    }
  }
  return (typeof acc === "string" ? acc : fallback) ?? "";
}) as unknown as TFunction;

function makePlaylist(id: string, name: string): Playlist {
  return { id, userEmail: "me@example.com", name, createdAt: 1, tracks: [] };
}

function makeTrack(): Track {
  return {
    id: "track-1",
    title: "My Song",
    artist: "Artist",
    streamUrl: "https://example.com/song",
    size: 1000,
    parentId: "parent-1",
    parentName: "Folder One",
  };
}

function renderPicker(
  playlists: Playlist[],
  open = true,
  onClose = vi.fn(),
): ReturnType<typeof render> & { onClose: ReturnType<typeof vi.fn> } {
  const utils = render(
    <PlaylistPickerModal
      open={open}
      playlists={playlists}
      track={makeTrack()}
      onClose={onClose}
      onPick={vi.fn()}
      t={t}
    />,
  );
  return { ...utils, onClose };
}

describe("PlaylistPickerModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: an empty library. Cases that list playlists mock their own
    // data â€” the modal re-fetches on every open, so the prop alone is only
    // the pre-fetch fallback.
    playlistsMock.getPlaylists.mockResolvedValue([]);
    playlistsMock.createPlaylist.mockResolvedValue(null);
    playlistsMock.updatePlaylist.mockResolvedValue(null);
    playlistsMock.deletePlaylist.mockResolvedValue(undefined);
  });

  afterEach(() => {
    platformMock.IS_MOBILE = false;
    cleanup();
  });

  it("renders nothing while closed", () => {
    const { container } = renderPicker(
      [makePlaylist("p1", "Playlist One")],
      false,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a labelled dialog with the heading and every playlist listed", async () => {
    const data = [
      makePlaylist("p1", "Playlist One"),
      makePlaylist("p2", "Party"),
    ];
    playlistsMock.getPlaylists.mockResolvedValue(data);
    renderPicker(data);
    await act(async () => {});
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Add to Playlist" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Playlist One" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Party" })).toBeTruthy();
  });

  it("moves initial focus into the search input (ModalShell initialFocusRef)", () => {
    renderPicker([makePlaylist("p1", "Playlist One")]);
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("Search..."),
    );
  });

  it("filters playlists diacritics-insensitively as the user types", async () => {
    const data = [makePlaylist("p1", "Đổi mới"), makePlaylist("p2", "Party")];
    playlistsMock.getPlaylists.mockResolvedValue(data);
    renderPicker(data);
    await act(async () => {});
    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "doi" },
    });
    expect(screen.getByRole("button", { name: "Đổi mới" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Party" })).toBeNull();
  });

  it("shows the empty-state message when no playlists exist", async () => {
    renderPicker([]);
    await act(async () => {});
    expect(screen.getByText("No playlists yet")).toBeTruthy();
  });

  it("calls onPick with the clicked playlist id", async () => {
    const data = [makePlaylist("p1", "Playlist One")];
    playlistsMock.getPlaylists.mockResolvedValue(data);
    const onPick = vi.fn();
    render(
      <PlaylistPickerModal
        open
        playlists={data}
        track={makeTrack()}
        onClose={vi.fn()}
        onPick={onPick}
        t={t}
      />,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Playlist One" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    const firstCall = onPick.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected onPick call");
    expect(firstCall[1]).toBe("p1");
  });

  it("compacts rows on mobile and keeps the desktop row tokens", async () => {
    platformMock.IS_MOBILE = true;
    const data = [makePlaylist("p1", "Playlist One")];
    playlistsMock.getPlaylists.mockResolvedValue(data);
    const { unmount } = renderPicker(data);
    await act(async () => {});
    const mobileRow = screen.getByRole("button", { name: "Playlist One" });
    expect(mobileRow.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["py-1.5", "text-[13px]"]),
    );
    unmount();

    platformMock.IS_MOBILE = false;
    playlistsMock.getPlaylists.mockResolvedValue(data);
    renderPicker(data);
    await act(async () => {});
    const desktopRow = screen.getByRole("button", { name: "Playlist One" });
    expect(desktopRow.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["py-2", "text-sm"]),
    );
  });

  it("re-fetches playlists from the util when the modal opens", async () => {
    renderPicker([makePlaylist("p1", "Playlist One")]);
    await waitFor(() => {
      expect(playlistsMock.getPlaylists).toHaveBeenCalledTimes(1);
    });
  });
});

// Slice 2 (playlist management inside the mobile picker): the modal gains a
// close button, an inline create flow and per-row inline rename/delete. All
// confirmations stay INLINE inside the modal â€” no nested popups.
describe("PlaylistPickerModal playlist management (Slice 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    playlistsMock.getPlaylists.mockResolvedValue([
      makePlaylist("p1", "Playlist One"),
      makePlaylist("p2", "Playlist Two"),
    ]);
    playlistsMock.createPlaylist.mockResolvedValue(null);
    playlistsMock.updatePlaylist.mockResolvedValue(null);
    playlistsMock.deletePlaylist.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  async function renderOpenPicker(
    onClose = vi.fn(),
  ): Promise<
    ReturnType<typeof render> & { onClose: ReturnType<typeof vi.fn> }
  > {
    const utils = renderPicker(
      [makePlaylist("p1", "Playlist One"), makePlaylist("p2", "Playlist Two")],
      true,
      onClose,
    );
    await act(async () => {});
    return utils;
  }

  it("shows the X close button in the header and clicking it calls onClose", async () => {
    const { onClose } = await renderOpenPicker();
    const closeBtn = screen.getByRole("button", { name: "Close" });
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the heading labelled by ModalShell when the close row is added", async () => {
    await renderOpenPicker();
    expect(
      screen.getByRole("heading", { name: "Add to Playlist" }),
    ).toBeTruthy();
  });

  it("create flow: click the new-playlist row shows the inline input, Enter calls createPlaylist with the trimmed name then re-fetches", async () => {
    await renderOpenPicker();
    fireEvent.click(screen.getByRole("button", { name: /Create Playlist/i }));

    const input = screen.getByPlaceholderText("My Playlist #1");
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: "  My Mix  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(playlistsMock.createPlaylist).toHaveBeenCalledWith("My Mix");
    });
    await waitFor(() => {
      // Refresh = the second getPlaylists call (first was on open).
      expect(playlistsMock.getPlaylists).toHaveBeenCalledTimes(2);
    });
  });

  it("create flow: invalid (empty or illegal-char) names never call the API", async () => {
    await renderOpenPicker();
    fireEvent.click(screen.getByRole("button", { name: /Create Playlist/i }));
    const input = screen.getByPlaceholderText("My Playlist #1");

    // Empty.
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(playlistsMock.createPlaylist).not.toHaveBeenCalled();

    // Illegal character.
    fireEvent.change(input, { target: { value: "bad:name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(playlistsMock.createPlaylist).not.toHaveBeenCalled();
  });

  it("create flow: Escape cancels back to the list without calling the API", async () => {
    await renderOpenPicker();
    fireEvent.click(screen.getByRole("button", { name: /Create Playlist/i }));
    const input = screen.getByPlaceholderText("My Playlist #1");
    fireEvent.change(input, { target: { value: "Will not be created" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(playlistsMock.createPlaylist).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("My Playlist #1")).toBeNull();
    expect(screen.getByRole("button", { name: "Playlist One" })).toBeTruthy();
  });

  it("kebab opens the INLINE action panel (Rename/Delete) replacing the row â€” not a nested popup", async () => {
    await renderOpenPicker();
    const kebab = screen.getAllByRole("button", {
      name: /playlist options/i,
    })[0];
    if (!kebab) throw new Error("expected kebab button");
    fireEvent.click(kebab);

    // Inline action panel replaces the row.
    expect(screen.getByRole("button", { name: /Rename/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Delete/i })).toBeTruthy();
    // No nested menu/dialog roles introduced (the picker dialog itself is the only one).
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("rename flow: inline input pre-filled, Enter calls updatePlaylist then re-fetches", async () => {
    await renderOpenPicker();
    const kebab = screen.getAllByRole("button", {
      name: /playlist options/i,
    })[0];
    if (!kebab) throw new Error("expected kebab button");
    fireEvent.click(kebab);
    fireEvent.click(screen.getByRole("button", { name: /Rename/i }));

    const input = screen.getByDisplayValue("Playlist One");
    fireEvent.change(input, { target: { value: "Playlist One v2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(playlistsMock.updatePlaylist).toHaveBeenCalledWith("p1", {
        name: "Playlist One v2",
      });
    });
    await waitFor(() => {
      expect(playlistsMock.getPlaylists).toHaveBeenCalledTimes(2);
    });
  });

  it("delete flow: inline confirm replaces the row, confirm calls deletePlaylist then re-fetches", async () => {
    await renderOpenPicker();
    const kebab = screen.getAllByRole("button", {
      name: /playlist options/i,
    })[0];
    if (!kebab) throw new Error("expected kebab button");
    fireEvent.click(kebab);
    fireEvent.click(screen.getByRole("button", { name: /Delete/i }));

    // Inline confirm text + red Confirm button.
    expect(screen.getByText("Delete this playlist?")).toBeTruthy();
    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    expect(confirmBtn.className).toContain("red");
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(playlistsMock.deletePlaylist).toHaveBeenCalledWith("p1");
    });
    await waitFor(() => {
      expect(playlistsMock.getPlaylists).toHaveBeenCalledTimes(2);
    });
  });

  it("cancelling kebab panel, rename and delete never calls the API", async () => {
    await renderOpenPicker();
    const openKebab = (index = 0) => {
      const btn = screen.getAllByRole("button", { name: /playlist options/i })[
        index
      ];
      if (!btn) throw new Error("expected kebab button");
      fireEvent.click(btn);
    };

    openKebab();
    // Close the panel via its dedicated close button.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: /Rename/i })).toBeNull();

    // Rename cancel keeps the playlist intact.
    openKebab();
    fireEvent.click(screen.getByRole("button", { name: /Rename/i }));
    const renameInput = screen.getByDisplayValue("Playlist One");
    fireEvent.keyDown(renameInput, { key: "Escape" });
    expect(playlistsMock.updatePlaylist).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Playlist One" })).toBeTruthy();

    // Delete cancel keeps the playlist intact.
    openKebab();
    fireEvent.click(screen.getByRole("button", { name: /Delete/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(playlistsMock.deletePlaylist).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Playlist One" })).toBeTruthy();
  });
});
