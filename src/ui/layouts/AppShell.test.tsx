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
  it("QueuePanel là anh em cùng cấp của tab content trong row (không nằm trong PlayerBar; list co lại nhường chỗ)", () => {
    render(<AppShell {...baseProps()} />);

    const pane = screen.getByTestId("queue-panel-stub");
    const row = pane.parentElement;
    expect(row).not.toBeNull();
    const rowEl = row as HTMLElement;

    expect(rowEl.className).toContain("relative");
    expect(rowEl.className).toContain("overflow-hidden");
    expect(rowEl.contains(screen.getByTestId("tab-content-probe"))).toBe(true);
    expect(rowEl.contains(screen.getByTestId("player-bar-stub"))).toBe(false);

    // The list column is the one that gives up width: flex-1 + min-w-0, so a
    // docked pane (shrink-0 + width transition) narrows it in flow.
    const column = pane.previousElementSibling as HTMLElement;
    expect(column.className).toContain("flex-1");
    expect(column.className).toContain("min-w-0");
    expect(column.contains(screen.getByTestId("tab-content-probe"))).toBe(true);

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

describe("AppShell PlayerBar a11y khi NowPlaying mở (P2-13a-1)", () => {
  function playerWrapper(): HTMLElement {
    return screen.getByTestId("player-bar-stub").parentElement as HTMLElement;
  }

  it("isNowPlayingOpen=true → wrapper aria-hidden + inert (vẫn mount cho transition)", () => {
    render(<AppShell {...baseProps()} isNowPlayingOpen />);

    const wrapper = playerWrapper();
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper.hasAttribute("inert")).toBe(true);
    // Still mounted: the 700ms collapse animation needs the node present.
    expect(screen.getByTestId("player-bar-stub")).toBeTruthy();
  });

  it("isNowPlayingOpen=false → wrapper tương tác bình thường, không inert", () => {
    render(<AppShell {...baseProps()} />);

    const wrapper = playerWrapper();
    expect(wrapper.getAttribute("aria-hidden")).toBe("false");
    expect(wrapper.hasAttribute("inert")).toBe(false);
  });
});

describe("AppShell shell inert khi modal phủ (P2-13a-2)", () => {
  function shellRoot(): HTMLElement {
    return screen.getByTestId("sidebar-stub").parentElement as HTMLElement;
  }

  it("chưa login (LoginScreen phủ toàn màn hình) → shell aria-hidden + inert", () => {
    render(<AppShell {...baseProps()} isLoggedIn={false} />);

    const shell = shellRoot();
    expect(shell.getAttribute("aria-hidden")).toBe("true");
    expect(shell.hasAttribute("inert")).toBe(true);
  });

  it("chưa có appRootFolder (FolderSelectionGate phủ) → shell aria-hidden + inert", () => {
    render(<AppShell {...baseProps()} appRootFolder={null} />);

    const shell = shellRoot();
    expect(shell.getAttribute("aria-hidden")).toBe("true");
    expect(shell.hasAttribute("inert")).toBe(true);
  });

  it("đang mở folder picker (showFolderSelection=true, đã có root folder) → shell aria-hidden + inert", () => {
    render(<AppShell {...baseProps()} showFolderSelection />);

    const shell = shellRoot();
    expect(shell.getAttribute("aria-hidden")).toBe("true");
    expect(shell.hasAttribute("inert")).toBe(true);
  });

  it("logged-in + có root folder + không mở picker → shell tương tác bình thường", () => {
    render(<AppShell {...baseProps()} />);

    const shell = shellRoot();
    expect(shell.getAttribute("aria-hidden")).toBe("false");
    expect(shell.hasAttribute("inert")).toBe(false);
  });
});
