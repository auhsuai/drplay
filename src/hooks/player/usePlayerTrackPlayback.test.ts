// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { usePlayerTrackPlayback } from "./usePlayerTrackPlayback";
import { PLAYER_STOP_EVENT } from "./usePlayerLifecycle";
import { usePlayerStore } from "../../store/playerStore";
import { getValidToken } from "../../utils/apiClient";
import { recordPlay } from "../../utils/history";
import { showErrorToast } from "../../utils/simpleToast";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("../../db/kv", () => ({
  set: vi.fn(() => Promise.resolve()),
}));

vi.mock("tauri-plugin-keepawake-api", () => ({
  start: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../utils/history", () => ({
  recordPlay: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../utils/metadata", () => ({
  getTrackMetadata: vi.fn(() => Promise.resolve({ duration: 200 })),
  metadataCache: new Map(),
}));

vi.mock("../../utils/apiClient", () => ({
  getValidToken: vi.fn(() => Promise.resolve("test-token")),
}));

vi.mock("../../utils/streamPrefetcher", () => ({
  getPrefetchedStreamUrl: vi.fn(() => undefined),
  buildStreamUrl: vi.fn((id: string) => `/drive-stream/${id}`),
}));

vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));

vi.mock("../../utils/swPrefetch", () => ({
  prefetchTrackInServiceWorker: vi.fn(),
}));

vi.mock("../../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

vi.mock("../../lib/AudioController", () => ({
  AudioController: {
    getInstance: () => ({ on: vi.fn(() => () => {}) }),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeTrack(id: string): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    streamUrl: `https://stream.example/${id}`,
  };
}

function renderPlayback() {
  const updateQueueContext = vi.fn((track: Track) => track);
  const utils = renderHook(() =>
    usePlayerTrackPlayback("test-token", { updateQueueContext }),
  );
  return { ...utils, updateQueueContext };
}

// Starts handlePlayTrack and lets it reach the `await getValidToken` point.
// NOT async: returning the pending promise from an async helper would await it.
function beginPlay(
  result: { current: ReturnType<typeof usePlayerTrackPlayback> },
  track: Track,
): Promise<void> | undefined {
  let playPromise: Promise<void> | undefined;
  act(() => {
    playPromise = result.current.handlePlayTrack(track);
  });
  return playPromise;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getValidToken).mockResolvedValue("test-token");
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
  vi.restoreAllMocks();
});

describe("usePlayerTrackPlayback — aborted attempts must not commit", () => {
  it("UTP-1: abort during getValidToken -> no setCurrentTrack/recordPlay on the stale attempt", async () => {
    const token = deferred<string | null>();
    vi.mocked(getValidToken).mockReturnValue(token.promise);
    const { result } = renderPlayback();

    const playPromise = beginPlay(result, makeTrack("t1"));
    expect(usePlayerStore.getState().isDownloading).toBe(true);

    // A newer click supersedes this attempt (same controller swap the hook does).
    act(() => {
      result.current.createAbortSignal();
    });

    await act(async () => {
      token.resolve("fresh-token");
      await playPromise;
    });

    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(recordPlay).not.toHaveBeenCalled();
  });

  it("UTP-2a: unmount during getValidToken clears the stuck isDownloading spinner", async () => {
    const token = deferred<string | null>();
    vi.mocked(getValidToken).mockReturnValue(token.promise);
    const { result, unmount } = renderPlayback();

    const playPromise = beginPlay(result, makeTrack("t1"));
    expect(usePlayerStore.getState().isDownloading).toBe(true);

    unmount();

    expect(usePlayerStore.getState().isDownloading).toBe(false);

    await act(async () => {
      token.resolve("fresh-token");
      await playPromise;
    });
    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(recordPlay).not.toHaveBeenCalled();
  });

  it("UTP-2b: PLAYER_STOP_EVENT aborts the in-flight attempt (no commit/history after stop)", async () => {
    const token = deferred<string | null>();
    vi.mocked(getValidToken).mockReturnValue(token.promise);
    const { result } = renderPlayback();

    const playPromise = beginPlay(result, makeTrack("t1"));

    act(() => {
      window.dispatchEvent(new Event(PLAYER_STOP_EVENT));
    });

    await act(async () => {
      token.resolve("fresh-token");
      await playPromise;
    });

    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(recordPlay).not.toHaveBeenCalled();
  });
});

describe("usePlayerTrackPlayback — token refresh failure feedback", () => {
  it("UTP-3: getValidToken returns null -> shows player.playback_failed toast + clears spinner", async () => {
    vi.mocked(getValidToken).mockResolvedValue(null);
    const { result } = renderPlayback();

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t1"));
    });

    expect(showErrorToast).toHaveBeenCalledWith("player.playback_failed");
    expect(usePlayerStore.getState().isDownloading).toBe(false);
    expect(usePlayerStore.getState().currentTrack).toBeNull();
  });
});
