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
import { stopPlaybackIfTrack } from "../../utils/stopPlayback";
import {
  __resetPlaybackIntentForTests,
  beginIntent,
  hasActiveUserIntent,
} from "./playbackIntent";

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
    getInstance: () => ({ on: vi.fn(() => () => {}), release: vi.fn() }),
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
  __resetPlaybackIntentForTests();
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

describe("usePlayerTrackPlayback — isDownloading owner check (attempt supersede)", () => {
  it("UTP-4: superseded attempt must NOT clear the new attempt's spinner on its late abort", async () => {
    const tokenA = deferred<string | null>();
    const tokenB = deferred<string | null>();
    vi.mocked(getValidToken)
      .mockReturnValueOnce(tokenA.promise)
      .mockReturnValueOnce(tokenB.promise);
    const { result, unmount } = renderPlayback();

    const playA = beginPlay(result, makeTrack("t1"));
    // B supersedes A: same controller swap a second click performs.
    const playB = beginPlay(result, makeTrack("t2"));
    expect(usePlayerStore.getState().isDownloading).toBe(true);

    // A's token resolves late; A resumes with its signal already aborted.
    await act(async () => {
      tokenA.resolve("token-a");
      await playA;
    });

    // A must not touch the spinner now owned by B, and must not commit.
    expect(usePlayerStore.getState().isDownloading).toBe(true);
    expect(usePlayerStore.getState().currentTrack).toBeNull();

    // B still completes its own intent normally.
    await act(async () => {
      tokenB.resolve("token-b");
      await playB;
    });
    expect(usePlayerStore.getState().currentTrack?.id).toBe("t2");
    expect(usePlayerStore.getState().isDownloading).toBe(true);
    expect(recordPlay).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t2" }),
    );

    // No RTL auto-cleanup in this suite (globals off): unmount so this hook's
    // pending defer cannot react to the next test's PLAYER_STOP_EVENT.
    unmount();
  });

  it("UTP-5: the current attempt aborted early (player-stop) clears its own spinner", async () => {
    const token = deferred<string | null>();
    vi.mocked(getValidToken).mockReturnValue(token.promise);
    const { result, unmount } = renderPlayback();

    const playPromise = beginPlay(result, makeTrack("t1"));
    expect(usePlayerStore.getState().isDownloading).toBe(true);

    act(() => {
      window.dispatchEvent(new Event(PLAYER_STOP_EVENT));
    });

    await act(async () => {
      token.resolve("fresh-token");
      await playPromise;
    });

    expect(usePlayerStore.getState().isDownloading).toBe(false);
    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(recordPlay).not.toHaveBeenCalled();
    unmount();
  });

  it("UTP-6: normal completion — defer fallback fire clears the spinner as before", async () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderPlayback();

      await act(async () => {
        await result.current.handlePlayTrack(makeTrack("t1"));
      });
      expect(usePlayerStore.getState().isDownloading).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(9_000);
        await Promise.resolve();
      });

      expect(usePlayerStore.getState().isDownloading).toBe(false);
      expect(usePlayerStore.getState().currentTrack?.id).toBe("t1");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("usePlayerTrackPlayback — R3.1a intent controller (contracts a/b)", () => {
  it("(a) system intent during the token await does not invalidate the user play intent — commit still lands", async () => {
    const token = deferred<string | null>();
    vi.mocked(getValidToken).mockReturnValue(token.promise);
    const { result } = renderPlayback();

    const playPromise = beginPlay(result, makeTrack("t1"));
    expect(hasActiveUserIntent()).toBe(true);

    // Auto-advance tries to start while the user's click is awaiting its token.
    let system: ReturnType<typeof beginIntent> | undefined;
    act(() => {
      system = beginIntent("auto-advance");
    });
    expect(system?.isCurrent()).toBe(false);
    expect(system?.abortSignal.aborted).toBe(false);

    await act(async () => {
      token.resolve("fresh-token");
      await playPromise;
    });

    expect(usePlayerStore.getState().currentTrack?.id).toBe("t1");
    expect(recordPlay).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t1" }),
    );
    expect(hasActiveUserIntent()).toBe(false);
  });

  it("(b) delete/stop of the loaded track during an in-flight attempt → no resurrect (SC3)", async () => {
    const token = deferred<string | null>();
    vi.mocked(getValidToken).mockReturnValue(token.promise);
    const { result } = renderPlayback();

    // The file to delete is the loaded track and the user navigates onto it
    // again (next/prev wrap / queue click), so stopPlaybackIfTrack's guard
    // passes while the attempt is still awaiting the token.
    usePlayerStore.setState({ currentTrack: makeTrack("t1"), isPlaying: true });
    let playPromise: Promise<void> | undefined;
    act(() => {
      playPromise = result.current.handlePlayTrack(
        makeTrack("t1"),
        undefined,
        true,
      );
    });
    expect(usePlayerStore.getState().isDownloading).toBe(true);

    act(() => {
      stopPlaybackIfTrack("t1");
    });

    await act(async () => {
      token.resolve("fresh-token");
      await playPromise;
    });

    const state = usePlayerStore.getState();
    expect(state.currentTrack).toBeNull();
    expect(state.isPlaying).toBe(false);
    expect(state.isDownloading).toBe(false);
    expect(recordPlay).not.toHaveBeenCalled();
    expect(hasActiveUserIntent()).toBe(false);
  });
});
