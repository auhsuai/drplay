// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { loadMinimizeToTrayState } from "./App";
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
      folderHistory: [],
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
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

// App now consumes react-i18next (Suspense fallback + unknown-tab label);
// stub useTranslation to return the fallback passed to t(), matching every
// other component test in the repo.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
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
vi.mock("./ui/PlayerBar/PlayerBar", () => ({ PlayerBar: () => null }));
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
vi.mock("./ui/Login/LoginScreen", () => ({ LoginScreen: () => null }));
vi.mock("./ui/MainContent/MainContent", () => ({
  MainContent: () => <div data-testid="main-content" />,
}));
vi.mock("./ui/LikedSongs/LikedSongs", () => ({ LikedSongs: () => null }));
vi.mock("./ui/Playlist/PlaylistView", () => ({ PlaylistView: () => null }));
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

// Lazy-useState initializer for the minimize-to-tray preference. Extracted
// from the inline initializer so the localStorage contract (default on first
// launch, strict 'true' match, tolerate blocked storage) is testable without
// mounting the whole lazy-loaded app tree.
describe("loadMinimizeToTrayState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("defaults to true when the key is missing (first launch — tray minimized)", () => {
    expect(loadMinimizeToTrayState()).toBe(true);
  });

  it("returns true when the stored value is exactly 'true'", () => {
    localStorage.setItem("drplay_minimize_to_tray", "true");
    expect(loadMinimizeToTrayState()).toBe(true);
  });

  it("returns false for any other stored value ('false' / corrupt)", () => {
    localStorage.setItem("drplay_minimize_to_tray", "false");
    expect(loadMinimizeToTrayState()).toBe(false);
    localStorage.setItem("drplay_minimize_to_tray", "garbage");
    expect(loadMinimizeToTrayState()).toBe(false);
  });

  it("falls back to true when localStorage.getItem throws (SecurityError)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(loadMinimizeToTrayState()).toBe(true);
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

  it("(b) home -> likedSongs -> home keeps HomeTab mounted", async () => {
    render(<App />);
    await waitFor(() => {
      expect(mocks.homeMounts.value).toBe(1);
    });

    await act(async () => {
      mocks.sidebarProps.value?.onTabChange(TABS.likedSongs);
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
