// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayer, PLAYER_STOP_EVENT } from "./usePlayer";
import { usePlayerStore } from "../store/playerStore";
import type { Track } from "../types";

const platformMock = vi.hoisted(() => ({ IS_MOBILE: true }));
vi.mock("../utils/platform", () => ({ IS_MOBILE: platformMock.IS_MOBILE }));

const engineMock = vi.hoisted(() => ({
  setToken: vi.fn(),
  playTrack: vi.fn(() => Promise.resolve()),
  pause: vi.fn(() => Promise.resolve()),
  seek: vi.fn(() => Promise.resolve()),
  release: vi.fn(() => Promise.resolve()),
  initOnce: vi.fn(() => Promise.resolve()),
  on: vi.fn(() => vi.fn()),
  getCurrentTime: vi.fn(() => 0),
  getDuration: vi.fn(() => 0),
  getBuffered: vi.fn(() => ({ length: 0 })),
  getState: vi.fn(() => null),
  setVolume: vi.fn(),
  toggleMute: vi.fn(() => false),
  getVolume: vi.fn(() => 1),
  isMuted: vi.fn(() => false),
  togglePlay: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/nativeAudioBridge", () => ({
  nativeAudioEngine: engineMock,
  getPlaybackEngine: () => engineMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("../db/kv", () => ({
  set: vi.fn(() => Promise.resolve()),
}));

const keepAwakeMock = vi.hoisted(() => ({
  start: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
}));
vi.mock("tauri-plugin-keepawake-api", () => keepAwakeMock);

vi.mock("../utils/history", () => ({
  recordPlay: vi.fn(() => Promise.resolve()),
}));

const metadataMock = vi.hoisted(() => ({
  getTrackMetadata: vi.fn(() => Promise.resolve({ duration: 200 })),
}));
vi.mock("../utils/metadata", () => metadataMock);

const getValidTokenMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve("test-token")),
);
vi.mock("../utils/apiClient", () => ({
  getValidToken: getValidTokenMock,
}));

const buildStreamUrlMock = vi.hoisted(() =>
  vi.fn((id: string) => `/drive-stream/${id}`),
);
vi.mock("../utils/streamPrefetcher", () => ({
  getPrefetchedStreamUrl: vi.fn(() => undefined),
  DRIVE_STREAM_PREFIX: "/drive-stream/",
  buildStreamUrl: buildStreamUrlMock,
}));

const prefetchNextTrackAudioMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/nextTrackPrefetcher", () => ({
  prefetchNextTrackAudio: prefetchNextTrackAudioMock,
}));

