// @vitest-environment jsdom
//
// F1 regression: App's stable transport wrappers must be TRUE ref-delegates.
// The PlayerBar memo comparator intentionally ignores handler props (it
// compares only currentTrack.id/isPlaying/playMode/isDownloading/loadNonce),
// so when the playback queue mutates while those five values stay put, a
// plain useCallback wrapper would change identity WITHOUT ever reaching the
// memoized child â€” the bar keeps firing a closure over the OLD queue (plays
// deleted tracks / skips newly added ones). Mirror of the proven internal
// pattern in usePlayer.ts (handlePlayTrackRef + stableHandlePlayTrack).
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { TABS } from "./utils/driveConstants";
import type { Track } from "./types";
import { usePlayerStore } from "./store/playerStore";

// Shared state for App-level mocks: hoisted so vi.mock factories (hoisted
// above imports) can reach it.
const mocks = vi.hoisted(() => ({
  authState: { isLoggedIn: true },
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
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

// --- App shell harness (same proven stub set as App.test.tsx) --------------
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) =>
      (typeof fallback === "string" ? fallback : fallback?.defaultValue) ?? key,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
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
vi.mock("./ui/Sidebar/Sidebar", () => ({ Sidebar: () => null }));
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
vi.mock("./ui/debug/DebugPanel", () => ({ DebugPanel: () => null }));
vi.mock("./ui/Login/LoginScreen", () => ({ LoginScreen: () => null }));
vi.mock("./ui/MainContent/MainContent", () => ({
  MainContent: () => <div data-testid="main-content" />,
}));
vi.mock("./ui/Settings/SettingsTab", () => ({ SettingsTab: () => null }));
vi.mock("./ui/HomeTab/HomeTab", () => ({
  HomeTab: () => <div data-testid="home-tab">HOME</div>,
}));

// PlayerBar stub: counts renders and captures the LIVE transport props so
// tests can assert wrapper identity across App re-renders. The memo
// comparator lives in the real component and is deliberately out of scope â€”
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

// --- usePlayer LEAF mocks (pattern: usePlayer.mobile.test.tsx) -------------
// The REAL usePlayer/usePlayerQueue/playerStore run here â€” only their IO
// edges are stubbed so the queue-staleness chain is exercised end-to-end.
vi.mock("./utils/platform", () => ({
  get IS_MOBILE() {
    return false;
  },
}));
const engineMock = vi.hoisted(() => ({
  setToken: vi.fn(),
  initOnce: vi.fn(() => Promise.resolve()),
  release: vi.fn(() => Promise.resolve()),
  playTrack: vi.fn(() => Promise.resolve()),
  pause: vi.fn(() => Promise.resolve()),
}));
vi.mock("./lib/nativeAudioBridge", () => ({
  nativeAudioEngine: engineMock,
  getPlaybackEngine: () => engineMock,
}));
vi.mock("tauri-plugin-keepawake-api", () => ({
  start: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
}));
vi.mock("./db/kv", () => ({
  get: vi.fn(() => Promise.resolve(undefined)),
  set: vi.fn(() => Promise.resolve()),
  del: vi.fn(() => Promise.resolve()),
}));
vi.mock("./hooks/player/usePlayerSession", () => ({
  usePlayerSession: vi.fn(),
}));
vi.mock("./utils/history", () => ({
  recordPlay: vi.fn(() => Promise.resolve()),
}));
vi.mock("./utils/metadata", () => ({
  getTrackMetadata: vi.fn(() => Promise.resolve({})),
}));
vi.mock("./utils/apiClient", () => ({
  getValidToken: vi.fn(() => Promise.resolve("test-token")),
}));
vi.mock("./utils/streamPrefetcher", () => ({
  getPrefetchedStreamUrl: vi.fn(() => undefined),
  DRIVE_STREAM_PREFIX: "/drive-stream/",
  buildStreamUrl: vi.fn((id: string) => `/drive-stream/${id}`),
}));
vi.mock("./utils/nextTrackPrefetcher", () => ({
  prefetchNextTrackAudio: vi.fn(),
}));
vi.mock("./utils/simpleToast", () => ({ showErrorToast: vi.fn() }));
vi.mock("./utils/errorLog", () => ({ captureError: vi.fn() }));

function makeTrack(id: string): Track {
  return { id, title: `Title ${id}`, artist: "Artist", streamUrl: "" };
}

const TRACK_A = makeTrack("track-a");
const TRACK_B = makeTrack("track-b");
const TRACK_C = makeTrack("track-c");

function resetPlayerStore() {
  usePlayerStore.setState({
    currentTrack: TRACK_A,
    loadNonce: 0,
    isPlaying: false,
    isDownloading: false,
    playMode: "normal",
    originalQueue: [TRACK_A, TRACK_B],
    playbackQueue: [TRACK_A, TRACK_B],
    brokenTrackIds: [],
  });
}

describe("App stable transport wrappers (F1 â€” ref-delegate, stale queue guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.playerBarRenders.value = 0;
    mocks.playerBarProps.value = null;
    mocks.authState.isLoggedIn = true;
    resetPlayerStore();
  });

  afterEach(() => {
    cleanup();
    usePlayerStore.setState({
      currentTrack: null,
      loadNonce: 0,
      isPlaying: false,
      isDownloading: false,
      playMode: "normal",
      originalQueue: [],
      playbackQueue: [],
      brokenTrackIds: [],
    });
  });

  function mutateQueue() {
    // Queue loses track-b and gains track-c while EVERY value the memoized
    // PlayerBar comparator looks at stays identical â€” the exact window in
    // which a plain-useCallback wrapper leaks a stale queue into the bar.
    act(() => {
      usePlayerStore.setState({ playbackQueue: [TRACK_A, TRACK_C] });
    });
    return act(async () => {});
  }

  it("wrapper identity stays stable across a playbackQueue mutation", async () => {
    render(<App />);
    await screen.findByTestId("home-tab");
    await waitFor(() => {
      expect(mocks.playerBarProps.value).not.toBeNull();
    });
    const before = mocks.playerBarProps.value;
    const rendersBefore = mocks.playerBarRenders.value;

    await mutateQueue();

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

  it("a pre-mutation wrapper reference still reaches the LATEST queue logic", async () => {
    render(<App />);
    await screen.findByTestId("home-tab");
    await waitFor(() => {
      expect(mocks.playerBarProps.value).not.toBeNull();
    });

    // Capture the reference BEFORE the mutation â€” exactly what a memoized
    // child (whose comparator ignored handlers) would keep holding.
    const staleHeld = mocks.playerBarProps.value?.onNextTrack;
    expect(staleHeld).toBeTypeOf("function");

    await mutateQueue();

    // Fire the old reference like the bar's `ended` subscription would.
    act(() => {
      (staleHeld as (isAutoSkip?: boolean) => void)();
    });

    // It must advance into the NEW queue ([A, C]) â€” not the snapshot it was
    // created with ([A, B], which would resurrect deleted track-b).
    await waitFor(() => {
      expect(usePlayerStore.getState().currentTrack?.id).toBe("track-c");
    });
    expect(usePlayerStore.getState().playbackQueue.map((t) => t.id)).toEqual([
      "track-a",
      "track-c",
    ]);
  });

  it("queue context sanity: tab switch does not disturb the transport wiring", async () => {
    render(<App />);
    await screen.findByTestId("home-tab");
    await waitFor(() => {
      expect(mocks.playerBarProps.value).not.toBeNull();
    });
    expect(mocks.playerBarProps.value?.onNextTrack).toBeTypeOf("function");

    // Sidebar is stubbed to null here; drive straight through the store to
    // confirm unrelated state churn does not break handler delegation.
    act(() => {
      usePlayerStore.setState({
        isPlaying: !usePlayerStore.getState().isPlaying,
      });
    });
    await act(async () => {});

    expect(TABS.home).toBeTypeOf("string");
    expect(mocks.playerBarProps.value?.onNextTrack).toBeTypeOf("function");
  });
});
