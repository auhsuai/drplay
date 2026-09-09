// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NativeAudioEngine } from "./nativeAudioBridge";
import type { Track } from "../types";
import { buildDriveStreamUrl } from "./nativeAudioInvoke";

// IS_MOBILE is a module-level constant read at import time — the platform
// mock must be installed BEFORE the bridge module is imported (same harness
// as nativeAudioEngine.seek.test.ts, including the live getter).
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

const invokeMock = vi.hoisted(() => vi.fn());
const addPluginListenerMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  addPluginListener: addPluginListenerMock,
}));

// Controllable store double: playbackQueue/playMode feed the native-queue
// decision in runPlayChain; setCurrentTrack captures the native-advance sync
// (the engine calls usePlayerStore.getState().setCurrentTrack(next)).
const storeMock = vi.hoisted(() => {
  const state = {
    playbackQueue: [] as Track[],
    playMode: "normal",
  };
  return {
    state,
    setCurrentTrack: vi.fn(),
    setIsPlaying: vi.fn(),
  };
});
vi.mock("../store/playerStore", () => ({
  usePlayerStore: {
    getState: () => ({
      ...storeMock.state,
      setCurrentTrack: storeMock.setCurrentTrack,
      setIsPlaying: storeMock.setIsPlaying,
    }),
  },
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const SET_QUEUE_CMD = "plugin:native-audio|set_queue";
const SET_SOURCE_CMD = "plugin:native-audio|set_source";
const PLAY_CMD = "plugin:native-audio|play";

type QueueItem = { src: string; id: string; title: string; artist: string };
type SetQueuePayload = {
  items: QueueItem[];
  startIndex: number;
  headers: Record<string, string> | undefined;
  repeatMode: string;
};

let bridge: typeof import("./nativeAudioBridge");
let engine: NativeAudioEngine;

const makeTrack = (id: string, title: string): Track => ({
  id,
  title,
  artist: "",
  streamUrl: "",
});

const pluginStateListener = (): ((s: unknown) => void) => {
  const fn = addPluginListenerMock.mock.calls[0]?.[2] as
    ((s: unknown) => void) | undefined;
  if (fn === undefined) throw new Error("expected plugin listener");
  return fn;
};

const findSetQueueCall = (): [string, SetQueuePayload] | undefined => {
  const call = invokeMock.mock.calls.find((c) => c[0] === SET_QUEUE_CMD);
  return call as [string, SetQueuePayload] | undefined;
};

const playingState = (
  mediaId: string | undefined,
): Record<string, unknown> => ({
  status: "playing",
  currentTime: 1,
  duration: 100,
  isPlaying: true,
  buffering: false,
  rate: 1,
  mediaId,
});

beforeEach(async () => {
  invokeMock.mockReset();
  addPluginListenerMock.mockReset();
  storeMock.setCurrentTrack.mockClear();
  storeMock.setIsPlaying.mockClear();
  storeMock.state.playbackQueue = [];
  storeMock.state.playMode = "normal";
  addPluginListenerMock.mockResolvedValue(() => {});
  invokeMock.mockResolvedValue({});
  platformMock.IS_MOBILE = true;
  // Fresh module instance per test — the engine is a singleton by design.
  vi.resetModules();
  bridge = await import("./nativeAudioBridge");
  engine = bridge.nativeAudioEngine;
  await engine.initOnce();
  invokeMock.mockClear();
});

describe("nativeAudioEngine native queue (set_queue)", () => {
  it("playTrack pushes the whole multi-track store queue through set_queue", async () => {
    const track1 = makeTrack("track-1", "One");
    const track2 = makeTrack("track-2", "Two");
    storeMock.state.playbackQueue = [track1, track2];
    storeMock.state.playMode = "repeat-all";
    engine.setToken("test-token");

    await engine.playTrack(track1);

    const call = findSetQueueCall();
    if (call === undefined) throw new Error("set_queue was not invoked");
    const payload = call[1];
    // Items map the Drive URL format from nativeAudioInvoke, 1:1 with the
    // store queue order.
    expect(payload.items).toEqual([
      {
        src: buildDriveStreamUrl("track-1"),
        id: "track-1",
        title: "One",
        artist: "",
      },
      {
        src: buildDriveStreamUrl("track-2"),
        id: "track-2",
        title: "Two",
        artist: "",
      },
    ]);
    expect(payload.startIndex).toBe(0);
    expect(payload.repeatMode).toBe("repeat-all");
    // The Authorization header key must ride along; its VALUE is never
    // asserted here and the token must never reach the error log.
    expect(Object.keys(payload.headers ?? {})).toContain("Authorization");
    const errorLog = await import("../utils/errorLog");
    for (const entry of vi.mocked(errorLog.captureError).mock.calls) {
      expect(JSON.stringify(entry)).not.toContain("test-token");
    }
    // set_source must not run alongside set_queue.
    expect(invokeMock.mock.calls.some((c) => c[0] === SET_SOURCE_CMD)).toBe(
      false,
    );
    // The plugin never auto-plays — seek/play still follow on the start item.
    expect(invokeMock.mock.calls.some((c) => c[0] === PLAY_CMD)).toBe(true);
  });

  it("native auto-advance (mediaId) syncs the engine + store without 'ended'", async () => {
    const track1 = makeTrack("track-1", "One");
    const track2 = makeTrack("track-2", "Two");
    storeMock.state.playbackQueue = [track1, track2];
    await engine.playTrack(track1);

    const endedSpy = vi.fn();
    engine.on("ended", endedSpy);

    // ExoPlayer advanced to item 2 natively — the snapshot carries the new
    // item's mediaId with a playing status (NOT "ended").
    pluginStateListener()(playingState("track-2"));

    // Store sync: the UI + session save now track the real playing item.
    expect(storeMock.setCurrentTrack).toHaveBeenCalledWith(track2);
    // No "ended" for an in-queue advance — the JS auto-advance stays idle.
    expect(endedSpy).not.toHaveBeenCalled();
    // The engine adopted the new track: currentTrackId is track-2, so the
    // PlayerBar-driven playTrack(track-2) becomes a same-track no-op (no
    // set_source/set_queue reload).
    const engineState = engine as unknown as {
      currentTrackId: string | null;
    };
    expect(engineState.currentTrackId).toBe("track-2");
    invokeMock.mockClear();
    await engine.playTrack(track2);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("single-track queue keeps the set_source path (regression guard)", async () => {
    const track1 = makeTrack("track-1", "One");
    storeMock.state.playbackQueue = [track1];

    await engine.playTrack(track1);

    expect(findSetQueueCall()).toBeUndefined();
    expect(invokeMock.mock.calls.some((c) => c[0] === SET_SOURCE_CMD)).toBe(
      true,
    );
  });

  it("a mediaId outside the queue mirror is a no-op (store untouched)", async () => {
    const track1 = makeTrack("track-1", "One");
    storeMock.state.playbackQueue = [track1, makeTrack("track-2", "Two")];
    await engine.playTrack(track1);

    pluginStateListener()(playingState("track-unknown"));

    expect(storeMock.setCurrentTrack).not.toHaveBeenCalled();
  });

  it("release clears the queue mirror — stale mediaId cannot sync the store", async () => {
    const track1 = makeTrack("track-1", "One");
    storeMock.state.playbackQueue = [track1, makeTrack("track-2", "Two")];
    await engine.playTrack(track1);
    await engine.release();

    pluginStateListener()(playingState("track-2"));

    expect(storeMock.setCurrentTrack).not.toHaveBeenCalled();
  });
});
