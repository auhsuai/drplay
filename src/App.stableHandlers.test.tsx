// @vitest-environment jsdom
//
// F1 regression: App's stable transport wrappers must be TRUE ref-delegates.
// The PlayerBar memo comparator intentionally ignores handler props (it
// compares only currentTrack.id/isPlaying/playMode/isDownloading/loadNonce),
// so when the transport handlers change identity while those five values stay
// put, a plain useCallback wrapper changes identity WITHOUT ever reaching the
// memoized child — the bar keeps firing a closure over the OLD queue (plays
// deleted tracks / skips newly added ones). Mirror of the proven internal
// pattern in usePlayer.ts (handlePlayTrackRef + stableHandlePlayTrack).
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

// Shared state for App-level mocks: hoisted so vi.mock factories (hoisted
// above imports) can reach it.
const mocks = vi.hoisted(() => ({
  authState: { isLoggedIn: true },
  // Mutable handler holder so a test can swap identities between renders.
  playerHandlers: {
    value: {
      handleTogglePlay: vi.fn(),
      handleNextTrack: vi.fn(),
      handlePrevTrack: vi.fn(),
      handleTogglePlayMode: vi.fn(),
    },
  },
  // Counts PlayerBar stub renders so tests can wait for the post-mutation
  // re-render regardless of whether prop identities changed.
  playerBarRenders: { value: 0 },
  playerBarProps: {
    value: null as null | {
      onNextTrack?: (...args: unknown[]) => unknown;
      onPrevTrack?: (...args: unknown[]) => unknown;
      onTogglePlay?: (...args: unknown[]) => unknown;
      onTogglePlayMode?: (...args: unknown[]) => unknown;
      onExpandNowPlaying?: () => void;
    },
  },
  // Sidebar stub captures the live onTabChange prop so tests can switch tabs
  // exactly like a real click (forcing an App re-render).
  sidebarProps: {
    value: null as null | { onTabChange: (tab: unknown) => void },
  },
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

// --- App shell harness (same proven stub set as App.test.tsx) --------------
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));
vi.mock("./hooks/useAuth", () => ({
  useAuth: () => ({
    isLoggedIn: mocks.authState.isLoggedIn,
    accessToken: mocks.authState.isLoggedIn ? "tok" : null,
    userProfile: { name: "Test User", email: "t@example.com", picture: "" },
    handleLoginSuccess: vi.fn(),
    handleLogout: vi.fn(),
  }),
}));
vi.mock("./hooks/useDrive", () => ({
  useDrive: () => ({
    appRootFolder: "root",
    setAppRootFolder: vi.fn(),
    currentFolderId: "root",
    setCurrentFolderId: vi.fn(),
    currentFolderName: "My Drive",
    setCurrentFolderName: vi.fn(),
    folderHistory: [],
    setFolderHistory: vi.fn(),
    sortOption: "name",
    setSortOption: vi.fn(),
    handleOpenFolder: vi.fn(),
    handleBack: vi.fn(),
    handleBreadcrumbClick: vi.fn(),
    handleSelectRootFolder: vi.fn(),
  }),
}));
vi.mock("./hooks/usePlayer", () => ({
  usePlayer: () => ({
    currentTrack: null,
    isPlaying: false,
    isDownloading: false,
    playMode: "normal",
    handlePlayTrack: vi.fn(),
    handleNextTrack: mocks.playerHandlers.value.handleNextTrack,
    handlePrevTrack: mocks.playerHandlers.value.handlePrevTrack,
    handleTogglePlay: mocks.playerHandlers.value.handleTogglePlay,
    handleTogglePlayMode: mocks.playerHandlers.value.handleTogglePlayMode,
    loadNonce: 0,
  }),
}));
vi.mock("./hooks/useTheme", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));
vi.mock("./hooks/useServiceWorker", () => ({ useServiceWorker: vi.fn() }));
vi.mock("./hooks/useAppGlobalEvents", () => ({
  useAppGlobalEvents: vi.fn(),
}));
vi.mock("./hooks/useTauriEvents", () => ({ useTauriEvents: vi.fn() }));
vi.mock("./hooks/useLocateFile", () => ({
  useLocateFile: () => ({ highlightedFileId: null }),
}));
vi.mock("./store/driveStore", () => ({
  useDriveStore: () => ({
    setIsLoadingTracks: vi.fn(),
    isLoadingTracks: false,
  }),
}));
vi.mock("./ui/Sidebar/Sidebar", () => ({
  Sidebar: (props: { onTabChange: (tab: unknown) => void }) => {
    mocks.sidebarProps.value = props;
    return <div data-testid="sidebar-stub" />;
  },
}));
vi.mock("./ui/NowPlaying/NowPlayingView", () => ({
  NowPlayingView: () => null,
}));
vi.mock("./ui/NowPlayingOverlay", () => ({ NowPlayingOverlay: () => null }));
vi.mock("./ui/FolderSelection/FolderSelectionScreen", () => ({
  FolderSelectionScreen: () => null,
}));
vi.mock("./ui/Settings/TrashScreen", () => ({ TrashScreen: () => null }));
vi.mock("./ui/components/RateLimitModal", () => ({
  RateLimitModal: () => null,
}));
vi.mock("./ui/Login/LoginScreen", () => ({ LoginScreen: () => null }));
vi.mock("./ui/MainContent/MainContent", () => ({
  MainContent: () => null,
}));
vi.mock("./ui/LikedSongs/LikedSongs", () => ({ LikedSongs: () => null }));
vi.mock("./ui/Playlist/PlaylistView", () => ({ PlaylistView: () => null }));
vi.mock("./ui/Settings/SettingsTab", () => ({ SettingsTab: () => null }));
vi.mock("./ui/HomeTab/HomeTab", () => ({
  HomeTab: () => <div data-testid="home-tab">HOME</div>,
}));

