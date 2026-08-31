// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  cleanup();
});

describe("TabContentRouter tab routing", () => {
  it("keeps HomeTab alive across switches (same session key) while flipping isActive", async () => {
    const { rerender } = withRouter(
      <TabContentRouter {...makeRouterProps({ activeTab: TABS.home })} />,
    );
    const homeBefore = await screen.findByTestId("mock-home-tab");
    expect(homeBefore.dataset.active).toBe("true");

    // act + microtask flush: the lazy target (MainContent) must resolve
    // before asserting, otherwise the stale committed tree is still shown.
    await act(async () => {
      rerender(
        <Suspense fallback={null}>
          <TabContentRouter {...makeRouterProps({ activeTab: TABS.myDrive })} />
        </Suspense>,
      );
      await Promise.resolve();
    });
    const homeHidden = await screen.findByTestId("mock-home-tab");
    expect(homeHidden.dataset.active).toBe("false");
    // Same DOM node = keep-alive held; a remount would create a fresh node.
    expect(homeHidden).toBe(homeBefore);

    await act(async () => {
      rerender(
        <Suspense fallback={null}>
          <TabContentRouter {...makeRouterProps({ activeTab: TABS.home })} />
        </Suspense>,
      );
      await Promise.resolve();
    });
    expect(screen.getByTestId("mock-home-tab").dataset.active).toBe("true");
  });

  it("renders SettingsTab for the settings tab", () => {
    withRouter(
      <TabContentRouter {...makeRouterProps({ activeTab: TABS.settings })} />,
    );
    return screen.findByTestId("mock-settings-tab").then(() => {});
  });

  // Guard test (test sau khi xóa): LikedSongs + PlaylistView have been removed
  // from the router. A stale playlist_ id (e.g. from a persisted session) or
  // the literal "Liked Songs" string must fall through to the safe
  // coming-soon fallback, never render a deleted view.
  it.each(["playlist_123" as TabKey, "Liked Songs" as TabKey])(
    "activeTab %s falls through to the safe fallback (no LikedSongs/PlaylistView)",
    (tab) => {
      withRouter(<TabContentRouter {...makeRouterProps({ activeTab: tab })} />);
      expect(screen.queryByTestId("mock-playlist-view")).toBeNull();
      expect(screen.queryByTestId("mock-liked-songs")).toBeNull();
      return screen.findByText(/^common\.coming_soon:/).then(() => {});
    },
  );
});
