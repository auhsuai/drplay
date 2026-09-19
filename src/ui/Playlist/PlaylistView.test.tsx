// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaylistView } from "./PlaylistView";
import { DEBUG_EVENTS } from "../debug/debugEvents";
import en from "../../locales/en/translation.json";
import type { Playlist } from "../../utils/playlists";

// Resolve keys against the real en resources so assertions read the shipped
// copy instead of hard-coded fallbacks (HomeTab.test convention). The second
// arg (i18next options, e.g. {count}) is deliberately ignored — it must never
// leak into the render tree as a fallback value.
vi.mock("react-i18next", () => {
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
      t: (key: string) => resolveKey(key) ?? key,
    }),
  };
});

vi.mock("lucide-react", () => {
  const icons = [
    // PlaylistView row/header icons
    "Music",
    "Play",
    "X",
    "Trash2",
    "Camera",
    // Shared MoreMenu chrome + PlaylistMenuItems
    "Ellipsis",
    "LoaderCircle",
    "SquareCheckBig",
    "MapPin",
    "ListX",
    // Queue selection building blocks
    "Check",
    "Square",
  ];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const mocks = vi.hoisted(() => ({
  getPlaylistById: vi.fn(),
  removeTrackFromPlaylist: vi.fn(),
  removeTracksFromPlaylist: vi.fn(),
  getPlaylists: vi.fn(),
  addTrackToPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  updatePlaylist: vi.fn(),
  captureError: vi.fn(),
  showErrorToast: vi.fn(),
  prefetchVisibleTracks: vi.fn(),
}));

vi.mock("../../utils/playlists", () => ({
  getPlaylistById: mocks.getPlaylistById,
  removeTrackFromPlaylist: mocks.removeTrackFromPlaylist,
  removeTracksFromPlaylist: mocks.removeTracksFromPlaylist,
  getPlaylists: mocks.getPlaylists,
  addTrackToPlaylist: mocks.addTrackToPlaylist,
  deletePlaylist: mocks.deletePlaylist,
  updatePlaylist: mocks.updatePlaylist,
}));
// Real MoreMenu (playlist variant) pulls the move/delete/download hooks; stub
// their Drive/Dexie edges the same way MoreMenu.test does.
vi.mock("../../utils/driveApi", () => ({
  deleteFile: vi.fn(),
  moveFile: vi.fn(),
}));
vi.mock("../../db/db", () => ({
  db: { files: { delete: vi.fn(), update: vi.fn() } },
}));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
}));
vi.mock("../../utils/streamPrefetcher", () => ({
  prefetchVisibleTracks: mocks.prefetchVisibleTracks,
}));
vi.mock("../components/ImageCropperModal", () => ({
  ImageCropperModal: () => null,
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        key: i,
        size: 56,
        start: i * 56,
      })),
    getTotalSize: () => count * 56,
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  })),
}));

const TRACK = {
  id: "t1",
  title: "Track 1",
  artist: "Artist 1",
  streamUrl: "https://example.com/t1.mp3",
  parentId: "parent-1",
  parentName: "Folder One",
};

const TRACK_2 = {
  id: "t2",
  title: "Track 2",
  artist: "Artist 2",
  streamUrl: "https://example.com/t2.mp3",
  parentId: "parent-2",
  parentName: "Folder Two",
};

const FULL_PLAYLIST: Playlist = {
  id: "pl-1",
  userEmail: "u@example.com",
  name: "My Mix",
  createdAt: 1000,
  tracks: [TRACK],
};

const TWO_TRACK_PLAYLIST: Playlist = {
  ...FULL_PLAYLIST,
  tracks: [TRACK, TRACK_2],
};

function dispatchPlaylistEmpty() {
  act(() => {
    window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.PLAYLIST_EMPTY));
  });
}

