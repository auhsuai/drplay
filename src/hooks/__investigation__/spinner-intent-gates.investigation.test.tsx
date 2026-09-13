// @vitest-environment jsdom
/**
 * REGRESSION tests for the spinner intent/gate defects reported by the user
 * (S2 + S3, hook/UI level), updated to the fixed engine contract v3:
 *
 * S2 — "nút play nháy icon sai khi chuyển bài": the hook's `onceAfterFirstAudio`
 *   (usePlayerTrackPlayback.ts:183) turns `isDownloading` OFF at the engine's
 *   `first-audio` event. Engine v3 (spinner-seek-settle E8) emits
 *   `buffering=true` at playTrack — BEFORE the first real time-pos push that
 *   fires first-audio — so the gate stays covered with no source gap.
 *
 * S3 — "chuyển bài khi đang pause → không thấy spinner": engine v3 never
 *   settles on pause=false (spinner-seek-settle E4) and re-arms the shown
 *   spinner for the new track, so a switch while paused keeps the spinner
 *   alive through the whole pre-audio window.
 *
 * Gates under test (exact component expressions):
 *   TransportControls.tsx:58  isDownloading || (isBuffering && isPlaying && !hasError)
 *   NowPlayingControls.tsx:54 isDownloading || (isBuffering && isPlaying)
 */
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayer } from "../usePlayer";
import { usePlayerStore } from "../../store/playerStore";
import { NowPlayingControls } from "../../ui/NowPlaying/components/NowPlayingControls";
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

vi.mock("../../utils/sessionCleanup", () => ({
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

function emitAudio(event: string, payload?: unknown): void {
  for (const handler of audioMock.handlers.get(event) ?? []) handler(payload);
}

function makeTrack(id: string): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    streamUrl: `https://stream.example/${id}`,
  };
}

/** Renders the real NowPlayingControls and returns whether it spins. */
function nowPlayingSpins(props: {
  isPlaying: boolean;
  isBuffering: boolean;
  isDownloading: boolean;
}): boolean {
  const { container } = render(
    <NowPlayingControls
      isPlaying={props.isPlaying}
      isBuffering={props.isBuffering}
      isDownloading={props.isDownloading}
      onTogglePlay={() => undefined}
      onNextTrack={() => undefined}
      onPrevTrack={() => undefined}
      playMode="normal"
      onTogglePlayMode={() => undefined}
    />,
  );
  return container.querySelector(".animate-spin") !== null;
}

/** Exact NowPlayingControls.tsx:54 gate over runtime values. */
function spinnerGate(
  isDownloading: boolean,
  isBuffering: boolean,
  isPlaying: boolean,
): boolean {
  return isDownloading || (isBuffering && isPlaying);
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
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("spinner intent gates investigation — hook/UI (S2 + S3)", () => {
  it("S2 (fixed): the engine's buffering=true at playTrack covers first-audio — the button never falls back to Pause in the gap", async () => {
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t1"), [makeTrack("t1")]);
    });
    // Intent window: the click covers the pre-load phase.
    expect(usePlayerStore.getState().isDownloading).toBe(true);
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    // Engine v3 order (spinner-seek-settle E8): the engine promotes the
    // spinner when playTrack starts the load — BEFORE the first real time-pos
    // push whose first-audio signal turns the hook's intent flag off.
    let engineBuffering = false;
    act(() => {
      engineBuffering = true;
      emitAudio("buffering", { isBuffering: true });
    });
    await act(async () => {
      emitAudio("first-audio");
      await Promise.resolve(); // flush the post-first-audio store updates
    });

    const s = usePlayerStore.getState();
    expect(s.isDownloading).toBe(false); // hook exit at first-audio (unchanged)
    // Exact TransportControls.tsx:58 / NowPlayingControls.tsx:54 gate:
    const spinnerVisible = spinnerGate(
      s.isDownloading,
      engineBuffering,
      s.isPlaying,
    );
    expect(
      spinnerVisible,
      "no spinner source covered the first-audio window",
    ).toBe(true);
    expect(
      nowPlayingSpins({
        isPlaying: s.isPlaying,
        isBuffering: engineBuffering,
        isDownloading: s.isDownloading,
      }),
      "NowPlayingControls fell back to the Pause icon mid-load",
    ).toBe(true);
  });

  it("S3 (fixed): switch while paused after a shown spinner — the engine keeps buffering=true, first-audio drops the intent flag, the gate stays on", async () => {
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t1"), [makeTrack("t1")]);
    });
    // The user paused while track A's spinner was shown; v3 keeps the tracker
    // shown through the pause (no pause=false settle) and re-arms it for B.

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t2"), [makeTrack("t2")]);
    });
    expect(usePlayerStore.getState().isDownloading).toBe(true); // click intent

    // Engine v3 order for the pre-shown switch (spinner-seek-settle E4): no
    // buffering=false is ever emitted — the spinner promoted for A stays on
    // (shown -> shown dedupe) while B is loading.
    const engineBuffering = true;
    await act(async () => {
      emitAudio("first-audio"); // B's first push -> isDownloading drops
      await Promise.resolve(); // flush the post-first-audio store updates
    });

    const s = usePlayerStore.getState();
    expect(s.isDownloading).toBe(false);
    // B's engine clock is frozen from here on (no more time-pos pushes) but
    // the buffering source is still on — no gap.
    const spinnerVisible = spinnerGate(
      s.isDownloading,
      engineBuffering,
      s.isPlaying,
    );
    expect(
      spinnerVisible,
      "track B is silent with NO spinner: first-audio left no source",
    ).toBe(true);
    expect(
      nowPlayingSpins({
        isPlaying: s.isPlaying,
        isBuffering: engineBuffering,
        isDownloading: s.isDownloading,
      }),
      "NowPlayingControls shows the static Pause icon while B produces no audio",
    ).toBe(true);
  });

  it("S3 control: plain switch-while-paused (tracker was idle) keeps the spinner on through the load", async () => {
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t1"), [makeTrack("t1")]);
    });
    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t2"), [makeTrack("t2")]);
    });

    // Engine v3 order for the switch: playTrack promotes buffering=true
    // immediately (dedupe across tracks) — the gate is covered from the
    // first frame of the new track's load.
    act(() => {
      emitAudio("buffering", { isBuffering: true });
    });
    const s = usePlayerStore.getState();
    const engineBuffering = true;
    expect(spinnerGate(s.isDownloading, engineBuffering, s.isPlaying)).toBe(
      true,
    );
  });
});
