// Facade suite: AudioController is a thin singleton shell over the mpv engine
// (plan 2026-09-11-mpv-engine 2.1 — public API unchanged). The engine's deep
// behavior lives in mpvAudio.test.ts; here we pin the FACADE contract: the
// singleton, the delegation wiring, and the events reaching `on()` consumers.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../types";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriMocks.listen }));

const storeMocks = vi.hoisted(() => ({ setIsPlaying: vi.fn() }));

vi.mock("../store/playerStore", () => ({
  usePlayerStore: {
    getState: vi.fn(() => ({ setIsPlaying: storeMocks.setIsPlaying })),
  },
}));

vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));

import { captureError } from "../utils/errorLog";

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

function mpvCommands(): string[][] {
  return (
    tauriMocks.invoke.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >
  )
    .filter((call) => call[0] === "mpv_command")
    .map((call) => call[1]["cmd"] as string[]);
}

const trackA: Track = {
  id: "A",
  title: "Track A",
  artist: "Artist",
  streamUrl: "/drive-stream/A",
};

describe("AudioController facade over the mpv engine", () => {
  let AudioControllerClass: typeof import("../lib/AudioController").AudioController;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    vi.mocked(captureError).mockClear();
    attachMocks();
    // Fresh module each test so the singleton never leaks between tests.
    vi.resetModules();
    const mod = await import("../lib/AudioController");
    AudioControllerClass = mod.AudioController;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("getInstance returns the same singleton instance", () => {
    expect(AudioControllerClass.getInstance()).toBe(
      AudioControllerClass.getInstance(),
    );
  });

  it("playTrack delegates to the mpv engine (spawn + proxy + loadfile)", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);

    // Freshly spawned mpv gets the facade volume re-applied before loadfile.
    expect(mpvCommands()).toEqual([
      ["set_property", "volume", "100"],
      [
        "loadfile",
        `http://127.0.0.1:${String(PROXY_PORT)}/stream/A`,
        "replace",
      ],
    ]);
  });

  it("on() delivers mapped engine events to facade consumers (real AudioEventMap shape)", async () => {
    const ctrl = AudioControllerClass.getInstance();
    const timeupdate = vi.fn();
    const buffering = vi.fn();
    ctrl.on("timeupdate", timeupdate);
    ctrl.on("buffering", buffering);

    await ctrl.playTrack(trackA);
    fireProperty("duration", 180);
    fireProperty("time-pos", 12);
    fireProperty("paused-for-cache", true);

    expect(timeupdate).toHaveBeenCalledWith({
      currentTime: 12,
      duration: 180,
    });
    expect(buffering).toHaveBeenCalledWith({ isBuffering: true });
  });

  it("on() unsubscribe removes the handler", () => {
    const ctrl = AudioControllerClass.getInstance();
    const ended = vi.fn();
    const unsub = ctrl.on("ended", ended);
    unsub();

    fireTauri("mpv-event", { event: "end-file", reason: "eof" });
    expect(ended).not.toHaveBeenCalled();
  });

  it("volume/mute facade: 0..1 in, mpv 0..100 out; toggleMute returns boolean (VolumeSlider contract)", async () => {
    const ctrl = AudioControllerClass.getInstance();
    ctrl.setVolume(0.5);
    await ctrl.playTrack(trackA);

    expect(ctrl.getVolume()).toBe(0.5);
    expect(mpvCommands()).toContainEqual(["set_property", "volume", "50"]);

    expect(ctrl.toggleMute()).toBe(true);
    expect(ctrl.isMuted()).toBe(true);
    expect(mpvCommands()).toContainEqual(["set_property", "volume", "0"]);

    expect(ctrl.toggleMute()).toBe(false);
    expect(ctrl.isMuted()).toBe(false);
  });

  it("seek delegates to the mpv seek command", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    ctrl.seek(42);
    expect(mpvCommands()).toEqual([["seek", "42", "absolute"]]);
  });

  it("getCurrentTime/getDuration/getBuffered reflect engine state", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    fireProperty("duration", 180);
    fireProperty("time-pos", 12);
    fireProperty("demuxer-cache-state", {
      "seekable-ranges": [{ start: 0, end: 30 }],
    });

    expect(ctrl.getCurrentTime()).toBe(12);
    expect(ctrl.getDuration()).toBe(180);
    const buffered = ctrl.getBuffered();
    expect(buffered.duration).toBe(180);
    expect(buffered.currentTime).toBe(12);
    expect(buffered.buffered.length).toBe(1);
    expect(buffered.buffered.end(0)).toBe(30);
  });

  it("release delegates: mpv_shutdown invoked and engine listeners unhooked", async () => {
    const ctrl = AudioControllerClass.getInstance();
    const timeupdate = vi.fn();
    ctrl.on("timeupdate", timeupdate);
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    ctrl.release();

    const invoked = (
      tauriMocks.invoke.mock.calls as unknown as Array<[string]>
    ).map((call) => call[0]);
    expect(invoked).toEqual(["mpv_shutdown"]);
    fireProperty("time-pos", 5);
    expect(timeupdate).not.toHaveBeenCalled();
  });

  it("pause/togglePlay delegate to the engine pause property", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    ctrl.pause();
    expect(mpvCommands()).toEqual([["set_property", "pause", "yes"]]);

    // Engine's paused state syncs from the mpv property event.
    fireProperty("pause", true);
    tauriMocks.invoke.mockClear();
    ctrl.togglePlay();
    expect(mpvCommands()).toEqual([["set_property", "pause", "no"]]);
  });
});
