// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { usePlayer } from "./usePlayer";
import { usePlayerStore } from "../store/playerStore";
import type { Track } from "../types";
import { prefetchTrackInServiceWorker } from "../utils/swPrefetch";

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
  metadataCache: new Map(),
}));

vi.mock("../utils/apiClient", () => ({
  getValidToken: vi.fn(() => Promise.resolve("test-token")),
}));

vi.mock("../utils/streamPrefetcher", () => ({
  getPrefetchedStreamUrl: vi.fn(() => undefined),
  DRIVE_STREAM_PREFIX: "/drive-stream/",
  buildStreamUrl: vi.fn((id: string) => `/drive-stream/${id}`),
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

vi.mock("../utils/swPrefetch", () => ({
  prefetchTrackInServiceWorker: vi.fn(),
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

type Handler = (payload?: unknown) => void;

const audioMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<Handler>>();
  return {
    handlers,
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 0),
    seek: vi.fn(),
    pause: vi.fn(),
    togglePlay: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => {
        handlers.get(event)?.delete(handler);
      };
    }),
    release: vi.fn(),
  };
});

vi.mock("../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
}));

function emitAudio(event: string, payload?: unknown): void {
  for (const h of [...(audioMock.handlers.get(event) ?? [])]) h(payload);
}

function makeTrack(id: string): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    streamUrl: `https://stream.example/${id}`,
  };
}

