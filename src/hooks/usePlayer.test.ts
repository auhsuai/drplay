// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayer, PLAYER_STOP_EVENT } from "./usePlayer";
import { usePlayerStore } from "../store/playerStore";
import type { Track } from "../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("../db/kv", () => ({
  set: vi.fn(() => Promise.resolve()),
}));

vi.mock("tauri-plugin-keepawake-api", () => ({
  start: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
}));

vi.mock("../utils/history", () => ({
  recordPlay: vi.fn(() => Promise.resolve()),
}));

vi.mock("../utils/metadata", () => ({
  getTrackMetadata: vi.fn(() => Promise.resolve({ duration: 200 })),
}));

vi.mock("../utils/apiClient", () => ({
  getValidToken: vi.fn(() => Promise.resolve("test-token")),
}));

vi.mock("../utils/streamPrefetcher", () => ({
  getPrefetchedStreamUrl: vi.fn(() => undefined),
  DRIVE_STREAM_PREFIX: "/drive-stream/",
}));

vi.mock("../utils/nextTrackPrefetcher", () => ({
  prefetchNextTrackAudio: vi.fn(),
}));

vi.mock("../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

vi.mock("../utils/sessionCleanup", () => ({
  SESSION_CLEANUP_KEYS: {
    playModeKv: "drplay_playmode",
    queueKv: "drplay_queue",
    lastSessionLocalStorage: "drplay_last_session",
    lastSessionKv: "drplay_last_session_kv",
  },
}));

const queueMock = vi.hoisted(() => ({
  handleNextTrack: vi.fn(),
  handlePrevTrack: vi.fn(),
  handleTogglePlayMode: vi.fn(),
  updateQueueContext: vi.fn((track: Track) => track),
}));

vi.mock("./player/usePlayerQueue", () => ({
  usePlayerQueue: () => queueMock,
}));

vi.mock("./player/usePlayerSession", () => ({
  usePlayerSession: vi.fn(),
}));

const audioMock = vi.hoisted(() => ({
  getCurrentTime: vi.fn(() => 0),
  getDuration: vi.fn(() => 0),
  seek: vi.fn(),
  pause: vi.fn(),
  togglePlay: vi.fn(),
  on: vi.fn(() => vi.fn()),
  release: vi.fn(),
}));

vi.mock("../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
}));

// jsdom does not implement the Media Session API — tests install their own.
class MediaMetadataMock implements MediaMetadata {
  title = "";
  artist = "";
  album = "";
  artwork: MediaImage[] = [];
  constructor(init?: MediaMetadataInit) {
    this.title = init?.title ?? "";
    this.artist = init?.artist ?? "";
    this.album = init?.album ?? "";
    this.artwork = init?.artwork ?? [];
  }
}

type ActionHandler = (details?: {
  seekTime?: number;
  seekOffset?: number;
}) => void;

const MEDIA_ACTIONS = [
  "play",
  "pause",
  "nexttrack",
  "previoustrack",
  "seekto",
  "seekbackward",
  "seekforward",
] as const;

function installSessionMock() {
  const handlers = new Map<string, ActionHandler | null>();
  const session = {
    metadata: null as MediaMetadata | null,
    playbackState: "none" as MediaSessionPlaybackState,
    setActionHandler: vi.fn((action: string, handler: ActionHandler | null) => {
      handlers.set(action, handler);
    }),
    setPositionState: vi.fn(),
  };
  Object.defineProperty(navigator, "mediaSession", {
    value: session,
    configurable: true,
    writable: true,
  });
  return {
    session,
    invoke: (
      action: string,
      details?: { seekTime?: number; seekOffset?: number },
    ) => {
      const handler = handlers.get(action);
      if (handler) handler(details);
    },
  };
}

