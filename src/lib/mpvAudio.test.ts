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

import { MpvAudioController } from "./mpvAudio";
import { captureError } from "../utils/errorLog";

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

function fireTauri(name: string, payload: unknown): void {
  for (const handler of tauriListeners.get(name) ?? []) handler({ payload });
}

function fireProperty(name: string, data: unknown): void {
  fireTauri("mpv-property", { name, data });
}

function fireMpvEvent(event: string, reason: string | null = null): void {
  fireTauri("mpv-event", { event, reason });
}

function commandNames(): string[] {
  return (tauriMocks.invoke.mock.calls as unknown as Array<[string]>).map(
    (call) => call[0],
  );
}

function commandPayloads(name: string): Array<Record<string, unknown>> {
  return (
    tauriMocks.invoke.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >
  )
    .filter((call) => call[0] === name)
    .map((call) => call[1]);
}

function mpvCommands(): string[][] {
  return commandPayloads("mpv_command").map((args) => args["cmd"] as string[]);
}

const trackA: Track = {
  id: "A",
  title: "Track A",
  artist: "Artist",
  streamUrl: "/drive-stream/A",
};
const trackB: Track = {
  id: "B",
  title: "Track B",
  artist: "Artist",
  streamUrl: "/drive-stream/B",
};

describe("MpvAudioController — playback wiring (plan 2.3)", () => {
  let ctrl: MpvAudioController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // move Date.now() off 0 so throttle clocks work
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    vi.mocked(captureError).mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("first playTrack: mpv_spawn + stream_proxy_start + loadfile replace with the proxy URL, in order", async () => {
    await ctrl.playTrack(trackA);

    // A freshly spawned mpv starts at volume 100 — the engine re-applies the
    // facade volume (default 1.0) right after spawn, before the loadfile.
    expect(commandNames().filter((n) => n !== "mpv_command")).toEqual([
      "mpv_spawn",
      "stream_proxy_start",
    ]);
    expect(mpvCommands()).toEqual([
      ["set_property", "volume", "100"],
      ["loadfile", `${PROXY_URL_PREFIX}A`, "replace"],
    ]);
  });

  it("second playTrack: port cached and mpv NOT respawned — only the loadfile command", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    await ctrl.playTrack(trackB);

    expect(commandNames()).toEqual(["mpv_command"]);
    expect(mpvCommands()).toEqual([
      ["loadfile", `${PROXY_URL_PREFIX}B`, "replace"],
    ]);
  });

  it("same track while paused resumes via set_property pause no — no reload", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("pause", true);
    tauriMocks.invoke.mockClear();

    await ctrl.playTrack(trackA);

    expect(mpvCommands()).toEqual([["set_property", "pause", "no"]]);
  });

  it("same track after end-file eof reloads the file (loadfile replace)", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("end-file", "eof");
    tauriMocks.invoke.mockClear();

    await ctrl.playTrack(trackA);

    expect(mpvCommands()).toEqual([
      ["loadfile", `${PROXY_URL_PREFIX}A`, "replace"],
    ]);
  });

  it("new track clears a paused mpv: loadfile is followed by set_property pause no", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("pause", true);
    tauriMocks.invoke.mockClear();

    await ctrl.playTrack(trackB);

    expect(mpvCommands()).toEqual([
      ["loadfile", `${PROXY_URL_PREFIX}B`, "replace"],
      ["set_property", "pause", "no"],
    ]);
  });

  it("getCurrentTime resets to 0 right after a new loadfile (race with stale time-pos)", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("time-pos", 42);
    expect(ctrl.getCurrentTime()).toBe(42);

    await ctrl.playTrack(trackB);
    expect(ctrl.getCurrentTime()).toBe(0);
  });

  it("playTrack failure (mpv_command rejects) does not crash: logs, emits error, resets isPlaying", async () => {
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "mpv_command")
        return Promise.reject(
          new Error("mpv is not running (call mpv_spawn first)"),
        );
      if (command === "stream_proxy_start") return Promise.resolve(PROXY_PORT);
      return Promise.resolve(undefined);
    });

    await expect(ctrl.playTrack(trackA)).resolves.toBeUndefined();

    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", source: "MpvAudioController" }),
    );
    expect(storeMocks.setIsPlaying).toHaveBeenCalledWith(false);
  });
});

