// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { Suspense, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabContentRouter } from "./TabContentRouter";
import type { TabKey } from "../../utils/driveConstants";
import { TABS } from "../../utils/driveConstants";
import type { ThemeType } from "../../hooks/useTheme";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// captureError writes to Dexie (indexedDB); keep the router test hermetic.
vi.mock("../../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

vi.mock("../MainContent/MainContent", () => ({
  MainContent: () => <div data-testid="mock-main-content" />,
}));

vi.mock("../HomeTab/HomeTab", () => ({
  HomeTab: function MockHomeTab({
    isActive,
  }: {
    isActive: boolean;
  }): ReactElement {
    return (
      <div
        data-testid="mock-home-tab"
        data-active={isActive ? "true" : "false"}
      />
    );
  },
}));

vi.mock("../LikedSongs/LikedSongs", () => ({
  LikedSongs: () => <div data-testid="mock-liked-songs" />,
}));

// mountToken = per-instance sequence assigned by the useState initializer:
// it runs exactly once per mounted instance, so a playlist_A -> playlist_B
// switch must yield token "2" if (and only if) the view really remounted.
let mockPlaylistMounts = 0;

vi.mock("../Playlist/PlaylistView", () => ({
  PlaylistView: function MockPlaylistView({
    playlistId,
  }: {
    playlistId: string;
  }): ReactElement {
    const [mountToken] = useState(() => String(++mockPlaylistMounts));
    return (
      <div
        data-testid="mock-playlist-view"
        data-playlist-id={playlistId}
        data-mount-token={mountToken}
      />
    );
  },
}));

vi.mock("../Settings/SettingsTab", () => ({
  SettingsTab: () => <div data-testid="mock-settings-tab" />,
}));

interface RouterPropsFactoryArgs {
  activeTab: TabKey;
}

function makeRouterProps({ activeTab }: RouterPropsFactoryArgs) {
  return {
    activeTab,
    isLoggedIn: true,
    userProfile: null,
    token: "token",
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
    theme: "dark" as ThemeType,
    setTheme: vi.fn(),
    minimizeToTray: false,
    setMinimizeToTray: vi.fn(),
    backgroundPlayback: false,
    setBackgroundPlayback: vi.fn(),
    setShowFolderSelection: vi.fn(),
    setShowTrashScreen: vi.fn(),
    onLogout: vi.fn(),
  };
}

// The real Suspense lives in AppShell; standalone router renders need one so
// the top-level React.lazy wrappers can resolve their (mocked) payloads.
function withRouter(renderChild: ReactElement) {
  return render(<Suspense fallback={null}>{renderChild}</Suspense>);
}

beforeEach(() => {
  mockPlaylistMounts = 0;
});

afterEach(() => {
  cleanup();
});

describe("TabContentRouter playlist remount contract (F2)", () => {
  it("remounts PlaylistView when switching between two playlists", async () => {
    const { rerender } = withRouter(
      <TabContentRouter {...makeRouterProps({ activeTab: "playlist_A" })} />,
    );
    const initial = await screen.findByTestId("mock-playlist-view");
    expect(initial.dataset.playlistId).toBe("A");
    expect(initial.dataset.mountToken).toBe("1");

    rerender(
      <Suspense fallback={null}>
        <TabContentRouter {...makeRouterProps({ activeTab: "playlist_B" })} />
      </Suspense>,
    );

    const after = screen.getByTestId("mock-playlist-view");
    // Props must follow the new tab…
    expect(after.dataset.playlistId).toBe("B");
    // …AND the instance must be fresh (playlist A's state must not leak).
    // RED on pre-fix code: same position + type without a key lets React
    // reuse the instance, so the token stays "1".
    expect(after.dataset.mountToken).toBe("2");
  });

  it("keeps HomeTab alive across switches (same session key) while flipping isActive", async () => {
    const { rerender } = withRouter(
      <TabContentRouter {...makeRouterProps({ activeTab: TABS.home })} />,
    );
    const homeBefore = await screen.findByTestId("mock-home-tab");
    expect(homeBefore.dataset.active).toBe("true");

    rerender(
      <Suspense fallback={null}>
        <TabContentRouter {...makeRouterProps({ activeTab: "playlist_C" })} />
      </Suspense>,
    );
    const homeHidden = screen.getByTestId("mock-home-tab");
    expect(homeHidden.dataset.active).toBe("false");
    // Same DOM node = keep-alive held; a remount would create a fresh node.
    expect(homeHidden).toBe(homeBefore);

    rerender(
      <Suspense fallback={null}>
        <TabContentRouter {...makeRouterProps({ activeTab: TABS.home })} />
      </Suspense>,
    );
    expect(screen.getByTestId("mock-home-tab").dataset.active).toBe("true");
    expect(mockPlaylistMounts).toBe(1);
  });
});