function makeTrack(id: string): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    streamUrl: `https://stream.example/${id}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePlayerStore.setState({
    currentTrack: null,
    loadNonce: 0,
    isPlaying: false,
    isDownloading: false,
    playMode: "normal",
    originalQueue: [],
    playbackQueue: [],
  });
  audioMock.getCurrentTime.mockReturnValue(0);
  audioMock.getDuration.mockReturnValue(0);
  (globalThis as { MediaMetadata?: unknown }).MediaMetadata = MediaMetadataMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePlayer media session integration (Task A mount)", () => {
  it("mount → handlers đăng ký đủ 7 action + metadata theo currentTrack + playbackState theo isPlaying", () => {
    const { session } = installSessionMock();
    usePlayerStore.setState({
      currentTrack: makeTrack("t1"),
      isPlaying: false,
    });

    renderHook(() => usePlayer("test-token"));

    expect(session.metadata?.title).toBe("Title t1");
    expect(session.metadata?.artist).toBe("Artist t1");
    expect(session.playbackState).toBe("paused");
    for (const action of MEDIA_ACTIONS) {
      expect(session.setActionHandler).toHaveBeenCalledWith(
        action,
        expect.any(Function),
      );
    }
  });

  it("track đổi qua store → metadata + playbackState cập nhật (không cần remount)", () => {
    const { session } = installSessionMock();
    renderHook(() => usePlayer("test-token"));

    act(() => {
      usePlayerStore.setState({
        currentTrack: makeTrack("t1"),
        isPlaying: true,
      });
    });
    expect(session.metadata?.title).toBe("Title t1");
    expect(session.playbackState).toBe("playing");

    act(() => {
      usePlayerStore.setState({
        currentTrack: makeTrack("t2"),
        isPlaying: false,
      });
    });
    expect(session.metadata?.title).toBe("Title t2");
    expect(session.playbackState).toBe("paused");
  });

  it("nexttrack media action → gọi handleNextTrack của usePlayerQueue", () => {
    const { invoke } = installSessionMock();
    renderHook(() => usePlayer("test-token"));

    act(() => {
      invoke("nexttrack");
    });
    expect(queueMock.handleNextTrack).toHaveBeenCalledTimes(1);

    act(() => {
      invoke("previoustrack");
    });
    expect(queueMock.handlePrevTrack).toHaveBeenCalledTimes(1);
  });

  it("play media action khi paused (track có streamUrl) → resume qua handleTogglePlay → store isPlaying true", () => {
    const { session, invoke } = installSessionMock();
    usePlayerStore.setState({
      currentTrack: makeTrack("t1"),
      isPlaying: false,
    });

    renderHook(() => usePlayer("test-token"));
    expect(session.playbackState).toBe("paused");

    act(() => {
      invoke("play");
    });
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(session.playbackState).toBe("playing");
  });

  it("seekto media action → audio.seek + setPositionState", () => {
    const { session, invoke } = installSessionMock();
    usePlayerStore.setState({
      currentTrack: makeTrack("t1"),
      isPlaying: true,
    });
    audioMock.getCurrentTime.mockReturnValue(10);
    audioMock.getDuration.mockReturnValue(240);
    renderHook(() => usePlayer("test-token"));

    act(() => {
      invoke("seekto", { seekTime: 100 });
    });
    expect(audioMock.seek).toHaveBeenCalledWith(100);
    expect(session.setPositionState).toHaveBeenCalledWith({
      duration: 240,
      position: 10,
      playbackRate: 1,
    });
  });

  it("unmount usePlayer → cleanup media session (handlers null + metadata null)", () => {
    const { session } = installSessionMock();
    usePlayerStore.setState({ currentTrack: makeTrack("t1") });
    const { unmount } = renderHook(() => usePlayer("test-token"));

    unmount();

    for (const action of MEDIA_ACTIONS) {
      expect(session.setActionHandler).toHaveBeenCalledWith(action, null);
    }
    expect(session.metadata).toBeNull();
  });

  it("return shape: expose đủ API player cho UI (smoke)", () => {
    installSessionMock();
    const { result } = renderHook(() => usePlayer("test-token"));

    expect(typeof result.current.handlePlayTrack).toBe("function");
    expect(typeof result.current.handleNextTrack).toBe("function");
    expect(typeof result.current.handlePrevTrack).toBe("function");
    expect(typeof result.current.handleTogglePlay).toBe("function");
    expect(typeof result.current.handleTogglePlayMode).toBe("function");
    expect(typeof result.current.setIsPlaying).toBe("function");
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.currentTrack).toBeNull();
  });
});

describe("usePlayer broken-track reset on logout (Task D residual)", () => {
  it("PLAYER_STOP_EVENT → brokenTrackIds reset về [] (không sót sang session sau)", () => {
    installSessionMock();
    renderHook(() => usePlayer("test-token"));

    act(() => {
      usePlayerStore.getState().markTrackBroken("broken-1");
      usePlayerStore.getState().markTrackBroken("broken-2");
    });
    expect(usePlayerStore.getState().brokenTrackIds).toEqual([
      "broken-1",
      "broken-2",
    ]);

    act(() => {
      window.dispatchEvent(new CustomEvent(PLAYER_STOP_EVENT));
    });
    expect(usePlayerStore.getState().brokenTrackIds).toEqual([]);
    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(usePlayerStore.getState().originalQueue).toEqual([]);
    expect(usePlayerStore.getState().playbackQueue).toEqual([]);
  });
});
