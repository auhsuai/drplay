// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabKey, Track } from "../../types";
import { TABS } from "../../utils/driveConstants";
import { AppShell } from "./AppShell";

// The shell test only owns the drawer POSITION and the prop wiring down to
// PlayerBar/QueuePanel. The real PlayerBar drags AudioController, and the real
// QueuePanel drags the virtualizer/MoreMenu/store — both out of scope here.
const mocks = vi.hoisted(() => ({
  playerProps: { value: null as Record<string, unknown> | null },
  queueProps: { value: null as Record<string, unknown> | null },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("../Sidebar/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar-stub" />,
}));

vi.mock("../PlayerBar/PlayerBar", () => ({
  PlayerBar: (props: Record<string, unknown>) => {
    mocks.playerProps.value = props;
    return <div data-testid="player-bar-stub" />;
  },
}));

vi.mock("../PlayerBar/QueuePanel", () => ({
  QueuePanel: (props: Record<string, unknown>) => {
    mocks.queueProps.value = props;
    return <div data-testid="queue-panel-stub" />;
  },
}));

function baseProps() {
  return {
    isLoggedIn: true,
    appRootFolder: "root",
    showFolderSelection: false,
    activeTab: TABS.home as TabKey,
    onTabChange: vi.fn(),
    userProfile: null,
    onLogout: vi.fn(),
    isSidebarOpen: true,
    onToggleSidebar: vi.fn(),
    token: "tok",
    isNowPlayingOpen: false,
    currentTrack: null as Track | null,
    loadNonce: 0,
    isPlaying: false,
    onTogglePlay: vi.fn(),
    onNextTrack: vi.fn(),
    onPrevTrack: vi.fn(),
    isDownloading: false,
    playMode: "normal" as const,
    onTogglePlayMode: vi.fn(),
    onSetPlayMode: vi.fn(),
    onSelectTrack: vi.fn(),
    onExpandNowPlaying: vi.fn(),
    isQueueOpen: true,
    onToggleQueue: vi.fn(),
    onCloseQueue: vi.fn(),
    tabContent: <div data-testid="tab-content-probe" />,
  };
}

beforeEach(() => {
  mocks.playerProps.value = null;
  mocks.queueProps.value = null;
});

afterEach(() => {
  cleanup();
});

describe("AppShell queue drawer", () => {
  it("QueuePanel là anh em của tab content trong row (không nằm trong PlayerBar, không co list)", () => {
    render(<AppShell {...baseProps()} />);

    const pane = screen.getByTestId("queue-panel-stub");
    const row = pane.parentElement;
    expect(row).not.toBeNull();
    const rowEl = row as HTMLElement;

    expect(rowEl.className).toContain("relative");
    expect(rowEl.className).toContain("overflow-hidden");
    expect(rowEl.contains(screen.getByTestId("tab-content-probe"))).toBe(true);
    expect(rowEl.contains(screen.getByTestId("player-bar-stub"))).toBe(false);

    const playerWrapper = screen.getByTestId("player-bar-stub")
      .parentElement as HTMLElement;
    expect(playerWrapper.contains(pane)).toBe(false);
  });

  it("truyền đúng props xuống QueuePanel và PlayerBar", () => {
    const props = baseProps();
    render(<AppShell {...props} />);

    expect(mocks.queueProps.value).toMatchObject({
      open: true,
      activeTab: TABS.home,
    });
    expect(mocks.queueProps.value?.onClose).toBe(props.onCloseQueue);
    expect(mocks.queueProps.value?.onSetPlayMode).toBe(props.onSetPlayMode);
    expect(mocks.queueProps.value?.onSelectTrack).toBe(props.onSelectTrack);
    expect(mocks.playerProps.value?.isQueueOpen).toBe(true);
    expect(mocks.playerProps.value?.onToggleQueue).toBe(props.onToggleQueue);
  });

  it("isQueueOpen=false vẫn mount pane (giữ chỗ cho exit animation) và cập nhật props", () => {
    const props = baseProps();
    const { rerender } = render(<AppShell {...props} />);
    rerender(<AppShell {...props} isQueueOpen={false} />);

    expect(screen.getByTestId("queue-panel-stub")).toBeTruthy();
    expect(mocks.queueProps.value?.open).toBe(false);
    expect(mocks.playerProps.value?.isQueueOpen).toBe(false);
  });
});
