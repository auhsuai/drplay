// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { loadBackgroundPlaybackState } from "./appUiState";
import { TABS } from "./utils/driveConstants";
import { DEBUG_EVENTS } from "./ui/debug/debugEvents";

// Shared state for App-level mocks: hoisted so vi.mock factories (which are
// hoisted above imports) can reach it. authState is MUTABLE so tests can flip
// login state mid-test (logout -> login session-key contract).
const mocks = vi.hoisted(() => {
  const authState = { isLoggedIn: true };
  return {
    authState,
    // Counts HomeTab mounts made with a non-null token ("session mounts").
    // The token-null remount that fires on logout is the intended data wipe
    // and is deliberately NOT counted — see the keep-alive describe below.
    homeMounts: { value: 0 },
    sidebarProps: {
      value: null as null | { onTabChange: (tab: unknown) => void },
    },
    invoke: vi.fn(() => Promise.resolve(undefined)),
    useAuth: vi.fn(() => ({
      isLoggedIn: authState.isLoggedIn,
      // Mirrors real useAuth: logout clears the access token, login restores it.
      accessToken: authState.isLoggedIn ? "tok" : null,
      userProfile: {
        name: "Test User",
        email: "test@example.com",
        picture: "",
      },
      handleLoginSuccess: vi.fn(),
      handleLogout: vi.fn(),
    })),
    useDrive: vi.fn(() => ({
      appRootFolder: "root",
      setAppRootFolder: vi.fn(),
      currentFolderId: "root",
      setCurrentFolderId: vi.fn(),
      currentFolderName: "My Drive",
      setCurrentFolderName: vi.fn(),
      folderHistory: [] as { id: string; name: string }[],
      setFolderHistory: vi.fn(),
      sortOption: "name",
      setSortOption: vi.fn(),
      handleOpenFolder: vi.fn(),
      handleBack: vi.fn(),
      handleBreadcrumbClick: vi.fn(),
      handleSelectRootFolder: vi.fn(),
    })),
    usePlayer: vi.fn(() => ({
      currentTrack: null,
      isPlaying: false,
      isDownloading: false,
      playMode: "normal",
      handlePlayTrack: vi.fn(),
      handleNextTrack: vi.fn(),
      handlePrevTrack: vi.fn(),
      handleTogglePlay: vi.fn(),
      handleTogglePlayMode: vi.fn(),
      loadNonce: 0,
    })),
    useTheme: vi.fn(() => ({ theme: "dark", setTheme: vi.fn() })),
    useServiceWorker: vi.fn(),
    useAppGlobalEvents: vi.fn(),
    useTauriEvents: vi.fn(),
    useLocateFile: vi.fn(() => ({ highlightedFileId: null })),
    useDriveStore: vi.fn(() => ({
      setIsLoadingTracks: vi.fn(),
      isLoadingTracks: false,
    })),
    // RateLimitGate stub captures the live RateLimitModal props so tests can
    // assert isOpen flips when the debug RATE_LIMIT event fires.
    rateLimitModalProps: {
      value: null as null | {
        isOpen: boolean;
        onClose: () => void;
        onOk: () => void;
      },
    },
    // Task 9 mobile-polish: plugin-process exit() — mocked so the
    // double-back-to-exit path can be asserted instead of invoking Tauri.
    processExit: vi.fn(() => Promise.resolve(undefined)),
    // PlayerBar stub captures onExpandNowPlaying so the NowPlaying overlay
    // can be opened exactly like a real tap on the track info.
    playerBarProps: {
      value: null as null | { onExpandNowPlaying: () => void },
    },
    // NowPlayingOverlay stub captures the live isOpen prop for assertions
    // (same pattern as rateLimitModalProps above).
    nowPlayingOverlayProps: {
      value: null as null | { isOpen: boolean },
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-process", () => ({ exit: mocks.processExit }));

// Task 9 mobile-polish upgrade: App now subscribes to the official
// onBackButtonPress event (Tauri 2.9+) instead of the popstate hack. The mock
// captures the registered handler so tests can fire a native back press; the
// returned unregister is stubbed for cleanup assertions.
const appApiMock = vi.hoisted(() => ({
  onBackButtonPress: vi.fn(),
  nativeBackHandler: { value: null as null | (() => void) },
  unregister: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({
  onBackButtonPress: (handler: () => void) => {
    appApiMock.nativeBackHandler.value = handler;
    return Promise.resolve({ unregister: appApiMock.unregister });
  },
}));

// IS_MOBILE is read inside effect bodies (run time), so a getter-backed mock
// lets tests flip the platform mid-suite (pattern: LoginScreen.test.tsx).
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("./utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

// App now consumes react-i18next (Suspense fallback + unknown-tab label);
// stub useTranslation to return the fallback passed to t(), matching every
// other component test in the repo. Task 9 passes { defaultValue } (options
// object) — resolve it like SettingsTab.test.tsx does.
// initReactI18next is stubbed too: ErrorBoundary (in this graph via AppShell)
// imports src/i18n, whose module scope calls i18n.use(initReactI18next)
// (same transitive-import case as SongCard.test.tsx).
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) =>
      (typeof fallback === "string" ? fallback : fallback?.defaultValue) ?? key,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("./hooks/useAuth", () => ({ useAuth: mocks.useAuth }));
vi.mock("./hooks/useDrive", () => ({ useDrive: mocks.useDrive }));
vi.mock("./hooks/usePlayer", () => ({ usePlayer: mocks.usePlayer }));
vi.mock("./hooks/useTheme", () => ({ useTheme: mocks.useTheme }));
vi.mock("./hooks/useServiceWorker", () => ({
  useServiceWorker: mocks.useServiceWorker,
}));
vi.mock("./hooks/useAppGlobalEvents", () => ({
  useAppGlobalEvents: mocks.useAppGlobalEvents,
}));
vi.mock("./hooks/useTauriEvents", () => ({
  useTauriEvents: mocks.useTauriEvents,
}));
vi.mock("./hooks/useLocateFile", () => ({
  useLocateFile: mocks.useLocateFile,
}));
vi.mock("./store/driveStore", () => ({ useDriveStore: mocks.useDriveStore }));

// Sidebar stub captures the live onTabChange prop so tests can switch tabs
// exactly like a real click.
vi.mock("./ui/Sidebar/Sidebar", () => ({
  Sidebar: (props: { onTabChange: (tab: unknown) => void }) => {
    mocks.sidebarProps.value = props;
    return <div data-testid="sidebar-stub" />;
  },
}));
vi.mock("./ui/NowPlaying/NowPlayingView", () => ({
  NowPlayingView: () => null,
}));
vi.mock("./ui/PlayerBar/PlayerBar", () => ({
  PlayerBar: (props: { onExpandNowPlaying: () => void }) => {
    mocks.playerBarProps.value = props;
    return null;
  },
}));
vi.mock("./ui/NowPlayingOverlay", () => ({
  NowPlayingOverlay: (props: { isOpen: boolean }) => {
    mocks.nowPlayingOverlayProps.value = props;
    return null;
  },
}));
vi.mock("./ui/FolderSelection/FolderSelectionScreen", () => ({
  FolderSelectionScreen: () => null,
}));
vi.mock("./ui/Settings/TrashScreen", () => ({ TrashScreen: () => null }));
vi.mock("./ui/components/RateLimitModal", () => ({
  RateLimitModal: (props: {
    isOpen: boolean;
    onClose: () => void;
    onOk: () => void;
  }) => {
    mocks.rateLimitModalProps.value = props;
    return null;
  },
}));
// DebugPanel is DEV-gated via import.meta.env.DEV, which vitest evaluates as
// true — mock it so the App-level tests stay unaffected by the debug overlay.
vi.mock("./ui/debug/DebugPanel", () => ({ DebugPanel: () => null }));
vi.mock("./ui/Login/LoginScreen", () => ({ LoginScreen: () => null }));
vi.mock("./ui/MainContent/MainContent", () => ({
  MainContent: () => <div data-testid="main-content" />,
}));
vi.mock("./ui/Settings/SettingsTab", () => ({ SettingsTab: () => null }));

// HomeTab mock counts MOUNTS (not renders): useEffect with [] runs once per
// mount, so tab switches that only re-render the parent cannot inflate it.
vi.mock("./ui/HomeTab/HomeTab", async () => {
  const { useEffect } = await import("react");
  return {
    HomeTab: ({ token }: { token?: string | null }) => {
      useEffect(() => {
        if (token) mocks.homeMounts.value += 1;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount counter: must run exactly once per mount, token changes must NOT recount
      }, []);
      return <div data-testid="home-tab">HOME</div>;
    },
  };
});

// Task 3 mobile-polish: background-playback preference — same lazy-useState
// localStorage contract (default on first launch, strict 'true' match,
// tolerate blocked storage), but the DEFAULT is ON (native audio
// keeps playing in the background via the foreground service; the OFF toggle
// opts into pause-on-hidden).
describe("loadBackgroundPlaybackState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("defaults to true when the key is missing (first launch — background playback on)", () => {
    expect(loadBackgroundPlaybackState()).toBe(true);
  });

  it("returns true when the stored value is exactly 'true'", () => {
    localStorage.setItem("drplay_background_playback", "true");
    expect(loadBackgroundPlaybackState()).toBe(true);
  });

  it("returns false for any other stored value ('false' / corrupt)", () => {
    localStorage.setItem("drplay_background_playback", "false");
    expect(loadBackgroundPlaybackState()).toBe(false);
    localStorage.setItem("drplay_background_playback", "garbage");
    expect(loadBackgroundPlaybackState()).toBe(false);
  });

  it("falls back to true when localStorage.getItem throws (SecurityError)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(loadBackgroundPlaybackState()).toBe(true);
  });
});

// Regression: HomeTab was conditionally rendered (`activeTab === home ?
// <HomeTab/> : ...`), so every tab switch unmounted it and the mount-effect
// refetched all home data (Recently Added etc.). The fix keeps HomeTab always
// mounted and hides it with display:none, keyed by login session so
// logout -> login still remounts cleanly.
describe("HomeTab keep-alive across tab switches", () => {
  beforeEach(() => {
    mocks.homeMounts.value = 0;
    mocks.authState.isLoggedIn = true;
  });

  afterEach(() => {
    cleanup();
  });

  it("(a) home -> myDrive -> home keeps HomeTab mounted (no refetch remount)", async () => {
    render(<App />);
    await waitFor(() => {
      expect(mocks.homeMounts.value).toBe(1);
    });

    await act(async () => {
      mocks.sidebarProps.value?.onTabChange(TABS.myDrive);
      await Promise.resolve();
    });
    await screen.findByTestId("main-content");
    await act(async () => {
      mocks.sidebarProps.value?.onTabChange(TABS.home);
      await Promise.resolve();
    });
    await screen.findByTestId("home-tab");

    await waitFor(() => {
      expect(mocks.homeMounts.value).toBe(1);
    });
  });

  it("(b) home -> settings -> home keeps HomeTab mounted", async () => {
    render(<App />);
    await waitFor(() => {
      expect(mocks.homeMounts.value).toBe(1);
    });

    await act(async () => {
      mocks.sidebarProps.value?.onTabChange(TABS.settings);
      await Promise.resolve();
    });
    await act(async () => {
      mocks.sidebarProps.value?.onTabChange(TABS.home);
      await Promise.resolve();
    });
    await screen.findByTestId("home-tab");

    await waitFor(() => {
      expect(mocks.homeMounts.value).toBe(1);
    });
  });

  it("(c) logout then login remounts HomeTab with a fresh session", async () => {
    const { rerender } = render(<App />);
    await waitFor(() => {
      expect(mocks.homeMounts.value).toBe(1);
    });

    mocks.authState.isLoggedIn = false;
    await act(async () => {
      rerender(<App />);
      await Promise.resolve();
    });
    mocks.authState.isLoggedIn = true;
    await act(async () => {
      rerender(<App />);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.homeMounts.value).toBe(2);
    });
  });

  it("(d) HomeTab stays in the DOM hidden while another tab is active", async () => {
    render(<App />);
    await screen.findByTestId("home-tab");

    await act(async () => {
      mocks.sidebarProps.value?.onTabChange(TABS.myDrive);
      await Promise.resolve();
    });
    await screen.findByTestId("main-content");

    const homeTab = screen.getByTestId("home-tab");
    expect(homeTab).toBeTruthy();
    const homeParent = homeTab.parentElement;
    expect(homeParent).not.toBeNull();
    if (homeParent) {
      expect(homeParent.className).toContain("hidden");
    }

    await act(async () => {
      mocks.sidebarProps.value?.onTabChange(TABS.home);
      await Promise.resolve();
    });
    const homeParent2 = screen.getByTestId("home-tab").parentElement;
    expect(homeParent2).not.toBeNull();
    if (homeParent2) {
      expect(homeParent2.className).not.toContain("hidden");
    }
  });
});

describe("App debug rate-limit trigger (DEV only)", () => {
  afterEach(() => {
    mocks.rateLimitModalProps.value = null;
    cleanup();
  });

  it("opens the rate-limit modal when the RATE_LIMIT debug event fires", () => {
    render(<App />);
    expect(mocks.rateLimitModalProps.value?.isOpen).toBe(false);

    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.RATE_LIMIT));
    });

    expect(mocks.rateLimitModalProps.value?.isOpen).toBe(true);
  });

  it("stays open on a second RATE_LIMIT while already open (idempotent — no toggle)", () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.RATE_LIMIT));
    });
    expect(mocks.rateLimitModalProps.value?.isOpen).toBe(true);

    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.RATE_LIMIT));
    });

    expect(mocks.rateLimitModalProps.value?.isOpen).toBe(true);
  });

  it("closes through the existing onClose mechanism after a debug-open", () => {
    render(<App />);
    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.RATE_LIMIT));
    });
    expect(mocks.rateLimitModalProps.value?.isOpen).toBe(true);

    act(() => {
      mocks.rateLimitModalProps.value?.onClose();
    });

    expect(mocks.rateLimitModalProps.value?.isOpen).toBe(false);
  });

  it("removes the listener on unmount (no crash on a later dispatch)", () => {
    const { unmount } = render(<App />);
    unmount();

    expect(() => {
      act(() => {
        window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.RATE_LIMIT));
      });
    }).not.toThrow();
  });
});

