// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabKey } from "../../types";
import { TabContentRouter } from "./TabContentRouter";

// The router renders only the active tab branch; the other four lazy chunks
// render null so the test tree stays tiny. PlaylistView counts MOUNTS (effect
// with [] runs once per mount) — a prop change on a kept-alive instance must
// not inflate it.
const playlistMocks = vi.hoisted(() => ({ mounts: [] as string[] }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("../HomeTab/HomeTab", () => ({ HomeTab: () => null }));
vi.mock("../MainContent/MainContent", () => ({ MainContent: () => null }));
vi.mock("../LikedSongs/LikedSongs", () => ({ LikedSongs: () => null }));
vi.mock("../Settings/SettingsTab", () => ({ SettingsTab: () => null }));

vi.mock("../Playlist/PlaylistView", async () => {
  const { useEffect } = await import("react");
  return {
    PlaylistView: ({ playlistId }: { playlistId: string }) => {
      useEffect(() => {
        playlistMocks.mounts.push(playlistId);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount counter: must run exactly once per mount, playlistId changes must NOT recount
      }, []);
      return <div data-testid="playlist-view" data-playlist-id={playlistId} />;
    },
  };
});

function routerProps(
  activeTab: TabKey,
): ComponentProps<typeof TabContentRouter> {
  return {
    activeTab,
    isLoggedIn: true,
    userProfile: null,
    token: "tok",
    currentTrack: null,
    onPlayTrack: vi.fn(),
    onOpenFolder: vi.fn(),
    onSwitchTab: vi.fn(),
    isLoading: false,
    onBack: vi.fn(),
    hasHistory: false,
    folderHistory: [],
    currentFolderName: "",
    currentFolderId: "",
    onBreadcrumbClick: vi.fn(),
    highlightedFileId: null,
    sortOption: "name",
    setSortOption: vi.fn(),
    theme: "dark",
    setTheme: vi.fn(),
    minimizeToTray: true,
    setMinimizeToTray: vi.fn(),
    setShowFolderSelection: vi.fn(),
    setShowTrashScreen: vi.fn(),
    isNowPlayingOpen: false,
  };
}

describe("TabContentRouter playlist remount (P2-13a-6)", () => {
  afterEach(() => {
    cleanup();
    playlistMocks.mounts.length = 0;
  });

  it("đổi playlist_A → playlist_B remount PlaylistView (key=activeTab), không tái dùng instance cũ", async () => {
    const props = routerProps("playlist_A");
    const { rerender } = render(<TabContentRouter {...props} />);

    await screen.findByTestId("playlist-view");
    expect(
      screen.getByTestId("playlist-view").getAttribute("data-playlist-id"),
    ).toBe("A");
    expect(playlistMocks.mounts).toEqual(["A"]);

    rerender(<TabContentRouter {...props} activeTab="playlist_B" />);

    await waitFor(() => {
      expect(
        screen.getByTestId("playlist-view").getAttribute("data-playlist-id"),
      ).toBe("B");
    });
    expect(playlistMocks.mounts).toEqual(["A", "B"]);
  });
});