// PlayerBar stub: counts renders and captures the LIVE transport props so
// tests can assert wrapper identity across App re-renders. The memo
// comparator lives in the real component and is deliberately out of scope —
// this targets the App-level wrapper layer only.
vi.mock("./ui/PlayerBar/PlayerBar", () => ({
  PlayerBar: (props: {
    onNextTrack?: (...args: unknown[]) => unknown;
    onPrevTrack?: (...args: unknown[]) => unknown;
    onTogglePlay?: (...args: unknown[]) => unknown;
    onTogglePlayMode?: (...args: unknown[]) => unknown;
    onExpandNowPlaying?: () => void;
  }) => {
    mocks.playerBarRenders.value += 1;
    mocks.playerBarProps.value = props;
    return null;
  },
}));

describe("App stable transport wrappers (F1 — ref-delegate, stale handler guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.playerBarRenders.value = 0;
    mocks.playerBarProps.value = null;
    mocks.authState.isLoggedIn = true;
    mocks.playerHandlers.value = {
      handleTogglePlay: vi.fn(),
      handleNextTrack: vi.fn(),
      handlePrevTrack: vi.fn(),
      handleTogglePlayMode: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
  });

  function swapPlayerHandlers() {
    mocks.playerHandlers.value = {
      handleTogglePlay: vi.fn(),
      handleNextTrack: vi.fn(),
      handlePrevTrack: vi.fn(),
      handleTogglePlayMode: vi.fn(),
    };
  }

  it("wrapper identity stays stable across an App re-render even when usePlayer hands out fresh handler identities", async () => {
    render(<App />);
    await screen.findByTestId("home-tab");
    await waitFor(() => {
      expect(mocks.playerBarProps.value).not.toBeNull();
    });
    const before = mocks.playerBarProps.value;
    const rendersBefore = mocks.playerBarRenders.value;

    // Swap the handler identities AND force App to re-render (tab change).
    await act(async () => {
      swapPlayerHandlers();
      mocks.sidebarProps.value?.onTabChange("my-drive");
      await Promise.resolve();
    });

    // Prove App actually re-rendered (so this cannot pass vacuously).
    await waitFor(() => {
      expect(mocks.playerBarRenders.value).toBeGreaterThan(rendersBefore);
    });

    const after = mocks.playerBarProps.value;
    expect(after?.onNextTrack).toBe(before?.onNextTrack);
    expect(after?.onPrevTrack).toBe(before?.onPrevTrack);
    expect(after?.onTogglePlay).toBe(before?.onTogglePlay);
    expect(after?.onTogglePlayMode).toBe(before?.onTogglePlayMode);
  });

  it("a pre-mutation wrapper reference still reaches the LATEST handler", async () => {
    render(<App />);
    await screen.findByTestId("home-tab");
    await waitFor(() => {
      expect(mocks.playerBarProps.value).not.toBeNull();
    });

    // Capture the reference BEFORE the mutation — exactly what a memoized
    // child (whose comparator ignored handlers) would keep holding.
    const staleHeld = mocks.playerBarProps.value?.onNextTrack;
    expect(staleHeld).toBeTypeOf("function");
    const oldHandler = mocks.playerHandlers.value.handleNextTrack;

    await act(async () => {
      swapPlayerHandlers();
      mocks.sidebarProps.value?.onTabChange("my-drive");
      await Promise.resolve();
    });
    // The effect re-assigning the refs runs after commit — flush it.
    await act(async () => {});

    // Fire the old reference like the bar's `ended` subscription would.
    act(() => {
      (staleHeld as () => void)();
    });

    // It must delegate to the NEW handler — not the stale closure.
    const newHandler = mocks.playerHandlers.value.handleNextTrack;
    expect(newHandler).toHaveBeenCalledTimes(1);
    expect(oldHandler).not.toHaveBeenCalled();
  });
});
