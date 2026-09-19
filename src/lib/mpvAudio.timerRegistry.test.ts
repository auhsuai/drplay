import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../types";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriMocks.listen }));

vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));

import { MpvAudioController } from "./mpvAudio";

const PROXY_PORT = 51234;

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

function fireTauri(name: string, payload: unknown): void {
  for (const handler of tauriListeners.get(name) ?? []) handler({ payload });
}

function fireProperty(name: string, data: unknown): void {
  fireTauri("mpv-property", { name, data });
}

function fireMpvEvent(event: string, reason: string | null = null): void {
  fireTauri("mpv-event", { event, reason, error: null });
}

const trackA: Track = {
  id: "A",
  title: "Track A",
  artist: "Artist",
  streamUrl: "/drive-stream/A",
};

describe("MpvAudioController — timer registry + release invariant (R1.5)", () => {
  let ctrl: MpvAudioController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // move Date.now() off 0 so throttle clocks work
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    attachMocks();
    ctrl = new MpvAudioController();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("beginTrack records its timers under names and the registry count matches the native count", async () => {
    await ctrl.playTrack(trackA);

    expect(ctrl.activeTimerNames()).toEqual(
      expect.arrayContaining(["load-deadline", "buffering-deadline"]),
    );
    expect(ctrl.activeTimerCount()).toBe(vi.getTimerCount());

    ctrl.release();
    expect(ctrl.activeTimerCount()).toBe(0);
  });

  it("release(): empty registry and zero native timers", async () => {
    await ctrl.playTrack(trackA);
    expect(ctrl.activeTimerCount()).toBeGreaterThan(0);

    ctrl.release();

    expect(ctrl.activeTimerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("every group (watchdog, reconciler, interpolator, seek failsafe, buffering) is registered, and release drains them all", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("file-loaded");
    fireProperty("pause", false);
    fireProperty("time-pos", 0.5);
    fireProperty("time-pos", 1); // two changed ticks settle the track spinner
    ctrl.seek(10);

    expect(ctrl.activeTimerNames()).toEqual(
      expect.arrayContaining([
        "watchdog",
        "reconciler",
        "interpolator",
        "seek-failsafe",
        "buffering-display",
        "buffering-deadline",
      ]),
    );
    expect(ctrl.activeTimerCount()).toBe(vi.getTimerCount());

    ctrl.release();

    expect(ctrl.activeTimerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