function renderView(playlistId = "pl-1") {
  return render(
    <PlaylistView
      playlistId={playlistId}
      onPlay={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe("PlaylistView debug empty trigger", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the loaded track list before the debug trigger", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    renderView();
    expect(await screen.findByText("Track 1")).not.toBeNull();
    expect(screen.queryByText("No tracks yet")).toBeNull();
  });

  it("dispatches PLAYLIST_EMPTY -> empty state replaces the loaded track list", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    renderView();
    await screen.findByText("Track 1");

    dispatchPlaylistEmpty();

    expect(screen.getByText("No tracks yet")).not.toBeNull();
    expect(screen.getByText("Add songs to your playlist.")).not.toBeNull();
    expect(screen.queryByText("Track 1")).toBeNull();
  });

  it("dispatches PLAYLIST_EMPTY while the playlist is still null (load pending/failed) -> fake empty playlist renders, no crash", async () => {
    mocks.getPlaylistById.mockResolvedValue(null);
    renderView("pl-pending");
    // Wait for the load to settle: with null the view renders nothing.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("No tracks yet")).toBeNull();

    dispatchPlaylistEmpty();

    expect(screen.getByText("No tracks yet")).not.toBeNull();
    expect(screen.getByText("pl-pending")).not.toBeNull();
  });

  it("unmount -> dispatching PLAYLIST_EMPTY is a no-op (listener cleaned up)", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    const { unmount } = renderView();
    await screen.findByText("Track 1");

    unmount();
    expect(() => {
      dispatchPlaylistEmpty();
    }).not.toThrow();
  });
});

describe("PlaylistView header + row semantics (P2-13a-3/-4/-9)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("row hiển thị artist thật của track thay vì unknown_artist hardcode (P2-13a-3)", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    renderView();

    expect(await screen.findByText("Artist 1")).not.toBeNull();
    expect(screen.queryByText("Unknown Artist")).toBeNull();
  });

  it("artist rỗng → fallback unknown_artist (P2-13a-3)", async () => {
    mocks.getPlaylistById.mockResolvedValue({
      ...FULL_PLAYLIST,
      tracks: [{ ...TRACK, artist: "" }],
    });
    renderView();

    expect(await screen.findByText("Unknown Artist")).not.toBeNull();
  });

  it("nút Play header truyền cả playlist làm context queue (P2-13a-4)", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    const onPlay = vi.fn();
    render(
      <PlaylistView playlistId="pl-1" onPlay={onPlay} onDelete={vi.fn()} />,
    );
    await screen.findByText("Track 1");

    // The header play button is the only <button> carrying bg-brand-primary
    // (the cover is a div[role=button], the row remove button is opacity-0).
    const playButton = document.querySelector("button.bg-brand-primary");
    expect(playButton).not.toBeNull();
    fireEvent.click(playButton as HTMLButtonElement);

    expect(onPlay).toHaveBeenCalledWith(TRACK, [TRACK]);
  });

  it("playlist null sau khi load settle → hiện thông điệp load_error thay vì trắng (P2-13a-9)", async () => {
    mocks.getPlaylistById.mockResolvedValue(null);
    renderView("pl-missing");

    expect(
      await screen.findByText("Couldn't load playlist. Try again."),
    ).not.toBeNull();
  });

  it("đang load (chưa settle) → KHÔNG hiện thông điệp (không flash) (P2-13a-9)", () => {
    mocks.getPlaylistById.mockImplementation(() => new Promise(() => {}));
    renderView("pl-pending");

    expect(screen.queryByText("Couldn't load playlist. Try again.")).toBeNull();
  });
});