vi.mock("../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

vi.mock(
  "../utils/sessionCleanup",
  async (importOriginal) =>
    await importOriginal<typeof import("../utils/sessionCleanup")>().then(
      (actual) => ({
        SESSION_CLEANUP_KEYS: { ...actual.SESSION_CLEANUP_KEYS },
      }),
    ),
);

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

function installSessionMock() {
  Object.defineProperty(navigator, "mediaSession", {
    value: {
      metadata: null as MediaMetadata | null,
      playbackState: "none" as MediaSessionPlaybackState,
      setActionHandler: vi.fn(),
      setPositionState: vi.fn(),
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "MediaMetadata", {
    value: MediaMetadataMock,
    configurable: true,
    writable: true,
  });
}

function makeTrack(id: string): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    streamUrl: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installSessionMock();
  platformMock.IS_MOBILE = true;
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

afterEach(() => {
  platformMock.IS_MOBILE = true;
  // No vitest globals in this project — @testing-library auto-cleanup never
  // registers; leaked mounts keep their event subscriptions (PLAYER_STOP
  // listeners would fire N times in later tests).
  cleanup();
});

describe("usePlayer mobile branch (GATE B — native audio is the playback path)", () => {
  it("handlePlayTrack: sets the engine token, never builds a /drive-stream URL", async () => {
    const { result } = renderHook(() => usePlayer("access-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("file-1"));
    });

    expect(engineMock.setToken).toHaveBeenCalledWith("test-token");
    expect(buildStreamUrlMock).not.toHaveBeenCalled();
    const { currentTrack } = usePlayerStore.getState();
    expect(currentTrack?.id).toBe("file-1");
    expect(currentTrack?.streamUrl).toBe("");
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(usePlayerStore.getState().isDownloading).toBe(false);
  });

  it("handlePlayTrack: does not prefetch the next track or fetch metadata on mobile", async () => {
    const { result } = renderHook(() => usePlayer("access-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("file-1"), [
        makeTrack("file-1"),
        makeTrack("file-2"),
      ]);
    });

    expect(prefetchNextTrackAudioMock).not.toHaveBeenCalled();
    expect(metadataMock.getTrackMetadata).not.toHaveBeenCalled();
  });

  it("handleTogglePlay: paused with no streamUrl -> token + reload without /drive-stream URL", async () => {
    usePlayerStore.setState({
      currentTrack: makeTrack("file-1"),
      isPlaying: false,
    });

    const { result } = renderHook(() => usePlayer("access-token"));

    await act(async () => {
      await result.current.handleTogglePlay();
    });

    expect(engineMock.setToken).toHaveBeenCalledWith("test-token");
    expect(buildStreamUrlMock).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("handleTogglePlay: playing -> flips the store flag only (PlayerBar effect drives engine.pause)", async () => {
    usePlayerStore.setState({
      currentTrack: makeTrack("file-1"),
      isPlaying: true,
    });

    const { result } = renderHook(() => usePlayer("access-token"));

    await act(async () => {
      await result.current.handleTogglePlay();
    });

    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(engineMock.pause).not.toHaveBeenCalled();
  });

  it("PLAYER_STOP_EVENT: releases the native engine instead of AudioController", async () => {
    const { result } = renderHook(() => usePlayer("access-token"));
    expect(result.current).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new CustomEvent(PLAYER_STOP_EVENT));
      await Promise.resolve();
    });

    expect(engineMock.release).toHaveBeenCalledTimes(1);
    expect(audioMock.release).not.toHaveBeenCalled();
  });

  it("never calls keepawake start/stop on mobile (plugin ACL-gated out of Android)", async () => {
    usePlayerStore.setState({ isPlaying: true });
    const { rerender } = renderHook(() => usePlayer("access-token"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(keepAwakeMock.start).not.toHaveBeenCalled();
    expect(keepAwakeMock.stop).not.toHaveBeenCalled();

    usePlayerStore.setState({ isPlaying: false });
    await act(async () => {
      rerender();
      await Promise.resolve();
    });
    expect(keepAwakeMock.start).not.toHaveBeenCalled();
    expect(keepAwakeMock.stop).not.toHaveBeenCalled();
  });
});

describe("usePlayer stale-continuation guards (audit B1/B2)", () => {
  it("handlePlayTrack: stale token continuation must not overwrite a newer selection", async () => {
    const { result } = renderHook(() => usePlayer("access-token"));

    let releaseStaleToken!: (value: string) => void;
    getValidTokenMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseStaleToken = resolve;
        }),
    );

    let stalePlay: Promise<void> | undefined;
    act(() => {
      stalePlay = result.current.handlePlayTrack(makeTrack("file-A"));
    });

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("file-B"));
    });

    releaseStaleToken("stale-token");
    await act(async () => {
      await stalePlay;
    });

    expect(usePlayerStore.getState().currentTrack?.id).toBe("file-B");
    expect(engineMock.setToken).toHaveBeenLastCalledWith("test-token");
  });

  it("handleTogglePlay mobile-resume: aborted resume must not resurrect isPlaying after PLAYER_STOP_EVENT", async () => {
    usePlayerStore.setState({
      currentTrack: makeTrack("file-1"),
      isPlaying: false,
    });
    const { result } = renderHook(() => usePlayer("access-token"));

    let releaseResumeToken!: (value: string) => void;
    getValidTokenMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseResumeToken = resolve;
        }),
    );

    let resumePlay: Promise<void> | undefined;
    act(() => {
      resumePlay = result.current.handleTogglePlay();
    });

    await act(async () => {
      window.dispatchEvent(new CustomEvent(PLAYER_STOP_EVENT));
      await Promise.resolve();
    });
    expect(usePlayerStore.getState().isPlaying).toBe(false);

    releaseResumeToken("late-resume-token");
    await act(async () => {
      await resumePlay;
    });

    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(engineMock.setToken).not.toHaveBeenCalledWith("late-resume-token");
  });

  it("PLAYER_STOP_EVENT during pending token fetch aborts the in-flight playback (no ghost playback)", async () => {
    const { result } = renderHook(() => usePlayer("access-token"));

    let releaseGhostToken!: (value: string) => void;
    getValidTokenMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseGhostToken = resolve;
        }),
    );

    let ghostPlay: Promise<void> | undefined;
    act(() => {
      ghostPlay = result.current.handlePlayTrack(makeTrack("file-ghost"));
    });

    await act(async () => {
      window.dispatchEvent(new CustomEvent(PLAYER_STOP_EVENT));
      await Promise.resolve();
    });

    releaseGhostToken("ghost-token");
    await act(async () => {
      await ghostPlay;
    });

    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(engineMock.setToken).not.toHaveBeenCalledWith("ghost-token");
  });
});
