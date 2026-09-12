import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
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
import { captureError } from "../utils/errorLog";
import { resetWarnThrottleForTest } from "./mpvProtocol";

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

  it("paused-for-cache -> buffering {isBuffering} in order (sustained stall passes the delay)", () => {
    // playTrack arms a pending request — settle it via two ticks so this test
    // asserts only the genuine mpv stall path (transition true->false).
    fireProperty("time-pos", 0.5);
    fireProperty("time-pos", 1);
    events.length = 0;

    fireProperty("paused-for-cache", true);
    expect(emitted("buffering")).toEqual([]); // not yet — stall unconfirmed

    vi.advanceTimersByTime(250); // stall sustained -> shown
    fireProperty("paused-for-cache", false); // stall over -> settle
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

describe("MpvAudioController — buffering spinner (display-delay v2)", () => {
  let ctrl: MpvAudioController;
  let buffering: Array<{ isBuffering: boolean }>;

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
    buffering = [];
    // Subscribe BEFORE any playTrack — request() fires inside playTrack/seek.
    ctrl.on("buffering", (payload) => {
      buffering.push(payload);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Two time-pos ticks inside the window = playback truly progressing. */
  function settleViaTicks(): void {
    fireProperty("time-pos", 0.5);
    fireProperty("time-pos", 1);
  }

  it("new playTrack: NO immediate emit — true only after the 250ms display delay", async () => {
    await ctrl.playTrack(trackA);
    expect(buffering).toEqual([]);

    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([{ isBuffering: true }]);
  });

  it("load settled inside the delay window never emits true (in-buffer anti-flash)", async () => {
    await ctrl.playTrack(trackA);
    settleViaTicks();
    expect(buffering).toEqual([]);

    vi.advanceTimersByTime(8000);
    expect(buffering).toEqual([]);
  });

  it("shown spinner settles on the 2nd time-pos tick within 1s — false exactly once", async () => {
    await ctrl.playTrack(trackA);
    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([{ isBuffering: true }]);

    fireProperty("time-pos", 1); // tick 1 — mpv may still be stalling
    expect(buffering).toEqual([{ isBuffering: true }]);
    fireProperty("time-pos", 2); // tick 2 within 1s — playback progressing
    expect(buffering).toEqual([{ isBuffering: true }, { isBuffering: false }]);

    fireProperty("time-pos", 3);
    expect(buffering).toHaveLength(2); // dedupe: no duplicate false
  });

  it("seek: pending only — no immediate emit, command still sent", async () => {
    await ctrl.playTrack(trackA);
    settleViaTicks();
    buffering.length = 0;
    tauriMocks.invoke.mockClear();

    ctrl.seek(42);
    expect(buffering).toEqual([]);
    expect(mpvCommands()).toEqual([["seek", "42", "absolute"]]);
  });

  it("seek outside buffer: true at exactly ~250ms, held until ticks settle -> false once", async () => {
    await ctrl.playTrack(trackA);
    settleViaTicks();
    buffering.length = 0;

    ctrl.seek(120);
    vi.advanceTimersByTime(249);
    expect(buffering).toEqual([]); // 1ms before the delay elapses
    vi.advanceTimersByTime(1);
    expect(buffering).toEqual([{ isBuffering: true }]);

    vi.advanceTimersByTime(150);
    fireProperty("time-pos", 120); // tick 1 (stalled position report)
    fireProperty("time-pos", 120.5); // tick 2 — actually playing again
    expect(buffering).toEqual([{ isBuffering: true }, { isBuffering: false }]);
  });

  it("seek into an already-cached range with fast ticks never flashes", async () => {
    await ctrl.playTrack(trackA);
    settleViaTicks();
    fireProperty("demuxer-cache-state", {
      "seekable-ranges": [{ start: 0, end: 180 }],
    });
    buffering.length = 0;

    ctrl.seek(60);
    fireProperty("time-pos", 60);
    fireProperty("time-pos", 60.5);
    expect(buffering).toEqual([]);

    vi.advanceTimersByTime(8000);
    expect(buffering).toEqual([]);
  });

  it("playTrack with startTime: file-loaded no longer force-clears; ticks settle after delay", async () => {
    await ctrl.playTrack(trackB, 120);
    expect(buffering).toEqual([]); // pending — no immediate emit

    fireMpvEvent("file-loaded");
    expect(mpvCommands()).toContainEqual(["seek", "120", "absolute"]);
    expect(buffering).toEqual([]); // spinner survives the deferred seek

    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([{ isBuffering: true }]);
    fireProperty("time-pos", 120);
    fireProperty("time-pos", 121);
    expect(buffering).toEqual([{ isBuffering: true }, { isBuffering: false }]);
  });

  it("same-track resume + togglePlay never request (no pending, no events)", async () => {
    await ctrl.playTrack(trackA);
    settleViaTicks();
    buffering.length = 0;
    fireProperty("pause", true);
    tauriMocks.invoke.mockClear();

    await ctrl.playTrack(trackA); // resume path — no request
    ctrl.togglePlay(); // pause again — still no request
    vi.advanceTimersByTime(8000);
    expect(buffering).toEqual([]);
  });

  it("paused-for-cache=true sustained >250ms shows without waiting for more ticks", async () => {
    await ctrl.playTrack(trackA); // pending
    fireProperty("paused-for-cache", true); // genuine stall report
    expect(buffering).toEqual([]); // not before the sustain window

    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([{ isBuffering: true }]);
  });

  it("paused-for-cache=true while shown extends the net instead of duplicating", async () => {
    await ctrl.playTrack(trackA);
    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([{ isBuffering: true }]);

    fireProperty("paused-for-cache", true); // stall ongoing while shown
    vi.advanceTimersByTime(7999); // original net would have fired here
    expect(buffering).toEqual([{ isBuffering: true }]);
    vi.advanceTimersByTime(1);
    expect(buffering).toEqual([{ isBuffering: true }, { isBuffering: false }]);
  });

  it("paused-for-cache=false while idle emits nothing; repeat true does not double-arm", async () => {
    await ctrl.playTrack(trackA);
    settleViaTicks();
    buffering.length = 0;

    fireProperty("paused-for-cache", false);
    expect(buffering).toEqual([]);

    fireProperty("paused-for-cache", true);
    fireProperty("paused-for-cache", true); // second report — no extra timer
    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([{ isBuffering: true }]);
    fireProperty("paused-for-cache", false);
    expect(buffering).toEqual([{ isBuffering: true }, { isBuffering: false }]);
  });

  it("safety net: shown auto-settles 8s after request", async () => {
    await ctrl.playTrack(trackA);
    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([{ isBuffering: true }]);

    vi.advanceTimersByTime(7750); // 8000ms total from request
    expect(buffering).toEqual([{ isBuffering: true }, { isBuffering: false }]);
  });

  it("request while shown keeps the spinner (no duplicate emit) and re-arms the net", async () => {
    await ctrl.playTrack(trackA);
    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([{ isBuffering: true }]);
    vi.advanceTimersByTime(7000);

    await ctrl.playTrack(trackB); // new track mid-stall
    expect(buffering).toEqual([{ isBuffering: true }]); // no duplicate true

    vi.advanceTimersByTime(7999); // re-armed net not yet fired
    expect(buffering).toEqual([{ isBuffering: true }]);
    vi.advanceTimersByTime(1);
    expect(buffering).toEqual([{ isBuffering: true }, { isBuffering: false }]);
  });

  it("timers are cleaned up: request re-arms (no stacking), settle drains, release cancels", async () => {
    await ctrl.playTrack(trackA);
    settleViaTicks();
    expect(vi.getTimerCount()).toBe(0); // settle drained everything

    ctrl.seek(10);
    expect(vi.getTimerCount()).toBe(2); // display + deadline
    ctrl.seek(20); // re-request — must not stack
    expect(vi.getTimerCount()).toBe(2);
    fireProperty("time-pos", 20);
    fireProperty("time-pos", 20.5);
    expect(vi.getTimerCount()).toBe(0); // settled
    expect(buffering).toEqual([]); // never shown

    ctrl.seek(30);
    expect(vi.getTimerCount()).toBe(2);
    ctrl.release();
    expect(vi.getTimerCount()).toBe(0); // release cancelled silently
    vi.advanceTimersByTime(9000);
    expect(buffering).toEqual([]);
  });
});

describe("MpvAudioController — time-pos watchdog (push-stall backfill, mpv #13695)", () => {
  let ctrl: MpvAudioController;
  let events: { name: string; payload: unknown }[];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    // Mirror the real store: setIsPlaying flips the isPlaying the watchdog reads.
    storeMocks.setIsPlaying.mockImplementation(
      (playing: boolean | ((prev: boolean) => boolean)) => {
        storeMocks.isPlaying =
          typeof playing === "function"
            ? playing(storeMocks.isPlaying)
            : playing;
      },
    );
    storeMocks.isPlaying = false;
    resetWarnThrottleForTest(); // module-level warn rate limit: isolate per test
    vi.mocked(captureError).mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
    events = [];
    for (const name of ["timeupdate", "buffering", "play", "pause"] as const) {
      ctrl.on(name, (payload) => {
        events.push({ name, payload });
      });
    }
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function emitted(name: string): unknown[] {
    return events.filter((e) => e.name === name).map((e) => e.payload);
  }

  it("push stall >1.2s while playing: polls mpv_get_property and backfills through the real onTimeUpdate path", async () => {
    fireProperty("pause", false); // engine path that flips store isPlaying -> true
    expect(storeMocks.isPlaying).toBe(true);
    tauriMocks.invoke.mockImplementation((command: string) =>
      command === "mpv_get_property"
        ? Promise.resolve(90)
        : command === "stream_proxy_start"
          ? Promise.resolve(PROXY_PORT)
          : Promise.resolve(undefined),
    );

    // No time-pos pushes at all — the mpv #13695 nil window.
    await vi.advanceTimersByTimeAsync(1000);
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
      "mpv_get_property",
      expect.anything(),
    );
    await vi.advanceTimersByTimeAsync(1000);

    expect(tauriMocks.invoke).toHaveBeenCalledWith("mpv_get_property", {
      prop: "time-pos",
    });
    // Backfill goes through onTimeUpdate: clock + throttle emit + tick.
    expect(ctrl.getCurrentTime()).toBe(90);
    expect(emitted("timeupdate")).toEqual([{ currentTime: 90, duration: 0 }]);
  });

  it("regular pushes keep the watchdog quiet (no mpv_get_property)", async () => {
    fireProperty("pause", false);
    tauriMocks.invoke.mockClear();

    for (let i = 0; i < 8; i++) {
      fireProperty("time-pos", i);
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
      "mpv_get_property",
      expect.anything(),
    );
  });

  it("paused (isPlaying=false): watchdog never polls", async () => {
    fireProperty("pause", true);
    expect(storeMocks.isPlaying).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);

    expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
      "mpv_get_property",
      expect.anything(),
    );
  });

  it("release() cancels the watchdog interval (no timer leak)", async () => {
    fireProperty("pause", false);
    tauriMocks.invoke.mockClear();

    ctrl.release();
    await vi.advanceTimersByTimeAsync(5000);

    expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
      "mpv_get_property",
      expect.anything(),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("nil poll result during the seek window: skipped round, rate-limited warn from mpvProtocol, no timeupdate", async () => {
    fireProperty("pause", false);
    tauriMocks.invoke.mockImplementation((command: string) =>
      command === "mpv_get_property"
        ? Promise.resolve(null)
        : command === "stream_proxy_start"
          ? Promise.resolve(PROXY_PORT)
          : Promise.resolve(undefined),
    );

    await vi.advanceTimersByTimeAsync(2 * 1200);

    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "mpvProtocol" }),
    );
    expect(emitted("timeupdate")).toEqual([]);
    expect(ctrl.getCurrentTime()).toBe(0);
  });
});