describe("PlaylistView playlist row menu + selection mode", () => {
  beforeEach(() => {
    // The real MoreMenu's playlists hook loads on open; feed it an empty list.
    mocks.getPlaylists.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function renderWithPlay() {
    const onPlay = vi.fn();
    render(
      <PlaylistView playlistId="pl-1" onPlay={onPlay} onDelete={vi.fn()} />,
    );
    return { onPlay };
  }

  async function openRowMenu(title: string): Promise<HTMLElement> {
    await screen.findByText(title);
    fireEvent.contextMenu(screen.getByText(title), {
      clientX: 12,
      clientY: 34,
    });
    return screen.getByRole("menu");
  }

  function rowButton(title: string): HTMLElement {
    const row = screen.getByText(title).closest("div[role='button']");
    if (row === null) throw new Error(`expected row button for ${title}`);
    return row as HTMLElement;
  }

  it("right-click opens the playlist menu (3 items) and does not dispatch locate-file", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    const locateSpy = vi.fn();
    window.addEventListener("locate-file", locateSpy);
    renderView();

    const menu = await openRowMenu("Track 1");

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((b) => b.textContent?.trim()),
    ).toEqual(["Select multiple items", "Locate File", "Remove from Playlist"]);
    expect(
      within(menu).queryByRole("menuitem", { name: "Add to Playlist" }),
    ).toBeNull();
    expect(locateSpy).not.toHaveBeenCalled();
    window.removeEventListener("locate-file", locateSpy);
  });

  it("Locate File dispatches locate-file with the row track detail and closes the menu", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    const locateSpy = vi.fn();
    window.addEventListener("locate-file", locateSpy);
    renderView();
    const menu = await openRowMenu("Track 1");

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Locate File" }),
    );

    expect(locateSpy).toHaveBeenCalledTimes(1);
    const firstCall = locateSpy.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected locate-file event");
    const detail = (
      firstCall[0] as CustomEvent<{
        fileId: string;
        parentId: string;
        parentName: string;
      }>
    ).detail;
    expect(detail).toEqual({
      fileId: "t1",
      parentId: "parent-1",
      parentName: "Folder One",
    });
    expect(screen.queryByRole("menu")).toBeNull();
    window.removeEventListener("locate-file", locateSpy);
  });

  it("Remove from Playlist removes only from the playlist (no delete/update call)", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    renderView();
    const menu = await openRowMenu("Track 1");

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Remove from Playlist" }),
    );

    await waitFor(() => {
      expect(mocks.removeTrackFromPlaylist).toHaveBeenCalledWith("pl-1", "t1");
    });
    expect(mocks.removeTracksFromPlaylist).not.toHaveBeenCalled();
    expect(mocks.deletePlaylist).not.toHaveBeenCalled();
    expect(mocks.updatePlaylist).not.toHaveBeenCalled();
  });

  it("right-clicking another row moves the menu to that row", async () => {
    mocks.getPlaylistById.mockResolvedValue(TWO_TRACK_PLAYLIST);
    renderView();
    await openRowMenu("Track 1");

    fireEvent.contextMenu(screen.getByText("Track 2"), {
      clientX: 30,
      clientY: 40,
    });
    expect(screen.getAllByRole("menu")).toHaveLength(1);

    fireEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", {
        name: "Remove from Playlist",
      }),
    );

    await waitFor(() => {
      expect(mocks.removeTrackFromPlaylist).toHaveBeenCalledWith("pl-1", "t2");
    });
  });

  it("Select multiple items enters selection mode with the row checked; row click toggles without playing", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    const { onPlay } = renderWithPlay();
    const menu = await openRowMenu("Track 1");

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Select multiple items" }),
    );

    const checkbox = screen.getByRole("checkbox", { name: "Track 1" });
    expect(checkbox).toBeChecked();
    expect(screen.getByTestId("queue-selection-toolbar")).not.toBeNull();
    // The header play-all button is replaced by the selection toolbar.
    expect(document.querySelector("button.w-14.h-14")).toBeNull();
    // Per-row single actions are hidden while selecting.
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();

    fireEvent.click(screen.getByText("Track 1"));

    expect(onPlay).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Track 1" })).not.toBeChecked();
  });

  it("right-click while selection mode is active does not open the menu", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    renderView();
    const menu = await openRowMenu("Track 1");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Select multiple items" }),
    );

    fireEvent.contextMenu(screen.getByText("Track 1"), {
      clientX: 5,
      clientY: 6,
    });

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Enter/Space on the row plays in normal mode and toggles selection in selection mode", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    const { onPlay } = renderWithPlay();
    await screen.findByText("Track 1");

    fireEvent.keyDown(rowButton("Track 1"), { key: "Enter" });
    expect(onPlay).toHaveBeenCalledWith(TRACK, [TRACK]);

    const menu = await openRowMenu("Track 1");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Select multiple items" }),
    );
    onPlay.mockClear();

    fireEvent.keyDown(rowButton("Track 1"), { key: "Enter" });
    expect(onPlay).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Track 1" })).not.toBeChecked();

    fireEvent.keyDown(rowButton("Track 1"), { key: " " });
    expect(onPlay).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Track 1" })).toBeChecked();
  });

  it("bulk Remove selected deletes every selected id once and exits selection when all rows go", async () => {
    mocks.getPlaylistById.mockResolvedValue(TWO_TRACK_PLAYLIST);
    renderView();
    const menu = await openRowMenu("Track 2");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Select multiple items" }),
    );
    fireEvent.click(screen.getByText("Track 1"));

    fireEvent.click(screen.getByTestId("queue-remove-selected"));

    await waitFor(() => {
      expect(mocks.removeTracksFromPlaylist).toHaveBeenCalledTimes(1);
    });
    expect(mocks.removeTracksFromPlaylist).toHaveBeenCalledWith("pl-1", [
      "t2",
      "t1",
    ]);
    await waitFor(() => {
      expect(screen.queryByTestId("queue-selection-toolbar")).toBeNull();
    });
    // The play-all button returns once selection mode exits.
    expect(document.querySelector("button.w-14.h-14")).not.toBeNull();
  });

  it("bulk Remove selected keeps selection mode with an empty selection when rows remain", async () => {
    mocks.getPlaylistById.mockResolvedValue(TWO_TRACK_PLAYLIST);
    renderView();
    const menu = await openRowMenu("Track 1");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Select multiple items" }),
    );

    fireEvent.click(screen.getByTestId("queue-remove-selected"));

    await waitFor(() => {
      expect(mocks.removeTracksFromPlaylist).toHaveBeenCalledWith("pl-1", [
        "t1",
      ]);
    });
    expect(screen.getByTestId("queue-selection-toolbar")).not.toBeNull();
    expect(screen.getByRole("checkbox", { name: "Track 1" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Track 2" })).not.toBeChecked();
  });

  it("select all toggles every row and unselect all clears them", async () => {
    mocks.getPlaylistById.mockResolvedValue(TWO_TRACK_PLAYLIST);
    renderView();
    const menu = await openRowMenu("Track 1");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Select multiple items" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    expect(screen.getByRole("checkbox", { name: "Track 1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Track 2" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Unselect all" }));

    expect(screen.getByRole("checkbox", { name: "Track 1" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Track 2" })).not.toBeChecked();
  });

  it("Exit selection leaves the mode, clears the selection and restores the play-all button", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    renderView();
    const menu = await openRowMenu("Track 1");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Select multiple items" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Exit selection" }));

    expect(screen.queryByTestId("queue-selection-toolbar")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Track 1" })).toBeNull();
    expect(document.querySelector("button.w-14.h-14")).not.toBeNull();
    expect(screen.getByRole("button", { name: "More actions" })).not.toBeNull();
  });

  it("normal mode no longer renders the hover remove (X) button; removal is menu-only", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    renderView();
    await screen.findByText("Track 1");

    expect(screen.queryByTitle("Remove from Playlist")).toBeNull();
    expect(mocks.removeTrackFromPlaylist).not.toHaveBeenCalled();
  });
});

// P2-13a-7: the row ⋯ control is hidden until hover; keyboard focus must
// reveal it (focus-within:), otherwise focus is invisible.
describe("PlaylistView hover-reveal row menu control (P2-13a-7)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("reveals the ⋯ row control when it receives focus", async () => {
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    renderView();
    await screen.findByText("Track 1");

    const trigger = screen.getByRole("button", { name: "More actions" });
    const reveal = trigger.closest('[class*="focus-within:opacity-100"]');
    expect(reveal).not.toBeNull();
    expect(reveal?.className).toContain("opacity-0");
  });
});