function resetStoreWithQueue(queue: Track[]): void {
  usePlayerStore.setState({
    currentTrack: null,
    loadNonce: 0,
    isPlaying: false,
    isDownloading: false,
    playMode: "normal",
    originalQueue: [],
    playbackQueue: queue,
    brokenTrackIds: [],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  audioMock.handlers.clear();
  audioMock.on.mockImplementation((event: string, handler: Handler) => {
    let set = audioMock.handlers.get(event);
    if (!set) {
      set = new Set();
      audioMock.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      audioMock.handlers.get(event)?.delete(handler);
    };
  });
  resetStoreWithQueue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePlayer prefetch defer until first-audio", () => {
  it("REGRESSION: play track -> ZERO prefetch before first-audio; fires once on first-audio with next id", async () => {
    resetStoreWithQueue([makeTrack("t1"), makeTrack("t2")]);
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t1"), [makeTrack("t1")]);
    });

    const prefetch = vi.mocked(prefetchTrackInServiceWorker);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(prefetch).not.toHaveBeenCalled();

    await act(async () => {
      emitAudio("first-audio", undefined);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("t2");
  });

  it("track change before signal -> old track NEVER prefetches; new track prefetches on its own signal", async () => {
    // Note: next-track predicate resolves the track AFTER current in queue
    // order (skipping broken tracks), in line with handleNextTrack — only the
    // timing moves. Queues are swapped between plays so each track's expected
    // next is unambiguous.
    resetStoreWithQueue([makeTrack("t-old"), makeTrack("t-old-next")]);
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-old"), [
        makeTrack("t-old"),
      ]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(vi.mocked(prefetchTrackInServiceWorker)).not.toHaveBeenCalled();

    act(() => {
      usePlayerStore.setState({
        playbackQueue: [makeTrack("t-new"), makeTrack("t-next")],
      });
    });
    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-new"), [
        makeTrack("t-new"),
      ]);
    });
    await act(async () => {
      emitAudio("first-audio", undefined);
      await vi.advanceTimersByTimeAsync(0);
    });

    const prefetch = vi.mocked(prefetchTrackInServiceWorker);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("t-next");
    expect(prefetch).not.toHaveBeenCalledWith("t-old-next");
  });

  it("playback error before signal -> pending prefetch dropped (no late fire)", async () => {
    resetStoreWithQueue([makeTrack("t-err"), makeTrack("t-next")]);
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-err"), [
        makeTrack("t-err"),
      ]);
    });
    await act(async () => {
      emitAudio("error", { message: "x", code: "format_error" });
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(vi.mocked(prefetchTrackInServiceWorker)).not.toHaveBeenCalled();
  });

  it("double first-audio -> exactly ONE prefetch", async () => {
    resetStoreWithQueue([makeTrack("t-once"), makeTrack("t-next")]);
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-once"), [
        makeTrack("t-once"),
      ]);
    });
    await act(async () => {
      emitAudio("first-audio", undefined);
      emitAudio("first-audio", undefined);
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(vi.mocked(prefetchTrackInServiceWorker)).toHaveBeenCalledTimes(1);
  });

  it("queue changes while waiting -> prefetch resolves next track FRESH at fire time", async () => {
    resetStoreWithQueue([makeTrack("t1"), makeTrack("t2")]);
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t1"), [makeTrack("t1")]);
    });
    // Queue reordered before audio flows — t3 is now the next track.
    act(() => {
      usePlayerStore.setState({
        playbackQueue: [makeTrack("t1"), makeTrack("t3")],
      });
    });
    await act(async () => {
      emitAudio("first-audio", undefined);
      await vi.advanceTimersByTimeAsync(0);
    });

    const prefetch = vi.mocked(prefetchTrackInServiceWorker);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("t3");
  });

  it("normal mode mid-queue: prefetch the track AFTER current, not the queue head", async () => {
    resetStoreWithQueue([makeTrack("t-a"), makeTrack("t-b"), makeTrack("t-c")]);
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-b"), [
        makeTrack("t-b"),
      ]);
    });
    await act(async () => {
      emitAudio("first-audio", undefined);
      await vi.advanceTimersByTimeAsync(0);
    });

    const prefetch = vi.mocked(prefetchTrackInServiceWorker);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("t-c");
  });

  it("normal mode last track: no prefetch (no wrap)", async () => {
    resetStoreWithQueue([makeTrack("t-a"), makeTrack("t-b"), makeTrack("t-c")]);
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-c"), [
        makeTrack("t-c"),
      ]);
    });
    await act(async () => {
      emitAudio("first-audio", undefined);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(vi.mocked(prefetchTrackInServiceWorker)).not.toHaveBeenCalled();
  });

  it("repeat-all wrap: last track prefetches queue head", async () => {
    resetStoreWithQueue([makeTrack("t-a"), makeTrack("t-b"), makeTrack("t-c")]);
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-c"), [
        makeTrack("t-c"),
      ]);
    });
    act(() => {
      usePlayerStore.setState({ playMode: "repeat-all" });
    });
    await act(async () => {
      emitAudio("first-audio", undefined);
      await vi.advanceTimersByTimeAsync(0);
    });

    const prefetch = vi.mocked(prefetchTrackInServiceWorker);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("t-a");
  });

  it("skips broken next: prefetch the first non-broken track after current", async () => {
    resetStoreWithQueue([makeTrack("t-a"), makeTrack("t-b"), makeTrack("t-c")]);
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-a"), [
        makeTrack("t-a"),
      ]);
    });
    act(() => {
      usePlayerStore.setState({ brokenTrackIds: ["t-b"] });
    });
    await act(async () => {
      emitAudio("first-audio", undefined);
      await vi.advanceTimersByTimeAsync(0);
    });

    const prefetch = vi.mocked(prefetchTrackInServiceWorker);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("t-c");
  });

  it("stuck track (never first-audio) -> NO prefetch, no fallback timer", async () => {
    resetStoreWithQueue([makeTrack("t-stuck"), makeTrack("t-next")]);
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-stuck"), [
        makeTrack("t-stuck"),
      ]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(vi.mocked(prefetchTrackInServiceWorker)).not.toHaveBeenCalled();
  });

  it("unmount before signal -> never prefetches, listeners cleaned up", async () => {
    resetStoreWithQueue([makeTrack("t-um"), makeTrack("t-next")]);
    const { result, unmount } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-um"), [
        makeTrack("t-um"),
      ]);
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(vi.mocked(prefetchTrackInServiceWorker)).not.toHaveBeenCalled();
    expect(audioMock.handlers.get("first-audio")?.size ?? 0).toBe(0);
    expect(audioMock.handlers.get("error")?.size ?? 0).toBe(0);
  });
});