describe("MpvAudioController — engine time interpolator (push-gap clock)", () => {
  let ctrl: MpvAudioController;
  let timeupdates: { currentTime: number; duration: number }[];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    // Mirror the real store: setIsPlaying flips the isPlaying the interpolator reads.
    storeMocks.setIsPlaying.mockImplementation(
      (playing: boolean | ((prev: boolean) => boolean)) => {
        storeMocks.isPlaying =
          typeof playing === "function"
            ? playing(storeMocks.isPlaying)
            : playing;
      },
    );
    storeMocks.isPlaying = false;
    vi.mocked(captureError).mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
    await ctrl.playTrack(trackA);
    timeupdates = [];
    ctrl.on("timeupdate", (payload) => timeupdates.push(payload));
    tauriMocks.invoke.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("push gap while playing: interpolated timeupdates fill the silence (0:00 -> 0:03 fix)", async () => {
    fireProperty("pause", false); // playing — interpolation armed
    fireProperty("time-pos", 0.2); // the only real push, then mpv goes quiet
    timeupdates.length = 0;

    await vi.advanceTimersByTimeAsync(3000);

    const filled = timeupdates.filter(
      (p) => p.currentTime > 0.5 && p.currentTime < 2.5,
    );
    expect(filled.length).toBeGreaterThanOrEqual(1);
    let prev = 0.2;
    for (const p of timeupdates) {
      expect(p.currentTime).toBeGreaterThan(prev);
      prev = p.currentTime;
    }
  });

  it("pause(true) mid-interpolation: synthetic emits stop immediately", async () => {
    fireProperty("pause", false);
    fireProperty("time-pos", 1);
    await vi.advanceTimersByTimeAsync(300);
    // Real push emit + at least one interpolated emit while playing.
    expect(timeupdates.length).toBeGreaterThanOrEqual(2);

    fireProperty("pause", true);
    timeupdates.length = 0;
    await vi.advanceTimersByTimeAsync(2000);
    expect(timeupdates).toEqual([]);
  });

  it("track change: before the new track's first real push, nothing interpolates from the old clock", async () => {
    fireProperty("pause", false);
    fireProperty("time-pos", 50);
    await vi.advanceTimersByTimeAsync(300);

    await ctrl.playTrack(trackB); // beginTrack resets the interpolation base
    fireProperty("pause", false); // mpv playing again — still no real time-pos
    timeupdates.length = 0;

    await vi.advanceTimersByTimeAsync(2000);
    expect(timeupdates).toEqual([]);
  });

  it("dense real pushes (<250ms apart): no synthetic emits — timeupdate frequency unchanged", async () => {
    fireProperty("pause", false);
    timeupdates.length = 0;

    for (let i = 0; i < 15; i++) {
      fireProperty("time-pos", i * 0.2);
      await vi.advanceTimersByTimeAsync(200);
    }

    // Every emission must carry a real pushed value (no synthetic drift).
    const realValues = new Set(Array.from({ length: 15 }, (_, i) => i * 0.2));
    expect(timeupdates.length).toBeGreaterThan(0);
    for (const p of timeupdates) {
      expect(realValues.has(p.currentTime)).toBe(true);
    }
  });

  it("watchdog backfill during the gap resyncs the interpolation base (truth wins)", async () => {
    fireProperty("pause", false);
    fireProperty("time-pos", 0.2);
    timeupdates.length = 0;
    tauriMocks.invoke.mockImplementation((command: string) =>
      command === "mpv_get_property"
        ? Promise.resolve(1.9)
        : command === "stream_proxy_start"
          ? Promise.resolve(PROXY_PORT)
          : Promise.resolve(undefined),
    );

    await vi.advanceTimersByTimeAsync(2250); // gap: interpolation + watchdog poll

    const values = timeupdates.map((p) => p.currentTime);
    const last = values[values.length - 1] ?? Number.NaN;
    // Interpolation continues from the watchdog truth (1.9), not the drifted clock.
    expect(last).toBeGreaterThan(1.9);
    expect(last).toBeLessThan(2.2);
  });
});