describe("MpvAudioController — mpv-property mapping (payload shape = AudioEventMap)", () => {
  let ctrl: MpvAudioController;
  let events: { name: string; payload: unknown }[];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    vi.mocked(captureError).mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
    // Engine attaches its Tauri listeners lazily on the first playTrack —
    // start playback so property events actually reach the handlers.
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();
    events = [];
    for (const name of [
      "timeupdate",
      "durationchange",
      "buffering",
      "progress",
      "play",
      "pause",
      "ended",
      "error",
    ] as const) {
      ctrl.on(name, (payload) => {
        events.push({ name, payload });
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function emitted(name: string): unknown[] {
    return events.filter((e) => e.name === name).map((e) => e.payload);
  }

  it("time-pos -> timeupdate {currentTime, duration} (real AudioEventMap shape), throttled to ~5/s", () => {
    fireProperty("duration", 180);

    fireProperty("time-pos", 12);
    expect(emitted("timeupdate")).toEqual([{ currentTime: 12, duration: 180 }]);

    fireProperty("time-pos", 12.5);
    expect(emitted("timeupdate")).toHaveLength(1);

    vi.advanceTimersByTime(250);
    fireProperty("time-pos", 13);
    expect(emitted("timeupdate")).toEqual([
      { currentTime: 12, duration: 180 },
      { currentTime: 13, duration: 180 },
    ]);
  });

  it("duration -> durationchange {duration} + getDuration()", () => {
    fireProperty("duration", 180);
    expect(emitted("durationchange")).toEqual([{ duration: 180 }]);
    expect(ctrl.getDuration()).toBe(180);
  });

  it("pause=true -> pause event + setIsPlaying(false); pause=false -> play event + setIsPlaying(true)", () => {
    fireProperty("pause", true);
    expect(emitted("pause")).toEqual([undefined]);
    expect(storeMocks.setIsPlaying).toHaveBeenCalledWith(false);

    fireProperty("pause", false);
    expect(emitted("play")).toEqual([undefined]);
    expect(storeMocks.setIsPlaying).toHaveBeenCalledWith(true);
  });

  it("paused-for-cache -> buffering {isBuffering} in order", () => {
    fireProperty("paused-for-cache", true);
    fireProperty("paused-for-cache", false);
    expect(emitted("buffering")).toEqual([
      { isBuffering: true },
      { isBuffering: false },
    ]);
  });

  it("demuxer-cache-state -> progress + getBuffered() exposes the seekable ranges as TimeRanges", () => {
    fireProperty("duration", 180);

    fireProperty("demuxer-cache-state", {
      "seekable-ranges": [
        { start: 0, end: 30 },
        { start: 40, end: 60 },
      ],
    });

    expect(emitted("progress")).toEqual([undefined]);
    const buffered = ctrl.getBuffered();
    expect(buffered.duration).toBe(180);
    expect(buffered.currentTime).toBe(0);
    expect(buffered.buffered.length).toBe(2);
    expect(buffered.buffered.start(0)).toBe(0);
    expect(buffered.buffered.end(0)).toBe(30);
    expect(buffered.buffered.start(1)).toBe(40);
    expect(buffered.buffered.end(1)).toBe(60);
  });

  it("demuxer-cache-state without seekable-ranges (or malformed entries) yields an empty buffered list, no crash", () => {
    fireProperty("demuxer-cache-state", null);
    fireProperty("demuxer-cache-state", {});
    fireProperty("demuxer-cache-state", {
      "seekable-ranges": [{ start: "x", end: 5 }, 7],
    });
    expect(ctrl.getBuffered().buffered.length).toBe(0);
    expect(emitted("progress").length).toBeGreaterThan(0);
  });

  it("null property data (initial observe report from mpv) is ignored without emitting", () => {
    fireProperty("time-pos", null);
    fireProperty("duration", null);
    fireProperty("pause", null);
    fireProperty("paused-for-cache", null);
    expect(events).toEqual([]);
    expect(storeMocks.setIsPlaying).not.toHaveBeenCalled();
  });

  it("unobserved property names and malformed payloads are skipped", () => {
    fireProperty("eof-reached", true);
    fireTauri("mpv-property", { data: 1 });
    expect(events).toEqual([]);
  });
});

describe("MpvAudioController — mpv-event mapping", () => {
  let ctrl: MpvAudioController;
  const ended = vi.fn();
  const error = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    vi.mocked(captureError).mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
    await ctrl.playTrack(trackA); // attach listeners + load a track
    tauriMocks.invoke.mockClear();
    ended.mockClear();
    error.mockClear();
    ctrl.on("ended", ended);
    ctrl.on("error", error);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("end-file reason=eof -> ended exactly once per event", () => {
    fireMpvEvent("end-file", "eof");
    expect(ended).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("end-file reason=error -> error(format_error), NO ended (plan 2.3 contract)", () => {
    fireMpvEvent("end-file", "error");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ code: "format_error" }),
    );
    expect(ended).not.toHaveBeenCalled();
  });

  it("playTrack(track, 120) applies the deferred seek when file-loaded arrives — once", async () => {
    // beforeEach already loaded trackA — use trackB to hit the full load path.
    await ctrl.playTrack(trackB, 120);
    tauriMocks.invoke.mockClear();

    fireMpvEvent("file-loaded");
    expect(mpvCommands()).toEqual([["seek", "120", "absolute"]]);

    fireMpvEvent("file-loaded");
    expect(mpvCommands()).toHaveLength(1);
  });

  it("pending seek is cleared when the next playTrack has no startTime", async () => {
    await ctrl.playTrack(trackB, 120);
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    fireMpvEvent("file-loaded");
    fireMpvEvent("file-loaded");
    expect(mpvCommands()).toEqual([]);
  });

  it("unrelated mpv events (start-file, playback-restart) are ignored", () => {
    fireMpvEvent("start-file");
    fireMpvEvent("playback-restart");
    expect(ended).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("MpvAudioController — volume & mute (facade 0..1 -> mpv 0..100)", () => {
  let ctrl: MpvAudioController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    vi.mocked(captureError).mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("setVolume before any playback only stores — no spawn, no command; applied after spawn", async () => {
    ctrl.setVolume(0.5);
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    expect(ctrl.getVolume()).toBe(0.5);

    await ctrl.playTrack(trackA);
    expect(mpvCommands()).toContainEqual(["set_property", "volume", "50"]);
  });

  it("setVolume clamps to 0..1 and sends vol*100 while running", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    ctrl.setVolume(2);
    expect(ctrl.getVolume()).toBe(1);
    ctrl.setVolume(-1);
    expect(ctrl.getVolume()).toBe(0);
    ctrl.setVolume(0.29);
    expect(mpvCommands()).toEqual([
      ["set_property", "volume", "100"],
      ["set_property", "volume", "0"],
      ["set_property", "volume", "29"],
    ]);
  });

  it("toggleMute sends volume 0 and remembers; unmute restores the stored volume", async () => {
    ctrl.setVolume(0.5);
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    expect(ctrl.toggleMute()).toBe(true);
    expect(ctrl.isMuted()).toBe(true);
    expect(mpvCommands()).toEqual([["set_property", "volume", "0"]]);

    tauriMocks.invoke.mockClear();
    ctrl.setVolume(0.8);
    expect(ctrl.getVolume()).toBe(0.8);
    expect(mpvCommands()).toEqual([]);

    tauriMocks.invoke.mockClear();
    expect(ctrl.toggleMute()).toBe(false);
    expect(ctrl.isMuted()).toBe(false);
    expect(mpvCommands()).toEqual([["set_property", "volume", "80"]]);
  });

  it("toggleMute before any playback works without spawning mpv", () => {
    expect(ctrl.toggleMute()).toBe(true);
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });
});

describe("MpvAudioController — transport", () => {
  let ctrl: MpvAudioController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    vi.mocked(captureError).mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("seek(42) -> [seek, 42, absolute]", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    ctrl.seek(42);
    expect(mpvCommands()).toEqual([["seek", "42", "absolute"]]);
  });

  it("seek with no track loaded logs a warn and sends nothing (no spawn)", () => {
    ctrl.seek(30);
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "MpvAudioController" }),
    );
  });

  it("togglePlay: no track is a no-op; paused resumes; playing pauses", async () => {
    ctrl.togglePlay();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();

    await ctrl.playTrack(trackA);
    fireProperty("pause", true);
    tauriMocks.invoke.mockClear();

    ctrl.togglePlay();
    expect(mpvCommands()).toEqual([["set_property", "pause", "no"]]);

    fireProperty("pause", false);
    tauriMocks.invoke.mockClear();
    ctrl.togglePlay();
    expect(mpvCommands()).toEqual([["set_property", "pause", "yes"]]);
  });

  it("togglePlay after end-file restarts the track (mirrors play() on an ended element)", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("end-file", "eof");
    tauriMocks.invoke.mockClear();

    ctrl.togglePlay();
    // togglePlay routes through the async playTrack path — flush microtasks
    // before asserting the recorded commands.
    await vi.advanceTimersByTimeAsync(0);
    expect(mpvCommands()).toEqual([
      ["loadfile", `${PROXY_URL_PREFIX}A`, "replace"],
    ]);
  });
});

