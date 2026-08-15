// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const icons = ["Music", "Play", "X", "Trash2", "Camera"];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const mocks = vi.hoisted(() => ({
  getPlaylistById: vi.fn(),
  removeTrackFromPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  updatePlaylist: vi.fn(),
  captureError: vi.fn(),
  showErrorToast: vi.fn(),
  prefetchVisibleTracks: vi.fn(),
}));

vi.mock("../../utils/playlists", () => ({
  getPlaylistById: mocks.getPlaylistById,
  removeTrackFromPlaylist: mocks.removeTrackFromPlaylist,
  deletePlaylist: mocks.deletePlaylist,
  updatePlaylist: mocks.updatePlaylist,
}));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
}));
vi.mock("../../utils/streamPrefetcher", () => ({
  prefetchVisibleTracks: mocks.prefetchVisibleTracks,
}));
// Task 12: mobile rows must not render the artist line / icon box — hoisted
// mock toggles the platform flag; the getter keeps the binding live.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
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
};

const FULL_PLAYLIST: Playlist = {
  id: "pl-1",
  userEmail: "u@example.com",
  name: "My Mix",
  createdAt: 1000,
  tracks: [TRACK],
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

describe("PlaylistView mobile gate (IS_MOBILE) — title + size only", () => {
  afterEach(() => {
    platformMock.IS_MOBILE = false;
    cleanup();
    vi.clearAllMocks();
  });

  it("hides the artist line; shows the drive size and the music icon box (Task 6 restores the box on mobile)", async () => {
    platformMock.IS_MOBILE = true;
    mocks.getPlaylistById.mockResolvedValue({
      ...FULL_PLAYLIST,
      tracks: [{ ...TRACK, size: 12345 }],
    });
    const { container } = renderView();
    await screen.findByText("Track 1");
    expect(screen.queryByText("Unknown Artist")).toBeNull();
    expect(screen.getByText("12.1 KB")).not.toBeNull();
    expect(container.querySelector('[class*="w-10 h-10"]')).not.toBeNull();
  });

  it("omits the size line when the stored track carries no size", async () => {
    platformMock.IS_MOBILE = true;
    mocks.getPlaylistById.mockResolvedValue(FULL_PLAYLIST);
    renderView();
    await screen.findByText("Track 1");
    expect(screen.queryByText("Unknown Artist")).toBeNull();
    expect(screen.queryByText(/KB|MB|GB|B$/)).toBeNull();
  });
});
