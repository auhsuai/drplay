// @vitest-environment jsdom
//
// PiP protocol parity (Slice 1/3): the PiP window is a SEPARATE webview with no
// engine, so everything its seekbar/volume/spinner UI needs must cross the IPC
// boundary in `pip-state`. Two things that used to be absent are covered here:
//
//  1. `buffered` — the engine exposes `TimeRanges` (mpvAudio builds it with
//     closure functions via `toTimeRanges`), which is NOT structured-cloneable.
//     `publishPipState` must flatten it to a plain `{start,end}[]` and drop
//     ranges that cannot be drawn, and a failing/odd `getBuffered()` must
//     degrade to `[]` instead of killing the whole publish.
//  2. `isDownloading` — the "preparing to play" intent window that both
//     fullscreen transport surfaces use for their spinner gate.
//  3. The `retry` action — the PiP error surface must reach the SAME
//     `retryCurrentTrack` the PlayerBar/NowPlaying retry button runs, and the
//     handler must republish state afterwards (retry changes `hasError`).
//
// The App is mounted whole (not a pure payload builder) so the assertions hit
// the real `publishPipState` + the real `pip-action` switch, not a copy.
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { PIP_EVENTS, type PipStatePayload } from "./lib/pipWindow";
import {
  getVideoHostOwner,
  getVideoPresentationStatus,
  setVideoHostOwner,
  setVideoPresentationStatus,
} from "./lib/videoHost";
import { usePlayerStore } from "./store/playerStore";

const RETARGET_TO_MAIN = "video_surface_retarget_to_main_cmd";
const RETARGET_TO_PIP = "video_surface_retarget_to_pip_cmd";

interface FakeTrack {
  id: string;
  title: string;
  artist: string;
  streamUrl: string;
  originalName: string;
}

function fakeVideo(id = "video-1"): FakeTrack {
  return {
    id,
    title: "Video",
    artist: "Artist",
    streamUrl: "stream",
    originalName: "movie.mkv",
  };
}

interface FakeTimeRanges {
  length: number;
  start: (index: number) => number;
  end: (index: number) => number;
}

interface FakeAudio {
  getCurrentTime: () => number;
  getDuration: () => number;
  getVolume: () => number;
  isMuted: () => boolean;
  getBuffered: () => { buffered: FakeTimeRanges };
  on: () => () => void;
  seek: () => void;
  // Typed with the real parameter so the mock can record the level it was
  // handed (the PiP path must forward the payload it received).
  setVolume: (value: number) => void;
  toggleMute: () => boolean;
  pause: () => void;
  playTrack: () => Promise<void>;
}

interface CapturedListen {
  (event: { payload: unknown }): void;
}

const mocks = vi.hoisted(() => {
  // Mutable engine state: `getVolume`/`isMuted` read it and `setVolume`/
  // `toggleMute` write it, like the real engine. A stateless fake could not
  // tell the level the caller ASKED for apart from the one that actually
  // landed — and the player-ui bus must announce the latter.
  const engine = { volume: 0.5, muted: false };

  // The ONE default IPC behaviour shared by every describe. Both surface
  // hand-offs RESOLVE `"retargeted"` because that is the only success the new
  // contract has: a bare `undefined` (the old default) is now an UNRESOLVED
  // outcome, which would send every pre-existing test down the failure path.
  // Everything else still resolves `undefined`, exactly as before.
  const defaultInvoke = (command: string): Promise<unknown> => {
    // Literals, not the module-scope constants: `vi.hoisted` runs before the
    // module body, so anything declared below it would be in TDZ here.
    return Promise.resolve<unknown>(
      command === "video_surface_retarget_to_main_cmd" ||
        command === "video_surface_retarget_to_pip_cmd"
        ? "retargeted"
        : undefined,
    );
  };

  // Typed with the real call shape so `mock.calls[i][0]` is the command name:
  // the PiP entry tests assert invocation ORDER across several `invoke` calls
  // (mpv_spawn before the retarget), which requires reading the tuple.
  const invoke = vi.fn((...args: [command: string, args?: unknown]) =>
    defaultInvoke(args[0]),
  );

  // Mutable per-test player values: `isDownloading` is what the payload must
  // mirror, the track must be a VIDEO so enterPip's guard lets us in, and
  // `isPlaying` decides whether enterPip has to resume before handing over.
  // `currentTrack` is explicitly nullable: "no track selected" is a real state
  // the publisher has to represent (`trackId: null`).
  const initialPlayer: {
    isDownloading: boolean;
    isPlaying: boolean;
    currentTrack: {
      id: string;
      title: string;
      artist: string;
      streamUrl: string;
      originalName: string;
    } | null;
  } = {
    isDownloading: false,
    isPlaying: true,
    currentTrack: {
      id: "video-1",
      title: "Video",
      artist: "Artist",
      streamUrl: "stream",
      originalName: "movie.mkv",
    },
  };

  return {
    defaultInvoke,
    // Any describe that needs a clean slate uses this instead of `mockReset`,
    // so a per-test `mockImplementation` cannot leak while the default keeps
    // answering `"retargeted"` for the hand-offs.
    resetInvoke: (): void => {
      invoke.mockReset();
      invoke.mockImplementation((...args: [command: string]) =>
        defaultInvoke(args[0]),
      );
    },
    player: {
      value: initialPlayer,
    },
    // Hoisted so a test can assert enterPip's resume decision; an inline vi.fn()
    // in the mock factory would be a fresh function on every render.
    handleTogglePlay: vi.fn(),
    // `engine` is reset per test; `getBufferedImpl` is swapped by each test.
    audio: {
      engine,
      getBufferedImpl: (): { buffered: FakeTimeRanges } => ({
        buffered: { length: 0, start: () => 0, end: () => 0 },
      }),
      seek: vi.fn(),
      // Same clamp the engine applies, so "0.42 in" and "0.42 read back" agree.
      setVolume: vi.fn((value: number) => {
        engine.volume = Math.min(1, Math.max(0, value));
      }),
      // Mirrors the real engine: flips the flag and returns the new state.
      toggleMute: vi.fn(() => {
        engine.muted = !engine.muted;
        return engine.muted;
      }),
      // The engine half of "Close pauses". `closePipToBackground` must reach
      // the same two writers the Play/Pause button does, so this spy is the
      // only way to tell a real pause from a store-only flag flip.
      pause: vi.fn(),
    },
    // The player-ui bus is the seam that carries volume changes typed in one
    // window to the sliders in another; App must announce PiP-driven writes
    // through it, so it is a spy rather than the real set-based bus.
    emitPlayerUi: vi.fn(),
    // Args are declared so assertions can read the captured call tuple; the
    // mock itself never sends anything, hence the explicit `void args`.
    emitTo: vi.fn((...args: [string, string, unknown?]) => {
      void args;
      return Promise.resolve();
    }),
    listenHandlers: new Map<string, CapturedListen>(),
    invoke,
    retryCurrentTrack: vi.fn(),
    // PlayerCommandContext is the only public seam that reaches enterPip; the
    // hook is stubbed to capture it (the real one only attaches keydown).
    commandContext: { value: null as Record<string, unknown> | null },
    openPip: vi.fn(() => Promise.resolve({ label: "pip" })),
    requestOwner: vi.fn(() => Promise.resolve(true)),
    closePip: vi.fn(() => Promise.resolve()),
    // The main window handle. `closePip` must NOT touch any of these: closing
    // the PiP window returns the video to a main window that stays exactly as
    // the user left it (possibly minimized, possibly behind other apps).
    mainWindow: {
      show: vi.fn(() => Promise.resolve()),
      unminimize: vi.fn(() => Promise.resolve()),
      setFocus: vi.fn(() => Promise.resolve()),
    },
    // Hoisted (not inline in the `./lib/pipWindow` factory) so a test can make
    // the liveness poller believe the PiP window vanished and drive the REAL
    // external-close recovery instead of a copy of it.
    isPipWindowOpen: vi.fn(() => Promise.resolve(true)),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mocks.mainWindow,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: CapturedListen) => {
    mocks.listenHandlers.set(event, handler);
    return Promise.resolve(() => undefined);
  }),
  emitTo: mocks.emitTo,
  emit: vi.fn(() => Promise.resolve()),
}));