describe("App debug skeleton trigger (DEV only)", () => {
  afterEach(() => {
    cleanup();
  });

  // The useDriveStore mock returns a fresh object per call; grab the setters
  // from the LAST render (the one this test mounted).
  function lastStoreSetters() {
    const results = mocks.useDriveStore.mock.results;
    const store = results[results.length - 1]?.value as
      { setIsLoadingTracks: ReturnType<typeof vi.fn> } | undefined;
    if (store === undefined) throw new Error("expected useDriveStore call");
    return store.setIsLoadingTracks;
  }

  it("flips setIsLoadingTracks(true) when the SKELETON event targets main-content", () => {
    render(<App />);
    const setIsLoadingTracks = lastStoreSetters();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(DEBUG_EVENTS.SKELETON, {
          detail: { target: "main-content" },
        }),
      );
    });

    expect(setIsLoadingTracks).toHaveBeenCalledWith(true);
  });

  it("ignores SKELETON events targeting another view (no store write)", () => {
    render(<App />);
    const setIsLoadingTracks = lastStoreSetters();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(DEBUG_EVENTS.SKELETON, {
          detail: { target: "trash" },
        }),
      );
    });

    expect(setIsLoadingTracks).not.toHaveBeenCalled();
  });

  it("ignores a raw SKELETON event with an unknown target (no crash)", () => {
    render(<App />);
    const setIsLoadingTracks = lastStoreSetters();

    expect(() => {
      act(() => {
        window.dispatchEvent(
          new CustomEvent(DEBUG_EVENTS.SKELETON, {
            detail: { target: "unknown" },
          }),
        );
      });
    }).not.toThrow();
    expect(setIsLoadingTracks).not.toHaveBeenCalled();
  });

  it("removes the listener on unmount (no crash on a later dispatch)", () => {
    const { unmount } = render(<App />);
    unmount();

    expect(() => {
      act(() => {
        window.dispatchEvent(
          new CustomEvent(DEBUG_EVENTS.SKELETON, {
            detail: { target: "main-content" },
          }),
        );
      });
    }).not.toThrow();
  });
});

