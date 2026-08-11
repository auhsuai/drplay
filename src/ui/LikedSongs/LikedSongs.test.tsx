// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LikedSongs } from "./LikedSongs";
import { DEBUG_EVENTS } from "../debug/debugEvents";
import en from "../../locales/en/translation.json";

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
  const icons = ["Play", "Heart", "Music"];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const mocks = vi.hoisted(() => ({
  getFavorites: vi.fn(),
  removeFavorite: vi.fn(),
  captureError: vi.fn(),
  showErrorToast: vi.fn(),
  prefetchVisibleTracks: vi.fn(),
}));

vi.mock("../../utils/favorites", () => ({
  getFavorites: mocks.getFavorites,
  removeFavorite: mocks.removeFavorite,
  FAVORITES_UPDATED_EVENT: "favorites-updated",
}));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
}));
vi.mock("../../utils/streamPrefetcher", () => ({
  prefetchVisibleTracks: mocks.prefetchVisibleTracks,
}));
vi.mock("../components/MoreMenu", () => ({ MoreMenu: () => null }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        key: i,
        size: 64,
        start: i * 64,
      })),
    getTotalSize: () => count * 64,
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  })),
}));

const TRACK = {
  id: "t1",
  title: "Liked Track 1",
  artist: "Artist 1",
  streamUrl: "https://example.com/t1.mp3",
};

function dispatchLikedEmpty() {
  act(() => {
    window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.LIKED_EMPTY));
  });
}

function renderView() {
  return render(<LikedSongs onPlay={vi.fn()} />);
}

describe("LikedSongs debug empty trigger", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the loaded favorites before the debug trigger", async () => {
    mocks.getFavorites.mockResolvedValue([TRACK]);
    renderView();
    expect(await screen.findByText("Liked Track 1")).not.toBeNull();
    expect(screen.queryByText("No liked songs yet")).toBeNull();
  });

  it("dispatches LIKED_EMPTY -> empty state replaces the loaded list", async () => {
    mocks.getFavorites.mockResolvedValue([TRACK]);
    renderView();
    await screen.findByText("Liked Track 1");

    dispatchLikedEmpty();

    expect(screen.getByText("No liked songs yet")).not.toBeNull();
    expect(
      screen.getByText("Tap the heart on any song to save it."),
    ).not.toBeNull();
    expect(screen.queryByText("Liked Track 1")).toBeNull();
  });

  it("dispatches LIKED_EMPTY while favorites are still loading -> no crash, empty state stays", async () => {
    mocks.getFavorites.mockImplementation(
      () => new Promise<(typeof TRACK)[]>(() => {}),
    );
    renderView();
    await act(async () => {
      await Promise.resolve();
    });
    // favorites starts empty (no skeleton branch exists), so the empty state
    // is already on screen while the real load is pending.
    expect(screen.getByText("No liked songs yet")).not.toBeNull();

    dispatchLikedEmpty();

    expect(screen.getByText("No liked songs yet")).not.toBeNull();
  });

  it("unmount -> dispatching LIKED_EMPTY is a no-op (listener cleaned up)", async () => {
    mocks.getFavorites.mockResolvedValue([TRACK]);
    const { unmount } = renderView();
    await screen.findByText("Liked Track 1");

    unmount();
    expect(() => {
      dispatchLikedEmpty();
    }).not.toThrow();
  });
});