// Keep the REAL protocol constants/shape; only the window lifecycle (which
// would construct a real WebviewWindow in jsdom) is replaced.
vi.mock("./lib/pipWindow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/pipWindow")>();
  return {
    ...actual,
    openPipWindowAndWaitReady: mocks.openPip,
    requestPipOwner: mocks.requestOwner,
    closePipWindow: mocks.closePip,
    isPipWindowOpen: mocks.isPipWindowOpen,
    releasePipWindow: vi.fn(() => Promise.resolve(true)),
  };
});

vi.mock("./lib/AudioController", () => ({
  AudioController: {
    getInstance: () =>
      ({
        getCurrentTime: () => 12.5,
        getDuration: () => 120,
        getVolume: () => mocks.audio.engine.volume,
        isMuted: () => mocks.audio.engine.muted,
        getBuffered: () => mocks.audio.getBufferedImpl(),
        on: () => () => undefined,
        seek: mocks.audio.seek,
        setVolume: mocks.audio.setVolume,
        toggleMute: mocks.audio.toggleMute,
        pause: mocks.audio.pause,
        playTrack: () => Promise.resolve(),
      }) satisfies FakeAudio,
  },
}));

// App subscribes to the bus for dialogs/toasts and (after this fix) publishes
// volume changes to it, so the mock keeps both halves: the spy the PiP tests
// assert on and an inert `onPlayerUi` that App can call without crashing.
vi.mock("./player/playerUiBus", () => ({
  emitPlayerUi: mocks.emitPlayerUi,
  onPlayerUi: () => () => undefined,
}));

vi.mock("./utils/playerError", () => ({
  retryCurrentTrack: mocks.retryCurrentTrack,
  resetAdvanceGuard: vi.fn(),
}));