// Task 9 mobile-polish: Android back chain — non-Home tabs return Home, and
// back at Home is double-back-to-exit (hint toast + 2s window) instead of
// exiting immediately. The chain is now driven by the official
// onBackButtonPress event; Desktop never wires the native back listener at
// all.
describe("App mobile back chain (tab->Home + double-back-to-exit)", () => {
  const BACK_HINT = "back.press_again_to_exit";

  beforeEach(() => {
    mocks.processExit.mockClear();
    appApiMock.onBackButtonPress.mockClear();
    appApiMock.nativeBackHandler.value = null;
    // Sidebar defaults to OPEN (desktop contract) — on mobile it renders
    // hidden, so the open state would register the sidebar-close back handler
    // and silently swallow the first press. Realistic mobile state: closed.
    localStorage.setItem("drplay_sidebar_open", "false");
  });

  afterEach(() => {
    platformMock.IS_MOBILE = false;
    vi.useRealTimers();
    cleanup();
  });

  const pressBack = () => {
    act(() => {
      appApiMock.nativeBackHandler.value?.();
    });
  };

  it("desktop: never wires the native back listener (no exit, no toast)", async () => {
    render(<App />);
    await screen.findByTestId("home-tab");

    pressBack();

    expect(appApiMock.onBackButtonPress).not.toHaveBeenCalled();
    expect(mocks.processExit).not.toHaveBeenCalled();
    expect(screen.queryByText(BACK_HINT)).toBeNull();
  });

  it("mobile: first back at Home shows the hint toast and does NOT exit", async () => {
    platformMock.IS_MOBILE = true;
    render(<App />);
    await screen.findByTestId("home-tab");

    vi.useFakeTimers();
    pressBack();

    expect(screen.getByText(BACK_HINT)).toBeTruthy();
    expect(mocks.processExit).not.toHaveBeenCalled();
  });

  it("mobile: second back within the 2s window exits the app", async () => {
    platformMock.IS_MOBILE = true;
    render(<App />);
    await screen.findByTestId("home-tab");

    vi.useFakeTimers();
    pressBack();
    vi.advanceTimersByTime(1000);
    expect(mocks.processExit).not.toHaveBeenCalled();

    pressBack();

    expect(mocks.processExit).toHaveBeenCalledWith(0);
  });

  it("mobile: back on Settings returns Home (no exit, no toast)", async () => {
    platformMock.IS_MOBILE = true;
    render(<App />);
    await screen.findByTestId("home-tab");

    await act(async () => {
      mocks.sidebarProps.value?.onTabChange(TABS.settings);
      await Promise.resolve();
    });
    const homeWrapper = screen.getByTestId("home-tab").parentElement;
    expect(homeWrapper?.className).toContain("hidden");

    pressBack();

    const homeWrapper2 = screen.getByTestId("home-tab").parentElement;
    expect(homeWrapper2?.className).not.toContain("hidden");
    expect(mocks.processExit).not.toHaveBeenCalled();
    expect(screen.queryByText(BACK_HINT)).toBeNull();
  });

  it("mobile: back after the 2s window expired arms again (toast, no exit)", async () => {
    platformMock.IS_MOBILE = true;
    render(<App />);
    await screen.findByTestId("home-tab");

    vi.useFakeTimers();
    pressBack();
    vi.advanceTimersByTime(2000);
    pressBack();

    expect(screen.getByText(BACK_HINT)).toBeTruthy();
    expect(mocks.processExit).not.toHaveBeenCalled();
  });
});
// Task 14 mobile-polish: My Drive folder drill-down is a LIFO navigation
// layer ABOVE NowPlaying/tab/exit — back on a subfolder pops one history
// level instead of falling straight into the double-back-to-exit chain.
describe("App mobile back chain (Task 14: My Drive folder layer)", () => {
  const BACK_HINT = "back.press_again_to_exit";

  const defaultDrive = () => ({
    appRootFolder: "root",
    setAppRootFolder: vi.fn(),
    currentFolderId: "root",
    setCurrentFolderId: vi.fn(),
    currentFolderName: "My Drive",
    setCurrentFolderName: vi.fn(),
    folderHistory: [] as { id: string; name: string }[],
    setFolderHistory: vi.fn(),
    sortOption: "name",
    setSortOption: vi.fn(),
    handleOpenFolder: vi.fn(),
    handleBack: vi.fn(),
    handleBreadcrumbClick: vi.fn(),
    handleSelectRootFolder: vi.fn(),
  });

  beforeEach(() => {
    appApiMock.onBackButtonPress.mockClear();
    appApiMock.nativeBackHandler.value = null;
    localStorage.setItem("drplay_sidebar_open", "false");
  });

  afterEach(() => {
    mocks.useDrive.mockImplementation(defaultDrive);
    platformMock.IS_MOBILE = false;
    vi.useRealTimers();
    cleanup();
  });

  const pressBack = () => {
    act(() => {
      appApiMock.nativeBackHandler.value?.();
    });
  };

  const openMyDrive = async () => {
    await act(async () => {
      mocks.sidebarProps.value?.onTabChange(TABS.myDrive);
      await Promise.resolve();
    });
    await screen.findByTestId("main-content");
  };

  it("mobile: back in a My Drive subfolder pops one history level (no exit, no toast)", async () => {
    platformMock.IS_MOBILE = true;
    const drive = defaultDrive();
    drive.currentFolderId = "folder-1";
    drive.folderHistory = [{ id: "root", name: "My Drive" }];
    mocks.useDrive.mockImplementation(() => drive);
    render(<App />);
    await screen.findByTestId("home-tab");
    await openMyDrive();

    pressBack();

    expect(drive.handleBack).toHaveBeenCalledTimes(1);
    expect(mocks.processExit).not.toHaveBeenCalled();
    expect(screen.queryByText(BACK_HINT)).toBeNull();
  });

  it("mobile: back at My Drive root is not consumed (falls to tab layer -> Home)", async () => {
    platformMock.IS_MOBILE = true;
    const drive = defaultDrive();
    mocks.useDrive.mockImplementation(() => drive);
    render(<App />);
    await screen.findByTestId("home-tab");
    await openMyDrive();
    expect(screen.getByTestId("home-tab").parentElement?.className).toContain(
      "hidden",
    );

    pressBack();

    expect(drive.handleBack).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("home-tab").parentElement?.className,
    ).not.toContain("hidden");
    expect(mocks.processExit).not.toHaveBeenCalled();
  });

  it("mobile: open sidebar closes before folder-up (overlay layer wins)", async () => {
    platformMock.IS_MOBILE = true;
    localStorage.setItem("drplay_sidebar_open", "true");
    const drive = defaultDrive();
    drive.currentFolderId = "folder-1";
    drive.folderHistory = [{ id: "root", name: "My Drive" }];
    mocks.useDrive.mockImplementation(() => drive);
    render(<App />);
    await screen.findByTestId("home-tab");
    await openMyDrive();

    pressBack();

    expect(drive.handleBack).not.toHaveBeenCalled();
    expect(mocks.processExit).not.toHaveBeenCalled();
  });

  it("mobile: subfolder with empty history jumps to root (restore/deep-link edge)", async () => {
    platformMock.IS_MOBILE = true;
    const drive = defaultDrive();
    drive.currentFolderId = "folder-1";
    drive.folderHistory = [];
    mocks.useDrive.mockImplementation(() => drive);
    render(<App />);
    await screen.findByTestId("home-tab");
    await openMyDrive();

    pressBack();

    expect(drive.setCurrentFolderId).toHaveBeenCalledWith("root");
    expect(drive.setCurrentFolderName).toHaveBeenCalledWith("My Drive");
    expect(mocks.processExit).not.toHaveBeenCalled();
  });

  // Task 15: NowPlaying closes BEFORE the folder-up layer — the handler is
  // registered last in App (after the rate-limit handler), so LIFO checks it
  // first even when My Drive drill-down is active (previously the folder-up
  // handler swallowed the press and NowPlaying never closed).
  it("mobile: back with NowPlaying open in a subfolder closes NowPlaying, does NOT pop folder history", async () => {
    platformMock.IS_MOBILE = true;
    const drive = defaultDrive();
    drive.currentFolderId = "folder-1";
    drive.folderHistory = [{ id: "root", name: "My Drive" }];
    mocks.useDrive.mockImplementation(() => drive);
    render(<App />);
    await screen.findByTestId("home-tab");
    await openMyDrive();

    expect(mocks.nowPlayingOverlayProps.value?.isOpen).toBe(false);
    await act(async () => {
      mocks.playerBarProps.value?.onExpandNowPlaying();
      await Promise.resolve();
    });
    expect(mocks.nowPlayingOverlayProps.value?.isOpen).toBe(true);

    pressBack();

    expect(mocks.nowPlayingOverlayProps.value?.isOpen).toBe(false);
    expect(drive.handleBack).not.toHaveBeenCalled();
    expect(mocks.processExit).not.toHaveBeenCalled();
    expect(screen.queryByText(BACK_HINT)).toBeNull();
  });

  it("mobile: back with NowPlaying open at Home closes NowPlaying (no exit toast)", async () => {
    platformMock.IS_MOBILE = true;
    render(<App />);
    await screen.findByTestId("home-tab");

    await act(async () => {
      mocks.playerBarProps.value?.onExpandNowPlaying();
      await Promise.resolve();
    });
    expect(mocks.nowPlayingOverlayProps.value?.isOpen).toBe(true);

    pressBack();

    expect(mocks.nowPlayingOverlayProps.value?.isOpen).toBe(false);
    expect(mocks.processExit).not.toHaveBeenCalled();
    expect(screen.queryByText(BACK_HINT)).toBeNull();
  });
});
