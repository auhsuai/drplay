/**
 * Regression (audit D8): ensureProxyPort's stream_proxy_start invoke had no
 * timeout — a hung reply kept the playback attempt pending forever (no
 * loadfile, no error, no supersede). The invoke is bounded by
 * PROXY_START_TIMEOUT_MS now: the attempt fails like any other engine error,
 * the next attempt re-invokes (Rust side binds localhost + is idempotent),
 * and a late reply can never write a stale cached port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../types";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriMocks.listen }));

const storeMocks = vi.hoisted(() => ({
  setIsPlaying: vi.fn(),
  isPlaying: false,
}));

vi.mock("../store/playerStore", () => ({
  usePlayerStore: {
    getState: vi.fn(() => ({
      setIsPlaying: storeMocks.setIsPlaying,
      isPlaying: storeMocks.isPlaying,
    })),
  },
}));

vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));

import { MpvAudioController } from "./mpvAudio";
import { PROXY_START_TIMEOUT_MS } from "./mpvProtocol";

const PROXY_PORT = 51234;
const PROXY_URL_PREFIX = "http://127.0.0.1:51234/stream/";

type TauriHandler = (event: { payload: unknown }) => void;

const tauriListeners = new Map<string, TauriHandler[]>();

function attachMocks(): void {
  tauriMocks.invoke.mockImplementation((command: string) =>
    command === "stream_proxy_start"
      ? Promise.resolve(PROXY_PORT)
      : Promise.resolve(undefined),
  );
  tauriMocks.listen.mockImplementation(
    (name: string, handler: TauriHandler): Promise<() => void> => {
      const list = tauriListeners.get(name) ?? [];
      list.push(handler);
      tauriListeners.set(name, list);
      return Promise.resolve(() => {
        tauriListeners.set(
          name,
          (tauriListeners.get(name) ?? []).filter((h) => h !== handler),
        );
      });
    },
  );
}

function mpvCommands(): string[][] {
  return (
    tauriMocks.invoke.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >
  )
    .filter((call) => call[0] === "mpv_command")
    .map((call) => call[1]["cmd"] as string[]);
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const trackA: Track = {
  id: "A",
  title: "Track A",
  artist: "Artist",
  streamUrl: "/drive-stream/A",
};

describe("MpvAudioController — stream_proxy_start timeout (D8)", () => {
  let ctrl: MpvAudioController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // move Date.now() off 0 for throttle clocks
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hung stream_proxy_start: bounded network_interrupted failure, then a retry re-invokes and loads", async () => {
    const errors: Array<{ message: string; code: string }> = [];
    ctrl.on("error", (payload) => {
      errors.push(payload);
    });
    let proxyCalls = 0;
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "stream_proxy_start") {
        proxyCalls += 1;
        return proxyCalls === 1
          ? new Promise<number>(() => undefined)
          : Promise.resolve(PROXY_PORT);
      }
      return Promise.resolve(undefined);
    });

    const play = ctrl.playTrack(trackA);
    await vi.advanceTimersByTimeAsync(PROXY_START_TIMEOUT_MS + 100);
    await flushMicrotasks();

    // Bounded failure: the attempt settled on its own instead of hanging.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("network_interrupted");
    expect(storeMocks.setIsPlaying).toHaveBeenCalledWith(false);
    expect(mpvCommands().some((cmd) => cmd[0] === "loadfile")).toBe(false);
    await expect(play).resolves.toBeUndefined();

    // Clean retry state: the next attempt re-invokes and loads normally.
    await ctrl.playTrack(trackA);
    expect(proxyCalls).toBe(2);
    expect(mpvCommands()).toContainEqual([
      "loadfile",
      `${PROXY_URL_PREFIX}A`,
      "replace",
    ]);
  });

  it("late stream_proxy_start reply after the timeout never caches the stale port", async () => {
    let lateResolve!: (port: number) => void;
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "stream_proxy_start") {
        return new Promise<number>((resolve) => {
          lateResolve = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const play = ctrl.playTrack(trackA);
    await vi.advanceTimersByTimeAsync(PROXY_START_TIMEOUT_MS + 100);
    await flushMicrotasks();
    await expect(play).resolves.toBeUndefined();

    lateResolve(9999); // the sidecar's reply arrives after the attempt failed
    await flushMicrotasks();

    tauriMocks.invoke.mockImplementation((command: string) =>
      command === "stream_proxy_start"
        ? Promise.resolve(PROXY_PORT)
        : Promise.resolve(undefined),
    );
    tauriMocks.invoke.mockClear();
    await ctrl.playTrack(trackA);

    // The retry invoked the proxy again and loaded with the fresh port — the
    // late 9999 reply was dropped, not cached.
    const loads = mpvCommands().filter((cmd) => cmd[0] === "loadfile");
    expect(loads).toEqual([["loadfile", `${PROXY_URL_PREFIX}A`, "replace"]]);
  });
});