vi.mock("./player/usePlayerCommands", () => ({
  usePlayerCommands: (context: Record<string, unknown>) => {
    mocks.commandContext.value = context;
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("./hooks/useAuth", () => ({
  useAuth: () => ({
    isLoggedIn: true,
    isAuthHydrated: true,
    accessToken: "tok",
    userProfile: { name: "Test User", email: "t@example.com", picture: "" },
    handleLoginSuccess: vi.fn(),
    handleLogout: vi.fn(),
  }),
}));

vi.mock("./hooks/useDrive", () => ({
  useDrive: () => ({
    appRootFolder: "root",
    rootFolders: [{ id: "root", name: "Root" }],
    isHydrated: true,
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
    commitRootFolders: vi.fn(() => Promise.resolve(true)),
    handleSelectRootFolder: vi.fn(),
  }),
}));

vi.mock("./hooks/usePlayer", () => ({
  usePlayer: () => ({
    currentTrack: mocks.player.value.currentTrack,
    isPlaying: mocks.player.value.isPlaying,
    isDownloading: mocks.player.value.isDownloading,
    playMode: "normal",
    handlePlayTrack: vi.fn(),
    handleNextTrack: vi.fn(),
    handlePrevTrack: vi.fn(),
    handleTogglePlay: mocks.handleTogglePlay,
    handleTogglePlayMode: vi.fn(),
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
vi.mock("./hooks/useLocateFile", () => ({
  useLocateFile: () => ({ highlightedFileId: null }),
}));
vi.mock("./store/driveStore", () => ({
  useDriveStore: Object.assign(
    () => ({ setIsLoadingTracks: vi.fn(), isLoadingTracks: false }),
    { getState: () => ({ setRootFolders: vi.fn() }) },
  ),
}));

vi.mock("./ui/Sidebar/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./ui/NowPlaying/NowPlayingView", () => ({
  NowPlayingView: () => null,
}));
vi.mock("./ui/NowPlayingOverlay", () => ({ NowPlayingOverlay: () => null }));
vi.mock("./ui/PlayerBar/PlayerBar", () => ({ PlayerBar: () => null }));
vi.mock("./ui/PlayerBar/QueuePanel", () => ({ QueuePanel: () => null }));
vi.mock("./ui/components/MoreMenu/VideoMenu", () => ({
  VideoMenu: () => null,
}));
vi.mock("./ui/layouts/TabContentRouter", () => ({
  TabContentRouter: () => null,
}));
vi.mock("./ui/components/MediaInfoDialog", () => ({
  MediaInfoDialog: () => null,
}));

function bufferedRanges(ranges: Array<[number, number]>): {
  buffered: FakeTimeRanges;
} {
  return {
    buffered: {
      length: ranges.length,
      start: (index) => ranges[index]?.[0] ?? 0,
      end: (index) => ranges[index]?.[1] ?? 0,
    },
  };
}

function statePayloads(): PipStatePayload[] {
  return mocks.emitTo.mock.calls
    .filter((call) => call[0] === "pip" && call[1] === PIP_EVENTS.state)
    .map((call) => call[2] as PipStatePayload);
}

function lastStatePayload(): PipStatePayload {
  const payloads = statePayloads();
  const last = payloads[payloads.length - 1];
  if (last === undefined) throw new Error("expected a published pip-state");
  return last;
}

/**
 * Mount App and drive the ONE public seam that activates PiP (enterPip lives
 * on the player command context). Returns once the first pip-state publish has
 * happened, i.e. `isPipActive` is genuinely true — otherwise the action
 * handler would reject every action as "pip-action-ignored".
 */
async function activatePip(): Promise<void> {
  render(<App />);
  await waitFor(() => {
    expect(mocks.commandContext.value).not.toBeNull();
  });
  const context = mocks.commandContext.value;
  if (context === null) throw new Error("expected player command context");
  // enterPip is fire-and-forget (it awaits IPC); the explicit microtask flush
  // lets its first continuation run, and the waitFor below waits for the rest.
  await act(async () => {
    (context["enterPip"] as () => void)();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(statePayloads().length).toBeGreaterThan(0);
  });
}

describe("publishPipState — buffered + isDownloading (Slice 1/3)", () => {
  beforeEach(() => {
    mocks.emitTo.mockClear();
    mocks.retryCurrentTrack.mockClear();
    mocks.openPip.mockClear();
    mocks.requestOwner.mockClear();
    mocks.listenHandlers.clear();
    mocks.commandContext.value = null;
    mocks.player.value = {
      isDownloading: false,
      // Default = playing, so the pre-existing tests never take enterPip's
      // resume branch (they assert the payload/actions, not playback start).
      isPlaying: true,
      currentTrack: {
        id: "video-1",
        title: "Video",
        artist: "Artist",
        streamUrl: "stream",
        originalName: "movie.mkv",
      },
    };
    mocks.audio.getBufferedImpl = () => bufferedRanges([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("publishes buffered as a PLAIN {start,end}[] copied from the engine TimeRanges", async () => {
    mocks.player.value.isDownloading = true;
    mocks.audio.getBufferedImpl = () =>
      bufferedRanges([
        [5, 12],
        [40, 55],
      ]);

    await activatePip();

    const payload = lastStatePayload();
    expect(Array.isArray(payload.buffered)).toBe(true);
    expect(payload.buffered).toEqual([
      { start: 5, end: 12 },
      { start: 40, end: 55 },
    ]);
    // A TimeRanges object would carry start()/end() closures — the IPC
    // boundary cannot clone those, so the payload must be pure data: an array
    // of objects with only numeric fields.
    const runtime = payload.buffered as unknown as Record<string, unknown>;
    expect(Array.isArray(payload.buffered)).toBe(true);
    expect(runtime["start"]).toBeUndefined();
    expect(runtime["end"]).toBeUndefined();
    for (const entry of payload.buffered) {
      expect(Object.keys(entry).sort()).toEqual(["end", "start"]);
    }
    expect(payload.isDownloading).toBe(true);
    // The pre-existing fields keep their values.
    expect(payload.currentTime).toBe(12.5);
    expect(payload.duration).toBe(120);
    expect(payload.hasTrack).toBe(true);
    expect(payload.isVideo).toBe(true);
  });

  it("keeps publishing with buffered: [] when getBuffered() throws", async () => {
    mocks.audio.getBufferedImpl = () => {
      throw new Error("engine released mid-publish");
    };

    await activatePip();

    const payload = lastStatePayload();
    expect(payload.buffered).toEqual([]);
    expect(payload.currentTime).toBe(12.5);
    expect(payload.hasTrack).toBe(true);
  });

  it("drops ranges that cannot be drawn (end <= start, NaN)", async () => {
    mocks.audio.getBufferedImpl = () =>
      bufferedRanges([
        [10, 10],
        [20, Number.NaN],
        [0, 30],
        [50, 40],
      ]);

    await activatePip();

    expect(lastStatePayload().buffered).toEqual([{ start: 0, end: 30 }]);
  });

  it("mirrors isDownloading=false from the player store", async () => {
    mocks.player.value.isDownloading = false;

    await activatePip();

    expect(lastStatePayload().isDownloading).toBe(false);
  });
});

describe("pip-action retry (Slice 1/3)", () => {
  beforeEach(() => {
    mocks.emitTo.mockClear();
    mocks.retryCurrentTrack.mockClear();
    mocks.listenHandlers.clear();
    mocks.commandContext.value = null;
    mocks.player.value = {
      isDownloading: false,
      // Default = playing, so the pre-existing tests never take enterPip's
      // resume branch (they assert the payload/actions, not playback start).
      isPlaying: true,
      currentTrack: {
        id: "video-1",
        title: "Video",
        artist: "Artist",
        streamUrl: "stream",
        originalName: "movie.mkv",
      },
    };
    mocks.audio.getBufferedImpl = () => bufferedRanges([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("runs the shared retryCurrentTrack and republishes state afterwards", async () => {
    await activatePip();

    const handler = mocks.listenHandlers.get(PIP_EVENTS.action);
    if (handler === undefined) throw new Error("expected a pip-action handler");

    const publishesBefore = statePayloads().length;
    await act(async () => {
      handler({ payload: { action: "retry" } });
      await Promise.resolve();
    });

    expect(mocks.retryCurrentTrack).toHaveBeenCalledTimes(1);
    // retry changes `hasError`, so the handler must NOT sit in the
    // seek/return no-republish branch.
    await waitFor(() => {
      expect(statePayloads().length).toBeGreaterThan(publishesBefore);
    });
  });
});

/**
 * Close is NOT Return. Return brings the user back to the app: it restores and
 * focuses the main window and opens Now Playing, and playback follows them
 * there. Close gives the surface back, PAUSES, and disappears, leaving the main
 * window exactly as the user left it (not shown, not focused, not unminimized,
 * Now Playing not forced open). These tests pin that difference, because "both
 * close the PiP window" makes it very easy to collapse them back into one
 * action later.
 */
describe("pip-action closePip (background close)", () => {
  beforeEach(() => {
    mocks.emitTo.mockClear();
    mocks.retryCurrentTrack.mockClear();
    mocks.openPip.mockClear();
    mocks.requestOwner.mockClear();
    mocks.closePip.mockClear();
    mocks.invoke.mockClear();
    mocks.mainWindow.show.mockClear();
    mocks.mainWindow.unminimize.mockClear();
    mocks.mainWindow.setFocus.mockClear();
    mocks.listenHandlers.clear();
    mocks.commandContext.value = null;
    mocks.audio.pause.mockClear();
    // The real store is used here (only `usePlayer` is mocked), so the Close
    // guard's view of "is it playing" is this flag. Each test starts playing.
    usePlayerStore.setState({ isPlaying: true });
    mocks.player.value = {
      isDownloading: false,
      // Default = playing, so the pre-existing tests never take enterPip's
      // resume branch (they assert the payload/actions, not playback start).
      isPlaying: true,
      currentTrack: {
        id: "video-1",
        title: "Video",
        artist: "Artist",
        streamUrl: "stream",
        originalName: "movie.mkv",
      },
    };
    mocks.audio.getBufferedImpl = () => bufferedRanges([]);
  });

  afterEach(() => {
    cleanup();
    // The real store is global; leaving it playing would leak the Close
    // guard's input into whichever describe runs next.
    usePlayerStore.setState({ isPlaying: false });
  });

  it("retargets the surface to main and closes the window WITHOUT restoring it", async () => {
    await activatePip();
    const handler = mocks.listenHandlers.get(PIP_EVENTS.action);
    if (handler === undefined) throw new Error("expected a pip-action handler");

    await act(async () => {
      handler({ payload: { action: "closePip" } });
      await Promise.resolve();
    });

    expect(mocks.invoke).toHaveBeenCalledWith(
      "video_surface_retarget_to_main_cmd",
    );
    await waitFor(() => {
      expect(mocks.closePip).toHaveBeenCalledTimes(1);
    });
    // The whole point of a separate Close: the main window is left alone.
    expect(mocks.mainWindow.show).not.toHaveBeenCalled();
    expect(mocks.mainWindow.unminimize).not.toHaveBeenCalled();
    expect(mocks.mainWindow.setFocus).not.toHaveBeenCalled();
  });

  it("does not republish pip-state (no republish group, like seek/return)", async () => {
    await activatePip();
    const handler = mocks.listenHandlers.get(PIP_EVENTS.action);
    if (handler === undefined) throw new Error("expected a pip-action handler");

    const publishesBefore = statePayloads().length;
    await act(async () => {
      handler({ payload: { action: "closePip" } });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mocks.closePip).toHaveBeenCalledTimes(1);
    });

    // Give the deferred republish (setTimeout 0) a chance to run before
    // asserting its absence.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(statePayloads().length).toBe(publishesBefore);
  });

  it("is a no-op when PiP is not active", async () => {
    render(<App />);
    await waitFor(() => {
      expect(mocks.commandContext.value).not.toBeNull();
    });
    const handler = mocks.listenHandlers.get(PIP_EVENTS.action);
    if (handler === undefined) throw new Error("expected a pip-action handler");

    await act(async () => {
      handler({ payload: { action: "closePip" } });
      await Promise.resolve();
    });

    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "video_surface_retarget_to_main_cmd",
    );
    expect(mocks.closePip).not.toHaveBeenCalled();
  });

  it("pauses playback when closing a playing video", async () => {
    usePlayerStore.setState({ isPlaying: true });
    await activatePip();
    const handler = mocks.listenHandlers.get(PIP_EVENTS.action);
    if (handler === undefined) throw new Error("expected a pip-action handler");

    await act(async () => {
      handler({ payload: { action: "closePip" } });
      await Promise.resolve();
    });

    // Both halves of "the video will not keep playing": the engine stops, and
    // the store flag the whole app reads agrees. A store-only flip would leave
    // mpv audible with a Play icon everywhere.
    expect(mocks.audio.pause).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    await waitFor(() => {
      expect(mocks.closePip).toHaveBeenCalledTimes(1);
    });
  });

  it("does not issue a pause (nor start playback) when closing a paused video", async () => {
    usePlayerStore.setState({ isPlaying: false });
    mocks.player.value.isPlaying = false;
    await activatePip();
    // enterPip resumes a paused video through `handleTogglePlay`, so clear the
    // entry-side call before asserting on what Close itself does.
    mocks.handleTogglePlay.mockClear();
    mocks.audio.pause.mockClear();
    const handler = mocks.listenHandlers.get(PIP_EVENTS.action);
    if (handler === undefined) throw new Error("expected a pip-action handler");

    await act(async () => {
      handler({ payload: { action: "closePip" } });
      await Promise.resolve();
    });

    // Closing an already-paused video must be a no-op for playback. This is
    // the regression a bare `handleTogglePlay()` would introduce: a toggle
    // would START the video the user just dismissed.
    expect(mocks.audio.pause).not.toHaveBeenCalled();
    expect(mocks.handleTogglePlay).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    await waitFor(() => {
      expect(mocks.closePip).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps playing when the user returns instead of closing", async () => {
    usePlayerStore.setState({ isPlaying: true });
    await activatePip();
    const handler = mocks.listenHandlers.get(PIP_EVENTS.action);
    if (handler === undefined) throw new Error("expected a pip-action handler");

    await act(async () => {
      handler({ payload: { action: "return" } });
      await Promise.resolve();
    });

    // Return is "bring me back to the app", not "stop watching": the picture
    // and the sound follow the user, so no pause may be issued here.
    expect(mocks.audio.pause).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    await waitFor(() => {
      expect(mocks.closePip).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * The native hand-off is not best-effort any more. Both Close and Return used
 * to commit their end state (pause, owner → main, destroy the PiP window) even
 * when the retarget had FAILED, which stranded the surface in a window that no
 * longer existed: the user lost the picture and had nothing left to click.
 *
 * These tests pin the contract of the three resolved outcomes plus a rejection,
 * and — most importantly — that a failed hand-off keeps a recovery surface AND
 * releases the transition guard so the user can simply try again.
 */
describe("PiP surface hand-off outcomes", () => {
  /** What the mock answers for the to-main command. Mutable per attempt. */
  let toMainOutcome: "retargeted" | "rolled_back" | "detached" | Error =
    "retargeted";

  function useHandoffMock(): void {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === RETARGET_TO_MAIN) {
        return toMainOutcome instanceof Error
          ? Promise.reject(toMainOutcome)
          : Promise.resolve<unknown>(toMainOutcome);
      }
      return mocks.defaultInvoke(command);
    });
  }

  beforeEach(() => {
    mocks.emitTo.mockClear();
    mocks.retryCurrentTrack.mockClear();
    mocks.openPip.mockClear();
    mocks.requestOwner.mockClear();
    mocks.closePip.mockClear();
    mocks.mainWindow.show.mockClear();
    mocks.mainWindow.unminimize.mockClear();
    mocks.mainWindow.setFocus.mockClear();
    mocks.audio.pause.mockClear();
    mocks.handleTogglePlay.mockClear();
    mocks.listenHandlers.clear();
    mocks.isPipWindowOpen.mockReset();
    mocks.isPipWindowOpen.mockResolvedValue(true);
    mocks.commandContext.value = null;
    // Module-level mirrors are process-global process state — start each case
    // from the same place enterPip leaves them.
    setVideoHostOwner("main");
    setVideoPresentationStatus("healthy");
    usePlayerStore.setState({ isPlaying: true });
    toMainOutcome = "retargeted";
    mocks.resetInvoke();
    useHandoffMock();
    mocks.player.value = {
      isDownloading: false,
      isPlaying: true,
      currentTrack: fakeVideo(),
    };
    mocks.audio.getBufferedImpl = () => bufferedRanges([]);
  });

  afterEach(() => {
    cleanup();
    usePlayerStore.setState({ isPlaying: false });
  });

  async function fireAction(action: string): Promise<void> {
    const handler = mocks.listenHandlers.get(PIP_EVENTS.action);
    if (handler === undefined) throw new Error("expected a pip-action handler");
    await act(async () => {
      handler({ payload: { action } });
      await Promise.resolve();
    });
  }

  function retargetOrder(): number | undefined {
    const index = mocks.invoke.mock.calls.findIndex(
      (call) => call[0] === RETARGET_TO_MAIN,
    );
    if (index < 0) return undefined;
    return mocks.invoke.mock.invocationCallOrder[index];
  }

  it("A: a successful close retargets BEFORE pausing, then commits main", async () => {
    toMainOutcome = "retargeted";
    await activatePip();

    await fireAction("closePip");
    await waitFor(() => {
      expect(mocks.closePip).toHaveBeenCalledTimes(1);
    });

    const handoffOrder = retargetOrder();
    const pauseOrder = mocks.audio.pause.mock.invocationCallOrder[0];
    if (handoffOrder === undefined || pauseOrder === undefined) {
      throw new Error("expected both the hand-off and the pause to have run");
    }
    // The whole fix in one assertion: nothing is committed, stopped or torn
    // down before the native side confirmed the switch.
    expect(handoffOrder).toBeLessThan(pauseOrder);
    expect(mocks.audio.pause).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(getVideoHostOwner()).toBe("main");
    expect(getVideoPresentationStatus()).toBe("healthy");
    // Close still leaves the main window exactly where the user left it.
    expect(mocks.mainWindow.show).not.toHaveBeenCalled();
    expect(mocks.mainWindow.unminimize).not.toHaveBeenCalled();
    expect(mocks.mainWindow.setFocus).not.toHaveBeenCalled();
  });

  it("B: rolled back keeps the PiP window, playback and a healthy pipeline", async () => {
    toMainOutcome = "rolled_back";
    await activatePip();

    await fireAction("closePip");
    // Give the whole (failed) transaction a chance to run to completion.
    await waitFor(() => {
      expect(mocks.emitTo).toHaveBeenCalledWith("pip", "pip-surface-refresh");
    });

    expect(mocks.audio.pause).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(mocks.closePip).not.toHaveBeenCalled();
    // The native side recreated the previous (PiP) target: still ours.
    expect(getVideoHostOwner()).toBe("pip");
    expect(getVideoPresentationStatus()).toBe("healthy");

    // Guard released: the retry reaches the hand-off again and succeeds.
    toMainOutcome = "retargeted";
    await fireAction("closePip");
    await waitFor(() => {
      expect(mocks.closePip).toHaveBeenCalledTimes(1);
    });
    expect(getVideoHostOwner()).toBe("main");
    expect(mocks.audio.pause).toHaveBeenCalledTimes(1);
  });

  it("C: detached keeps the last confirmed owner and a retry recreates the hand-off", async () => {
    toMainOutcome = "detached";
    await activatePip();

    await fireAction("closePip");
    await waitFor(() => {
      expect(getVideoPresentationStatus()).toBe("detached");
    });

    expect(getVideoHostOwner()).toBe("pip");
    expect(mocks.closePip).not.toHaveBeenCalled();
    expect(mocks.audio.pause).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    toMainOutcome = "retargeted";
    await fireAction("closePip");
    await waitFor(() => {
      expect(mocks.closePip).toHaveBeenCalledTimes(1);
    });
    expect(getVideoHostOwner()).toBe("main");
    expect(getVideoPresentationStatus()).toBe("healthy");
    expect(mocks.audio.pause).toHaveBeenCalledTimes(1);
  });

  it("D: a REJECTED retarget is unresolved, and the next close retries", async () => {
    toMainOutcome = new Error("retarget timed out after 5s");
    await activatePip();

    await fireAction("closePip");
    await waitFor(() => {
      expect(getVideoPresentationStatus()).toBe("unresolved");
    });

    // A rejection says nothing about who owns the surface, so nothing may be
    // declared: no owner change, no teardown, no pause.
    expect(getVideoHostOwner()).toBe("pip");
    expect(mocks.closePip).not.toHaveBeenCalled();
    expect(mocks.audio.pause).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    toMainOutcome = "retargeted";
    await fireAction("closePip");
    await waitFor(() => {
      expect(mocks.closePip).toHaveBeenCalledTimes(1);
    });
    expect(getVideoHostOwner()).toBe("main");
  });

  it("E: a failed return leaves the app in the background and retries cleanly", async () => {
    toMainOutcome = new Error("render thread stopped");
    await activatePip();

    await fireAction("return");
    await waitFor(() => {
      expect(getVideoPresentationStatus()).toBe("unresolved");
    });

    // Bringing forward a window with no picture would be worse than staying.
    expect(mocks.mainWindow.show).not.toHaveBeenCalled();
    expect(mocks.mainWindow.unminimize).not.toHaveBeenCalled();
    expect(mocks.mainWindow.setFocus).not.toHaveBeenCalled();
    expect(mocks.closePip).not.toHaveBeenCalled();
    expect(mocks.audio.pause).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(getVideoHostOwner()).toBe("pip");

    toMainOutcome = "retargeted";
    await fireAction("return");
    await waitFor(() => {
      expect(mocks.closePip).toHaveBeenCalledTimes(1);
    });
    expect(getVideoHostOwner()).toBe("main");
    expect(getVideoPresentationStatus()).toBe("healthy");
    expect(mocks.mainWindow.show).toHaveBeenCalledTimes(1);
    expect(mocks.mainWindow.unminimize).toHaveBeenCalledTimes(1);
    expect(mocks.mainWindow.setFocus).toHaveBeenCalledTimes(1);
    // Return never pauses: the picture follows the user into the app.
    expect(mocks.audio.pause).not.toHaveBeenCalled();
  });

  /**
   * External close (the PiP window vanished: crash, Alt+F4 with a dead main,
   * task manager). The liveness poller runs the recovery, which is the ONE
   * hand-off whose `rolled_back` must NOT be reported as healthy: the native
   * side recreated the PREVIOUS target, and that target is the PiP window that
   * just disappeared — a surface presenting into a destroyed HWND works for
   * nobody, exactly like `detached`. Reporting `healthy` there would claim a
   * picture the user does not have.
   *
   * Driven through the real poller (`PIP_WINDOW_POLL_MS` = 1000ms) rather than
   * a copy of the logic: only `isPipWindowOpen` is flipped to false.
   */
  it("external close: rolled_back reports as unresolved and never pauses", async () => {
    toMainOutcome = "rolled_back";
    await activatePip();

    // The window is GONE from this point on; every poll tick sees it.
    mocks.isPipWindowOpen.mockResolvedValue(false);

    await waitFor(
      () => {
        expect(getVideoPresentationStatus()).toBe("unresolved");
      },
      { timeout: 3_000 },
    );

    // Recovery already runs with the window destroyed: nothing to pause, and
    // nothing to close (the close path is for a window that still exists).
    expect(mocks.closePip).not.toHaveBeenCalled();
    expect(mocks.audio.pause).not.toHaveBeenCalled();
    // The user is brought back to the app so the missing picture is visible
    // there, and the owner is main (the recovery's existing behaviour).
    expect(getVideoHostOwner()).toBe("main");
    expect(mocks.mainWindow.show).toHaveBeenCalled();
  });
});

/**
 * The PiP window keys its aspect re-apply on the media identity, so the
 * publisher has to carry the STABLE id. Title+duration cannot tell two
 * different items apart when they happen to match (same movie, two cuts).
 */
describe("publishPipState — trackId", () => {
  const TRACK_ID_EVENT = PIP_EVENTS.state;

  beforeEach(() => {
    mocks.emitTo.mockClear();
    mocks.retryCurrentTrack.mockClear();
    mocks.openPip.mockClear();
    mocks.requestOwner.mockClear();
    mocks.closePip.mockClear();
    mocks.listenHandlers.clear();
    mocks.commandContext.value = null;
    usePlayerStore.setState({ isPlaying: true });
    mocks.resetInvoke();
    mocks.player.value = {
      isDownloading: false,
      isPlaying: true,
      currentTrack: fakeVideo("video-1"),
    };
    mocks.audio.getBufferedImpl = () => bufferedRanges([]);
  });

  afterEach(() => {
    cleanup();
    usePlayerStore.setState({ isPlaying: false });
  });

  function payloads(): PipStatePayload[] {
    return mocks.emitTo.mock.calls
      .filter((call) => call[0] === "pip" && call[1] === TRACK_ID_EVENT)
      .map((call) => call[2] as PipStatePayload);
  }

  it("forwards the current track id", async () => {
    await activatePip();
    await waitFor(() => {
      expect(lastStatePayload().trackId).toBe("video-1");
    });
  });

  it("carries the NEW id after the current track changes", async () => {
    const view = render(<App />);
    await waitFor(() => {
      expect(mocks.commandContext.value).not.toBeNull();
    });
    const context = mocks.commandContext.value;
    if (context === null) throw new Error("expected player command context");
    await act(async () => {
      (context["enterPip"] as () => void)();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(payloads().length).toBeGreaterThan(0);
    });

    mocks.player.value.currentTrack = fakeVideo("video-2");
    act(() => {
      view.rerender(<App />);
    });

    // The hook republishes because `publishPipState`'s identity changes with
    // `currentTrack`; real timers, so `waitFor` is the right gate.
    await waitFor(() => {
      expect(lastStatePayload().trackId).toBe("video-2");
    });
  });

  it("publishes trackId: null when no track is selected", async () => {
    const view = render(<App />);
    await waitFor(() => {
      expect(mocks.commandContext.value).not.toBeNull();
    });
    const context = mocks.commandContext.value;
    if (context === null) throw new Error("expected player command context");
    await act(async () => {
      (context["enterPip"] as () => void)();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(lastStatePayload().trackId).toBe("video-1");
    });

    mocks.player.value.currentTrack = null;
    // The mock is only an input to `usePlayer`, so the OLD track keeps being
    // published until App actually re-renders with the new value. Firing the
    // listener without this rerender would assert against a stale payload.
    act(() => {
      view.rerender(<App />);
    });

    await waitFor(() => {
      const nullPayload = payloads().find((entry) => entry.trackId === null);
      expect(nullPayload).toBeDefined();
      expect(nullPayload?.hasTrack).toBe(false);
    });
  });
});

describe("Ctrl+P togglePip (player command context)", () => {
  beforeEach(() => {
    mocks.emitTo.mockClear();
    mocks.openPip.mockClear();
    mocks.requestOwner.mockClear();
    mocks.closePip.mockClear();
    mocks.invoke.mockClear();
    mocks.listenHandlers.clear();
    mocks.commandContext.value = null;
    mocks.player.value = {
      isDownloading: false,
      // Default = playing, so the pre-existing tests never take enterPip's
      // resume branch (they assert the payload/actions, not playback start).
      isPlaying: true,
      currentTrack: {
        id: "video-1",
        title: "Video",
        artist: "Artist",
        streamUrl: "stream",
        originalName: "movie.mkv",
      },
    };
    mocks.audio.getBufferedImpl = () => bufferedRanges([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens PiP when not active", async () => {
    render(<App />);
    await waitFor(() => {
      expect(mocks.commandContext.value).not.toBeNull();
    });
    const context = mocks.commandContext.value;
    if (context === null) throw new Error("expected player command context");
    expect(typeof context["togglePip"]).toBe("function");

    await act(async () => {
      (context["togglePip"] as () => void)();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.openPip).toHaveBeenCalledTimes(1);
    });
    expect(mocks.closePip).not.toHaveBeenCalled();
  });

  it("returns from PiP when already active (guarded by isPipActiveRef)", async () => {
    await activatePip();
    const context = mocks.commandContext.value;
    if (context === null) throw new Error("expected player command context");

    await act(async () => {
      (context["togglePip"] as () => void)();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.closePip).toHaveBeenCalledTimes(1);
    });
    // The same chord must not open a second PiP window.
    expect(mocks.openPip).toHaveBeenCalledTimes(1);
  });
});

describe("enterPip spawns the engine before retargeting", () => {
  /**
   * Helper: the invocation order for one Tauri command, or `undefined` when it
   * was never invoked. Ordering across awaits can only be asserted on
   * `invocationCallOrder` (a monotonic global counter), not on call indices.
   */
  function orderOf(command: string): number | undefined {
    const index = mocks.invoke.mock.calls.findIndex(
      (call) => call[0] === command,
    );
    if (index < 0) return undefined;
    return mocks.invoke.mock.invocationCallOrder[index];
  }

  beforeEach(() => {
    mocks.emitTo.mockClear();
    mocks.openPip.mockClear();
    mocks.requestOwner.mockClear();
    mocks.closePip.mockClear();
    // mockReset (not mockClear) so a per-test mockImplementation — including a
    // rejecting one — can never leak into the next test; the reset restores the
    // shared default, which resolves the hand-offs to `"retargeted"`.
    mocks.resetInvoke();
    mocks.listenHandlers.clear();
    mocks.commandContext.value = null;
    mocks.handleTogglePlay.mockClear();
    mocks.player.value = {
      isDownloading: false,
      isPlaying: true,
      currentTrack: {
        id: "video-1",
        title: "Video",
        artist: "Artist",
        streamUrl: "stream",
        originalName: "movie.mkv",
      },
    };
    mocks.audio.getBufferedImpl = () => bufferedRanges([]);
  });

  afterEach(() => {
    cleanup();
  });

  async function callEnterPip(): Promise<void> {
    render(<App />);
    await waitFor(() => {
      expect(mocks.commandContext.value).not.toBeNull();
    });
    const context = mocks.commandContext.value;
    if (context === null) throw new Error("expected player command context");
    await act(async () => {
      (context["enterPip"] as () => void)();
      await Promise.resolve();
    });
  }

  it("calls mpv_spawn before the retarget (the surface must exist first)", async () => {
    // A fresh session has no engine, so ACTIVE_SURFACE is empty and
    // video_surface_retarget fails with "no active render surface to retarget".
    // Spawning first is what makes entering PiP work without ever playing.
    await callEnterPip();

    const spawnOrder = orderOf("mpv_spawn");
    const retargetOrder = orderOf(RETARGET_TO_PIP);
    if (spawnOrder === undefined) {
      throw new Error(
        "expected enterPip to spawn the engine before retargeting",
      );
    }
    expect(retargetOrder).toBeDefined();
    expect(spawnOrder).toBeLessThan(retargetOrder as number);
  });

  it("does not spawn before the PiP window is ready", async () => {
    await callEnterPip();

    const spawnOrder = orderOf("mpv_spawn");
    const openOrder = mocks.openPip.mock.invocationCallOrder[0];
    if (spawnOrder === undefined || openOrder === undefined) {
      throw new Error("expected both the open and the spawn to have run");
    }
    // Spawning is an engine boot, so it must not start before there is a
    // window to hand the surface to — the order is open, spawn, retarget.
    expect(spawnOrder).toBeGreaterThan(openOrder);
  });

  it("still completes when mpv_spawn rejects (spawn failure is not fatal)", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "mpv_spawn") {
        return Promise.reject(new Error("engine boot refused"));
      }
      return mocks.defaultInvoke(command);
    });

    // Must not throw out of enterPip.
    await callEnterPip();

    // The hand-off continues: the retarget still runs and no rollback close is
    // attempted, so the user keeps the window rather than losing both.
    await waitFor(() => {
      expect(mocks.openPip).toHaveBeenCalledTimes(1);
    });
    expect(orderOf(RETARGET_TO_PIP)).toBeDefined();
    expect(mocks.closePip).not.toHaveBeenCalled();
  });
});

/**
 * PiP is a video PRESENTATION, so entering it paused would hand over a surface
 * with no frames — the black/looks-broken window users reported on a fresh
 * app. `enterPip` therefore resumes through the same `handleTogglePlay` the
 * Play button uses (full intent/queue bookkeeping, not a raw engine call).
 *
 * WHEN it resumes matters as much as WHETHER: the resume must land only after
 * the window is open, the surface retargeted and ownership acknowledged.
 * Playing any earlier paints the first frames into the MAIN window and then
 * moves them to PiP — visible as a jump. The direction is decided by
 * `isPlaying`; when already playing nothing extra may fire, otherwise every
 * PiP entry would restart the download/intent lane.
 */
describe("enterPip resumes a paused video before handing over", () => {
  beforeEach(() => {
    mocks.emitTo.mockClear();
    mocks.openPip.mockClear();
    mocks.requestOwner.mockClear();
    mocks.closePip.mockClear();
    mocks.invoke.mockClear();
    mocks.listenHandlers.clear();
    mocks.commandContext.value = null;
    mocks.handleTogglePlay.mockClear();
    mocks.player.value = {
      isDownloading: false,
      isPlaying: true,
      currentTrack: {
        id: "video-1",
        title: "Video",
        artist: "Artist",
        streamUrl: "stream",
        originalName: "movie.mkv",
      },
    };
    mocks.audio.getBufferedImpl = () => bufferedRanges([]);
  });

  afterEach(() => {
    cleanup();
  });

  async function callEnterPip(): Promise<void> {
    render(<App />);
    await waitFor(() => {
      expect(mocks.commandContext.value).not.toBeNull();
    });
    const context = mocks.commandContext.value;
    if (context === null) throw new Error("expected player command context");
    await act(async () => {
      (context["enterPip"] as () => void)();
      await Promise.resolve();
    });
  }

  it("starts playback when the video was never started or is paused", async () => {
    mocks.player.value.isPlaying = false;

    await callEnterPip();

    expect(mocks.handleTogglePlay).toHaveBeenCalledTimes(1);
    // The resume must not stop the hand-off: PiP still opens.
    await waitFor(() => {
      expect(mocks.openPip).toHaveBeenCalledTimes(1);
    });
  });

  it("resumes only AFTER the floating window is fully up", async () => {
    mocks.player.value.isPlaying = false;

    await callEnterPip();
    await waitFor(() => {
      expect(mocks.handleTogglePlay).toHaveBeenCalledTimes(1);
    });

    // The ORDER is the whole point of the fix: starting playback before the
    // retarget paints the first frames in the MAIN window and then rips them
    // across to PiP, which the user sees as a jump/flicker. Ordering is
    // asserted on invocationCallOrder (a monotonic global counter) because the
    // calls themselves are spread across awaits.
    const playOrder = mocks.handleTogglePlay.mock.invocationCallOrder[0];
    const openOrder = mocks.openPip.mock.invocationCallOrder[0];
    // requestPipOwner is retried at most once; the LAST call is the one that
    // had to succeed before the window counts as up.
    const ownerOrders = mocks.requestOwner.mock.invocationCallOrder;
    const ownerOrder = ownerOrders[ownerOrders.length - 1];
    if (
      playOrder === undefined ||
      openOrder === undefined ||
      ownerOrder === undefined
    ) {
      throw new Error("expected all three PiP entry steps to have run");
    }

    expect(playOrder).toBeGreaterThan(openOrder);
    expect(playOrder).toBeGreaterThan(ownerOrder);
  });

  it("does not resume when entering PiP failed (no window to play into)", async () => {
    mocks.player.value.isPlaying = false;
    mocks.openPip.mockRejectedValueOnce(new Error("pip window refused"));

    await callEnterPip();

    // The resume lives after the window is up, so a failed open must leave
    // playback untouched — the user stays exactly where they were.
    expect(mocks.handleTogglePlay).not.toHaveBeenCalled();
  });

  it("does not touch playback when the video is already playing", async () => {
    mocks.player.value.isPlaying = true;

    await callEnterPip();

    expect(mocks.handleTogglePlay).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mocks.openPip).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * The PiP volume rail is a SECOND view of the one engine value. PlayerBar and
 * NowPlaying own local volume state and only re-read it on a `volume-changed`
 * announcement from the player-ui bus, so a PiP-driven write that stays silent
 * leaves those sliders showing the old level (visible drift, and a wrong icon).
 * Keyboard chords already announce; these tests pin that the PiP path does too,
 * and that the announcement carries the state that actually LANDED (the
 * setVolume branch may auto-unmute first) rather than the raw payload.
 */
describe("pip-action volume announcements", () => {
  beforeEach(() => {
    mocks.emitTo.mockClear();
    mocks.emitPlayerUi.mockClear();
    mocks.audio.setVolume.mockClear();
    mocks.audio.toggleMute.mockClear();
    // Each test starts from the engine defaults ("half volume, unmuted") so a
    // mute left behind by the previous test cannot change what is asserted.
    mocks.audio.engine.volume = 0.5;
    mocks.audio.engine.muted = false;
    mocks.listenHandlers.clear();
    mocks.commandContext.value = null;
    mocks.player.value = {
      isDownloading: false,
      isPlaying: true,
      currentTrack: {
        id: "video-1",
        title: "Video",
        artist: "Artist",
        streamUrl: "stream",
        originalName: "movie.mkv",
      },
    };
    mocks.audio.getBufferedImpl = () => bufferedRanges([]);
  });

  afterEach(() => {
    cleanup();
  });

  async function sendAction(payload: Record<string, unknown>): Promise<void> {
    await activatePip();
    const handler = mocks.listenHandlers.get(PIP_EVENTS.action);
    if (handler === undefined) throw new Error("expected a pip-action handler");
    await act(async () => {
      handler({ payload });
      await Promise.resolve();
    });
  }

  it("announces the volume a PiP setVolume wrote, so the main sliders follow", async () => {
    await sendAction({ action: "setVolume", payload: 0.42 });

    expect(mocks.audio.setVolume).toHaveBeenCalledWith(0.42);
    // 0.42 read back from the (clamped) engine, not the raw payload.
    expect(mocks.emitPlayerUi).toHaveBeenCalledWith("volume-changed", {
      volume: 0.42,
      muted: false,
    });
  });

  it("announces the engine's landed mute state after a PiP toggleMute", async () => {
    await sendAction({ action: "toggleMute" });

    // The fake engine flips and returns the flag, so the landed state is known:
    // unmuted -> muted.
    expect(mocks.audio.toggleMute).toHaveBeenCalledTimes(1);
    expect(mocks.audio.engine.muted).toBe(true);
    expect(mocks.emitPlayerUi).toHaveBeenCalledWith("volume-changed", {
      volume: 0.5,
      muted: true,
    });
  });

  it("announces muted:false when setVolume auto-unmutes a muted engine", async () => {
    mocks.audio.engine.muted = true;

    await sendAction({ action: "setVolume", payload: 0.5 });

    // A non-zero level while muted unmutes first: the payload was 0.5 and the
    // mute flag flips inside this same branch, which is why the announcement
    // must re-read the engine instead of trusting the request.
    expect(mocks.audio.toggleMute).toHaveBeenCalledTimes(1);
    expect(mocks.emitPlayerUi).toHaveBeenCalledWith("volume-changed", {
      volume: 0.5,
      muted: false,
    });
  });
});
