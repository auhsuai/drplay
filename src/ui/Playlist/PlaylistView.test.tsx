// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
