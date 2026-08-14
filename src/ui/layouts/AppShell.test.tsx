// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TABS, type TabKey } from "../../utils/driveConstants";

// react-i18next resolves keys to the raw key string; assertions below use the
// same key names so the test reads the shipped i18n contract, not a copy.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("../Sidebar/Sidebar", () => ({
  Sidebar: () => <div data-testid="mock-sidebar" />,
}));

vi.mock("../PlayerBar/PlayerBar", () => ({
  PlayerBar: () => <div data-testid="mock-playerbar" />,
}));

const MOBILE_PADDING = "pb-[calc(env(safe-area-inset-bottom)+4rem)]";

interface RenderOptions {
  isMobile: boolean;
  activeTab?: TabKey;
}

// IS_MOBILE is a module-level constant evaluated at import time, so each
// scenario re-imports the module under test with a freshly mocked platform.
async function renderAppShell({
  isMobile,
  activeTab = TABS.home,
}: RenderOptions) {
  vi.resetModules();
  vi.doMock("../../utils/platform", () => ({ IS_MOBILE: isMobile }));
  const { AppShell } = await import("./AppShell");
  const onTabChange = vi.fn();
  const utils = render(
    <AppShell
      isLoggedIn
      appRootFolder="root"
      showFolderSelection={false}
      activeTab={activeTab}
      onTabChange={onTabChange}
      userProfile={null}
      onLogout={vi.fn()}
      isSidebarOpen
      onToggleSidebar={vi.fn()}
      token="token"
      isNowPlayingOpen={false}
      currentTrack={null}
      loadNonce={0}
      isPlaying={false}
      onTogglePlay={vi.fn()}
      onNextTrack={vi.fn()}
      onPrevTrack={vi.fn()}
      isDownloading={false}
      playMode={"normal" as const}
      onTogglePlayMode={vi.fn()}
      onExpandNowPlaying={vi.fn()}
      tabContent={<div data-testid="tab-content" />}
    />,
  );
  return { ...utils, onTabChange };
}

afterEach(() => {
  cleanup();
});

describe("AppShell desktop (IS_MOBILE=false)", () => {
  it("keeps the Sidebar visible and renders no BottomNav", async () => {
    const { container } = await renderAppShell({ isMobile: false });
    const sidebar = screen.getByTestId("mock-sidebar");
    expect(sidebar.parentElement).not.toHaveClass("hidden");
    expect(
      screen.queryByRole("button", { name: "sidebar.home" }),
    ).not.toBeInTheDocument();
    const contentArea = container.querySelector("#content-area");
    expect(contentArea?.className).not.toContain("env(safe-area-inset-bottom)");
  });
});

describe("AppShell mobile (IS_MOBILE=true)", () => {
  it("hides the Sidebar wrapper, renders BottomNav and pads content above it", async () => {
    const { container } = await renderAppShell({ isMobile: true });
    const sidebar = screen.getByTestId("mock-sidebar");
    expect(sidebar.parentElement).toHaveClass("hidden");
    expect(
      screen.getByRole("button", { name: "sidebar.home" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("mock-playerbar")).toBeInTheDocument();
    const contentArea = container.querySelector("#content-area");
    expect(contentArea?.className).toContain(MOBILE_PADDING);
  });

  it("passes the active tab to the BottomNav", async () => {
    await renderAppShell({ isMobile: true, activeTab: TABS.likedSongs });
    expect(
      screen.getByRole("button", { name: "sidebar.liked_songs" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("reuses the AppShell tab-change handler (click goes through the same callback)", async () => {
    const { onTabChange } = await renderAppShell({ isMobile: true });
    fireEvent.click(screen.getByRole("button", { name: "sidebar.my_drive" }));
    expect(onTabChange).toHaveBeenCalledWith(TABS.myDrive);
  });
});
