// Facade suite: AudioController is a thin singleton shell over the mpv engine
// (plan 2026-09-11-mpv-engine 2.1 — public API unchanged). The engine's deep
// behavior lives in mpvAudio.test.ts; here we pin the FACADE contract: the
// singleton, the delegation wiring, and the events reaching `on()` consumers.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../types";
// Task 4 guard: the web audio path was deleted with the mpv cutover — these
// sources must never reference DOM audio (or the removed factory) again.
import audioControllerSource from "../lib/AudioController.ts?raw";
import mpvAudioSource from "../lib/mpvAudio.ts?raw";
import audioNativeEventsSource from "../lib/audioNativeEvents.ts?raw";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriMocks.listen }));

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
      // A fresh load always clears mpv's process-global pause flag (H2 fix).
      ["set_property", "pause", "no"],
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
      trackId: "A",
      attempt: 1,
      currentTime: 12,
      duration: 180,
    });
    // Display-delay tracker: the sustained mpv stall passes the 250ms window
    // before the spinner shows.
    vi.advanceTimersByTime(250);
    expect(buffering).toHaveBeenCalledWith({
      trackId: "A",
      attempt: 1,
      isBuffering: true,
    });
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
    expect(ctrl.getCurrentTrackId()).toBe("A");
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
    expect(ctrl.getCurrentTrackId()).toBeNull();

    const invoked = (
      tauriMocks.invoke.mock.calls as unknown as Array<[string]>
    ).map((call) => call[0]);
    expect(invoked).toEqual(["mpv_shutdown"]);
    fireProperty("time-pos", 5);
    expect(timeupdate).not.toHaveBeenCalled();
  });

  it("pause delegates to the engine pause property", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    ctrl.pause();
    expect(mpvCommands()).toEqual([["set_property", "pause", "yes"]]);
  });
});

describe("guard: web audio path stays removed (mpv cutover)", () => {
  it("facade, engine and event-contract sources contain no DOM audio code", () => {
    const sources = [
      ["AudioController.ts", audioControllerSource],
      ["mpvAudio.ts", mpvAudioSource],
      ["audioNativeEvents.ts", audioNativeEventsSource],
    ] as const;
    for (const [file, source] of sources) {
      expect(source, `${file} must not reference DOM audio`).not.toMatch(
        /new Audio\(|HTMLAudioElement|createNativeEventHandlers/,
      );
    }
  });
});
