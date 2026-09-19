// @vitest-environment jsdom
/**
 * INVESTIGATION-ONLY test for Bug B, hook-level window: `handlePlayTrack`
 * turns `isDownloading` OFF (usePlayer.ts:292) as soon as the stream URL is
 * set — before the audio engine has even been asked to load the track (the
 * PlayerBar effect on isPlaying drives `audio.playTrack`, and only then does
 * `buffering.request()` run + a 250ms display delay). During that window the
 * exact UI gates
 *   TransportControls.tsx:58  isDownloading || (isBuffering && isPlaying && !hasError)
 *   NowPlayingControls.tsx:54 isDownloading || (isBuffering && isPlaying)
 * are BOTH false → no spinner while the new track has zero audio.
 *
 * RED today: spinnerVisible === false.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayer } from "../usePlayer";
import { usePlayerStore } from "../../store/playerStore";
import type { Track } from "../../types";

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
  DRIVE_STREAM_PREFIX: "/drive-stream/",
  buildStreamUrl: vi.fn((id: string) => `/drive-stream/${id}`),
}));

vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));

vi.mock("../../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const queueMock = vi.hoisted(() => ({
  handleNextTrack: vi.fn(),
  handlePrevTrack: vi.fn(),
  handleTogglePlayMode: vi.fn(),
  updateQueueContext: vi.fn((track: Track) => track),
}));

vi.mock("../player/usePlayerQueue", () => ({
  usePlayerQueue: () => queueMock,
}));

vi.mock("../player/usePlayerSession", () => ({
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

vi.mock("../../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
}));

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

describe("Bug B investigation — play-intent spinner window", () => {
  it("B3 (RED today): no spinner source survives handlePlayTrack while the new track has zero audio", async () => {
    // Track every engine buffering transition — none can happen in this
    // harness because the real `audio.playTrack` is driven by PlayerBar's
    // effect (not mounted here), exactly like the app's pre-load window.
    const bufferingEvents: boolean[] = [];
    audioMock.on("buffering", (payload) => {
      const p = payload as { isBuffering: boolean } | undefined;
      if (p) bufferingEvents.push(p.isBuffering);
    });

    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t1"), [makeTrack("t1")]);
    });

    const s = usePlayerStore.getState();
    expect(s.currentTrack?.id).toBe("t1");
    // The app already flipped to "playing" optimistically (usePlayer.ts:291)
    // before any byte of audio — that is why the button shows the Pause icon.
    expect(s.isPlaying).toBe(true);
    expect(bufferingEvents).toEqual([]);

    // Exact UI gate with the real state at this instant:
    // isDownloading (false) || (isBuffering (false) && isPlaying (true)).
    const isBuffering = bufferingEvents.includes(true);
    const spinnerVisible = s.isDownloading || (isBuffering && s.isPlaying);
    expect(spinnerVisible).toBe(true);
  });

  it("B3b (variant): switching tracks mid-load keeps the NEW intent's spinner on (old abort must not win)", async () => {
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t1"), [makeTrack("t1")]);
    });
    expect(usePlayerStore.getState().isDownloading).toBe(true);

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t2"), [makeTrack("t2")]);
    });

    // createAbortSignal() aborts t1's defer synchronously -> dropMetadataDefer
    // clears isDownloading; the new call then sets it true (signal first,
    // setIsDownloading(true) second) so the new play intent must win.
    const s = usePlayerStore.getState();
    expect(s.currentTrack?.id).toBe("t2");
    expect(s.isDownloading).toBe(true);
  });
});
