// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { usePlayer } from "./usePlayer";
import { usePlayerStore } from "../store/playerStore";
import type { Track } from "../types";
import { getTrackMetadata } from "../utils/metadata";

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
    playTrack: vi.fn(),
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  audioMock.handlers.clear();
  // re-install the `on` mock impl cleared by clearAllMocks
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
  usePlayerStore.setState({
    currentTrack: null,
    loadNonce: 0,
    isPlaying: false,
    isDownloading: false,
    playMode: "normal",
    originalQueue: [],
    playbackQueue: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePlayer metadata defer until first-audio", () => {
  it("REGRESSION: play track -> ZERO metadata request before first-audio; fires on first-audio with same args", async () => {
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t1"), [makeTrack("t1")]);
    });

    const meta = vi.mocked(getTrackMetadata);
    // Main assert: no network metadata request before audio flows,
    // even after a few seconds (< fallback timeout).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(meta).not.toHaveBeenCalled();

    // First audio flowing -> metadata fires once with the original args.
    await act(async () => {
      emitAudio("first-audio", undefined);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(meta).toHaveBeenCalledTimes(1);
    expect(meta).toHaveBeenCalledWith(
      "t1",
      "test-token",
      undefined,
      undefined,
      expect.anything(),
    );
  });

  it("track change before signal -> old track NEVER fetches; new track fetches on its own signal", async () => {
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-old"), [
        makeTrack("t-old"),
      ]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(vi.mocked(getTrackMetadata)).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-new"), [
        makeTrack("t-new"),
      ]);
    });
    await act(async () => {
      emitAudio("first-audio", undefined);
      await vi.advanceTimersByTimeAsync(0);
    });

    const meta = vi.mocked(getTrackMetadata);
    expect(meta).toHaveBeenCalledTimes(1);
    expect(meta).toHaveBeenCalledWith(
      "t-new",
      "test-token",
      undefined,
      undefined,
      expect.anything(),
    );
    // Old track's fallback timer was dropped with the abort — never fires late.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(meta).toHaveBeenCalledTimes(1);
  });

  it("no signal -> fallback timeout fires the fetch (duration/cover still arrive)", async () => {
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t-fb"), [
        makeTrack("t-fb"),
      ]);
    });
    const meta = vi.mocked(getTrackMetadata);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8999);
    });
    expect(meta).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(meta).toHaveBeenCalledTimes(1);
    expect(meta).toHaveBeenCalledWith(
      "t-fb",
      "test-token",
      undefined,
      undefined,
      expect.anything(),
    );
  });

  it("double signal / signal+timeout race -> exactly ONE fetch", async () => {
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
    expect(vi.mocked(getTrackMetadata)).toHaveBeenCalledTimes(1);
  });

  it("playback error before signal -> pending fetch dropped (no late fetch on timeout)", async () => {
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
    expect(vi.mocked(getTrackMetadata)).not.toHaveBeenCalled();
  });

  it("unmount before signal -> timer cleared + unsubscribed, never fetches", async () => {
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
    expect(vi.mocked(getTrackMetadata)).not.toHaveBeenCalled();
    // Every path unsubscribes both listeners — no leak.
    expect(audioMock.handlers.get("first-audio")?.size ?? 0).toBe(0);
    expect(audioMock.handlers.get("error")?.size ?? 0).toBe(0);
  });
});