describe("MpvAudioController — release lifecycle", () => {
  let ctrl: MpvAudioController;
  const timeupdate = vi.fn();
  const ended = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    vi.mocked(captureError).mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
    timeupdate.mockClear();
    ended.mockClear();
    ctrl.on("timeupdate", timeupdate);
    ctrl.on("ended", ended);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("release() invokes mpv_shutdown and unhooks every listener (no leak)", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    ctrl.release();

    expect(commandNames()).toEqual(["mpv_shutdown"]);
    fireProperty("time-pos", 5);
    fireMpvEvent("end-file", "eof");
    expect(timeupdate).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });

  it("playTrack after release re-spawns mpv and re-starts the proxy", async () => {
    await ctrl.playTrack(trackA);
    ctrl.release();
    tauriMocks.invoke.mockClear();

    await ctrl.playTrack(trackB);

    expect(commandNames().filter((n) => n !== "mpv_command")).toEqual([
      "mpv_spawn",
      "stream_proxy_start",
    ]);
    expect(mpvCommands()).toEqual([
      ["set_property", "volume", "100"],
      ["loadfile", `${PROXY_URL_PREFIX}B`, "replace"],
    ]);
  });

  it("release before anything started is safe (shutdown is a Rust-side no-op)", () => {
    expect(() => {
      ctrl.release();
    }).not.toThrow();
    expect(commandNames()).toEqual(["mpv_shutdown"]);
  });

  it("fresh engine reports an empty buffered list and zero clocks", () => {
    expect(ctrl.getCurrentTime()).toBe(0);
    expect(ctrl.getDuration()).toBe(0);
    const buffered = ctrl.getBuffered();
    expect(buffered.duration).toBe(0);
    expect(buffered.currentTime).toBe(0);
    expect(buffered.buffered.length).toBe(0);
  });
});
