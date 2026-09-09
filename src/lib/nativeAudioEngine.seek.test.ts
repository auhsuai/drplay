// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NativeAudioEngine } from "./nativeAudioBridge";

// IS_MOBILE is a module-level constant read at import time — the platform
// mock must be installed BEFORE the bridge module is imported (same harness
// as nativeAudioBridge.test.ts, including the live getter).
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

const setStateMock = vi.hoisted(() => vi.fn());
vi.mock("../store/playerStore", () => ({
  usePlayerStore: {
    getState: () => ({
      setIsPlaying: setStateMock,
      // Default single/empty queue state: runPlayChain reads the queue to
      // decide between set_queue and set_source — the default keeps every
      // pre-queue test on the plain setSource path.
      playbackQueue: [] as unknown[],
      playMode: "normal",
    }),
  },
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const SEEK_CMD = "plugin:native-audio|seek_to";

let bridge: typeof import("./nativeAudioBridge");
let engine: NativeAudioEngine;

beforeEach(async () => {
  invokeMock.mockReset();
  addPluginListenerMock.mockReset();
  setStateMock.mockReset();
  addPluginListenerMock.mockResolvedValue(() => {});
  invokeMock.mockResolvedValue({});
  platformMock.IS_MOBILE = true;
  // Fresh module instance per test — the engine is a singleton by design.
  vi.resetModules();
  bridge = await import("./nativeAudioBridge");
  engine = bridge.nativeAudioEngine;
});

const seekCalls = () =>
  invokeMock.mock.calls.filter(([cmd]) => cmd === SEEK_CMD);

// Flush every pending microtask deterministically (no fake timers needed).
const flushMacrotask = () => new Promise((r) => setTimeout(r, 0));

describe("nativeAudioEngine.seek (rapid-seek coalescing)", () => {
  it("coalesces rapid seeks — latest-wins, only the newest seek_to fires", async () => {
    await engine.initOnce();
    invokeMock.mockClear();

    await Promise.allSettled([engine.seek(1), engine.seek(2), engine.seek(3)]);

    const calls = seekCalls();
    // Latest-wins: intermediate seeks are dropped, not executed (ExoPlayer's
    // pending-seek coalescing — the user only cares where they END UP).
    expect(calls.length).toBeLessThan(3);
    expect(calls[calls.length - 1]).toEqual([SEEK_CMD, { position: 3 }]);
  });

  it("queues seek behind a running load chain — seek_to never interleaves with set_source/play", async () => {
    await engine.initOnce();
    invokeMock.mockClear();
    const events: string[] = [];
    let resolveSource: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string) => {
      events.push(cmd);
      if (cmd === "plugin:native-audio|set_source") {
        return new Promise((resolve) => {
          resolveSource = resolve;
        });
      }
      return Promise.resolve({});
    });

    const load = engine.playTrack({
      id: "track-A",
      title: "A",
      artist: "",
      streamUrl: "",
    });
    await vi.waitFor(() => {
      expect(events).toContain("plugin:native-audio|set_source");
    });

    const seekTurn = engine.seek(42);
    // Deterministic RED guard: on the unfixed engine the seek_to fires while
    // the load chain is still suspended on set_source.
    await flushMacrotask();
    resolveSource({});
    await Promise.allSettled([load, seekTurn]);

    const playIdx = events.indexOf("plugin:native-audio|play");
    const seekIdx = events.indexOf(SEEK_CMD);
    expect(playIdx).toBeGreaterThan(-1);
    expect(seekIdx).toBeGreaterThan(playIdx);
  });

  it("a seek queued behind a superseded load chain still applies (playTrack must not invalidate it)", async () => {
    await engine.initOnce();
    invokeMock.mockClear();
    const events: string[] = [];
    let resolveSourceA: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string, payload?: { src?: string }) => {
      if (cmd === "plugin:native-audio|set_source") {
        events.push(`set_source:${String(payload?.src)}`);
        if (payload?.src?.includes("track-A") === true) {
          return new Promise((resolve) => {
            resolveSourceA = resolve;
          });
        }
      } else {
        events.push(cmd);
      }
      return Promise.resolve({});
    });

    const loadA = engine.playTrack({
      id: "track-A",
      title: "A",
      artist: "",
      streamUrl: "",
    });
    await vi.waitFor(() => {
      expect(events.some((e) => e.startsWith("set_source"))).toBe(true);
    });

    const seekTurn = engine.seek(42);
    const loadB = engine.playTrack({
      id: "track-B",
      title: "B",
      artist: "",
      streamUrl: "",
    });
    await flushMacrotask();
    resolveSourceA({});
    await Promise.allSettled([loadA, seekTurn, loadB]);

    // The queued seek survives the superseded load (FIFO order) and lands
    // with its position; only B's play fires — A's stale chain is skipped.
    const calls = seekCalls();
    expect(calls).toEqual([[SEEK_CMD, { position: 42 }]]);
    expect(events.filter((e) => e === "plugin:native-audio|play")).toHaveLength(
      1,
    );
  });

  it("a rejected seek does not poison the queue — the next seek still applies", async () => {
    await engine.initOnce();
    invokeMock.mockClear();
    let seekCount = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === SEEK_CMD) {
        seekCount++;
        return seekCount === 1
          ? Promise.reject(new Error("boom"))
          : Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await expect(engine.seek(1)).rejects.toThrow("boom");
    await engine.seek(2);

    const calls = seekCalls();
    expect(calls).toEqual([
      [SEEK_CMD, { position: 1 }],
      [SEEK_CMD, { position: 2 }],
    ]);
  });

  it("seek with no load chain in flight still fires seek_to (no regression)", async () => {
    await engine.initOnce();
    invokeMock.mockClear();

    await engine.seek(30);

    expect(invokeMock).toHaveBeenCalledWith(SEEK_CMD, { position: 30 });
  });
});
