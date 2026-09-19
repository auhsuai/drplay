import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../types";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriMocks.listen }));

vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));

import { MpvAudioController } from "./mpvAudio";
import { captureError } from "../utils/errorLog";
import {
  BufferingTracker,
  LOADFILE_DEADLINE_MS,
  resetWarnThrottleForTest,
  TimePosWatchdog,
} from "./mpvProtocol";

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

function fireMpvEvent(
  event: string,
  reason: string | null = null,
  error: string | null = null,
): void {
  fireTauri("mpv-event", { event, reason, error });
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
      // H2 fix: a fresh load always clears mpv's process-global pause flag.
      ["set_property", "pause", "no"],
    ]);
  });

  it("second playTrack: port cached and mpv NOT respawned — only the loadfile command", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    await ctrl.playTrack(trackB);

    expect(commandNames()).toEqual(["mpv_command", "mpv_command"]);
    expect(mpvCommands()).toEqual([
      ["loadfile", `${PROXY_URL_PREFIX}B`, "replace"],
      ["set_property", "pause", "no"],
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
      ["set_property", "pause", "no"],
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

  it("playTrack failure (mpv_command rejects) does not crash: logs and emits the terminal error fact", async () => {
    const errors: unknown[] = [];
    ctrl.on("error", (payload) => errors.push(payload));
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
    // R3.2: isPlaying=false is now the adapter's projection of this fact.
    expect(errors).toEqual([
      expect.objectContaining({
        code: "network_interrupted",
        trackId: "A",
      }),
    ]);
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
    // R3.2: a freshly loaded track is rolling engine-side, so the synthetic
    // interpolator is armed — park paused to assert the REAL-push throttle
    // in isolation (interpolation has its own suite below).
    fireProperty("pause", true);
    fireProperty("duration", 180);

    fireProperty("time-pos", 12);
    expect(emitted("timeupdate")).toEqual([
      { trackId: "A", attempt: 1, currentTime: 12, duration: 180 },
    ]);

    fireProperty("time-pos", 12.5);
    expect(emitted("timeupdate")).toHaveLength(1);

    vi.advanceTimersByTime(250);
    fireProperty("time-pos", 13);
    expect(emitted("timeupdate")).toEqual([
      { trackId: "A", attempt: 1, currentTime: 12, duration: 180 },
      { trackId: "A", attempt: 1, currentTime: 13, duration: 180 },
    ]);
  });

  it("duration -> durationchange {duration} + getDuration()", () => {
    fireProperty("duration", 180);
    expect(emitted("durationchange")).toEqual([
      { trackId: "A", attempt: 1, duration: 180 },
    ]);
    expect(ctrl.getDuration()).toBe(180);
  });

  it("pause=true -> pause event; pause=false -> play event", () => {
    fireProperty("pause", true);
    expect(emitted("pause")).toEqual([{ trackId: "A", attempt: 1 }]);

    fireProperty("pause", false);
    expect(emitted("play")).toEqual([{ trackId: "A", attempt: 1 }]);
    // R3.2: the store projection of these facts lives in the policy adapter
    // (usePlayerPlaybackPolicy.test.ts) — the engine only emits.
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
      { trackId: "A", attempt: 1, isBuffering: true },
      { trackId: "A", attempt: 1, isBuffering: false },
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

    expect(emitted("progress")).toEqual([{ trackId: "A", attempt: 1 }]);
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

  it("end-file reason=error -> error(format_error) then ended, once each and in order (old web-engine parity)", () => {
    const order: string[] = [];
    ctrl.on("error", () => order.push("error"));
    ctrl.on("ended", () => order.push("ended"));

    fireMpvEvent("end-file", "error");

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ code: "format_error" }),
    );
    expect(ended).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["error", "ended"]);
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

describe("MpvAudioController — end-file error kind + engine closed (R02-1/R02-2)", () => {
  let ctrl: MpvAudioController;
  let events: { name: string; payload: unknown }[];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    vi.mocked(captureError).mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
    events = [];
    for (const name of ["ended", "error", "timeupdate"] as const) {
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

  function fireProxyError(fileId: string, status: number): void {
    fireTauri("stream-proxy-error", { fileId, status });
  }

  it("the engine subscribes to stream-proxy-error on start (R04 event contract)", () => {
    expect(tauriMocks.listen).toHaveBeenCalledWith(
      "stream-proxy-error",
      expect.any(Function),
    );
  });

  it("end-file error with proxy 503 -> network_interrupted, no ended, no broken mark", () => {
    fireProxyError("A", 503);
    fireMpvEvent("end-file", "error", "loading failed");

    expect(emitted("error")).toEqual([
      expect.objectContaining({ code: "network_interrupted" }),
    ]);
    expect(emitted("ended")).toEqual([]);
  });

  it("proxy 429 (rate limit) -> network_interrupted (retryable)", () => {
    fireProxyError("A", 429);
    fireMpvEvent("end-file", "error", "unrecognized file format");

    expect(emitted("error")).toEqual([
      expect.objectContaining({ code: "network_interrupted" }),
    ]);
    expect(emitted("ended")).toEqual([]);
  });

  it("proxy 499 (idle-abort mid-stream) -> network_interrupted, no ended", () => {
    fireProxyError("A", 499);
    fireMpvEvent("end-file", "error", "something happened");

    expect(emitted("error")).toEqual([
      expect.objectContaining({ code: "network_interrupted" }),
    ]);
    expect(emitted("ended")).toEqual([]);
  });

  it("proxy 403 (Drive locked/quota) keeps format_error + ended (storm guard)", () => {
    fireProxyError("A", 403);
    fireMpvEvent("end-file", "error", "loading failed");

    expect(emitted("error")).toEqual([
      expect.objectContaining({ code: "format_error" }),
    ]);
    expect(emitted("ended")).toEqual([{ trackId: "A", attempt: 1 }]);
  });

  it("no proxy event + mpv's short string falls back to the format default (parity)", () => {
    fireMpvEvent("end-file", "error", "loading failed");

    expect(emitted("error")).toEqual([
      expect.objectContaining({ code: "format_error" }),
    ]);
    expect(emitted("ended")).toEqual([{ trackId: "A", attempt: 1 }]);
  });

  it("end-file error without the error field stays format_error (payload parity)", () => {
    fireMpvEvent("end-file", "error");

    expect(emitted("error")).toEqual([
      expect.objectContaining({ code: "format_error" }),
    ]);
    expect(emitted("ended")).toEqual([{ trackId: "A", attempt: 1 }]);
  });

  it("no proxy data: a transport keyword in mpv's string still routes to network (weak fallback)", () => {
    fireMpvEvent("end-file", "error", "Connection reset by peer");

    expect(emitted("error")).toEqual([
      expect.objectContaining({ code: "network_interrupted" }),
    ]);
    expect(emitted("ended")).toEqual([]);
  });

  it("a proxy event alone never surfaces an error (end-file is the single display channel)", () => {
    fireProxyError("A", 503);

    expect(emitted("error")).toEqual([]);
    expect(emitted("ended")).toEqual([]);
  });

  it("a proxy event for another fileId never steers classification", () => {
    fireProxyError("B", 503);
    fireMpvEvent("end-file", "error", "loading failed");

    expect(emitted("error")).toEqual([
      expect.objectContaining({ code: "format_error" }),
    ]);
  });

  it("switching tracks drops the old track's proxy error (no leak into the new stream)", async () => {
    fireProxyError("A", 503);
    await ctrl.playTrack(trackB);
    fireMpvEvent("end-file", "error", "loading failed");

    expect(emitted("error")).toEqual([
      expect.objectContaining({ code: "format_error" }),
    ]);
    expect(emitted("ended")).toEqual([{ trackId: "B", attempt: 2 }]);
  });

  it("ipc-closed: network_interrupted, engine reset, no ended, listeners detached", () => {
    fireMpvEvent("ipc-closed", "eof");

    expect(emitted("error")).toEqual([
      expect.objectContaining({ code: "network_interrupted" }),
    ]);
    expect(emitted("ended")).toEqual([]);

    fireProperty("time-pos", 5);
    expect(emitted("timeupdate")).toEqual([]);
  });

  it("ipc-closed: retry via playTrack respawns mpv and reloads the track", async () => {
    fireMpvEvent("ipc-closed", "eof");
    tauriMocks.invoke.mockClear();

    await ctrl.playTrack(trackA);

    expect(commandNames()).toContain("mpv_spawn");
    expect(mpvCommands()).toContainEqual([
      "loadfile",
      `${PROXY_URL_PREFIX}A`,
      "replace",
    ]);
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

  it("seek after end-file (playbackFinished) is dropped: warn only, no command, no spinner armed", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("end-file", "eof");
    tauriMocks.invoke.mockClear();
    vi.mocked(captureError).mockClear();

    ctrl.seek(30);

    expect(mpvCommands()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "MpvAudioController" }),
    );
    const message = vi.mocked(captureError).mock.calls[0]?.[0]?.message ?? "";
    expect(message).toContain("seek dropped");
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
      ["set_property", "pause", "no"],
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
    // The stream-proxy-error listener dies with the engine too: noteProxyError
    // emits nothing, so the assertions below cannot observe it — check the
    // registered handlers directly instead.
    expect(tauriListeners.get("stream-proxy-error") ?? []).toEqual([]);
    fireTauri("stream-proxy-error", { fileId: "A", status: 503 });
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
      ["set_property", "pause", "no"],
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

  it("new playTrack: immediate promote (S2) — true right away, no spinner gap before first-audio", async () => {
    await ctrl.playTrack(trackA);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
    ]);

    vi.advanceTimersByTime(250); // no duplicate from a display-delay timer
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
    ]);
  });

  it("load settled right after playTrack: immediate true then tick-settle — false exactly once", async () => {
    await ctrl.playTrack(trackA);
    settleViaTicks();
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
      { isBuffering: false, trackId: "A", attempt: 1 },
    ]);

    vi.advanceTimersByTime(8000);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
      { isBuffering: false, trackId: "A", attempt: 1 },
    ]);
  });

  it("shown spinner settles on the 2nd time-pos tick within 1s — false exactly once", async () => {
    await ctrl.playTrack(trackA);
    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
    ]);

    fireProperty("time-pos", 1); // tick 1 — mpv may still be stalling
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
    ]);
    fireProperty("time-pos", 2); // tick 2 within 1s — playback progressing
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
      { isBuffering: false, trackId: "A", attempt: 1 },
    ]);

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
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
    ]);

    vi.advanceTimersByTime(150);
    fireProperty("time-pos", 120); // tick 1 (stalled position report)
    fireProperty("time-pos", 120.5); // tick 2 — actually playing again
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
      { isBuffering: false, trackId: "A", attempt: 1 },
    ]);
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

  it("playTrack with startTime: spinner already shown (v3); the deferred seek keeps it and ticks settle", async () => {
    await ctrl.playTrack(trackB, 120);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "B", attempt: 1 },
    ]); // v3: immediate promote

    fireMpvEvent("file-loaded");
    expect(mpvCommands()).toContainEqual(["seek", "120", "absolute"]);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "B", attempt: 1 },
    ]); // shown dedupe on the deferred seek

    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "B", attempt: 1 },
    ]);
    fireProperty("time-pos", 120);
    fireProperty("time-pos", 121);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "B", attempt: 1 },
      { isBuffering: false, trackId: "B", attempt: 1 },
    ]);
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

  it("paused-for-cache=true while already shown (v3 immediate promote) re-arms without a duplicate", async () => {
    await ctrl.playTrack(trackA); // v3: already shown at playTrack
    fireProperty("paused-for-cache", true); // genuine stall report
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
    ]);

    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
    ]); // no duplicate true
  });

  it("paused-for-cache=true while shown re-arms the net instead of settling (v4 spin-hold)", async () => {
    await ctrl.playTrack(trackA);
    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
    ]);

    fireProperty("paused-for-cache", true); // stall ongoing while shown
    vi.advanceTimersByTime(8000); // v4: net fires -> re-arms, spinner holds
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
    ]);

    fireProperty("paused-for-cache", false); // stall over -> the only settle
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
      { isBuffering: false, trackId: "A", attempt: 1 },
    ]);
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
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
    ]);
    fireProperty("paused-for-cache", false);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
      { isBuffering: false, trackId: "A", attempt: 1 },
    ]);
  });

  it("safety net: shown auto-settles 8s after request", async () => {
    await ctrl.playTrack(trackA);
    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
    ]);

    vi.advanceTimersByTime(7750); // 8000ms total from request
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
      { isBuffering: false, trackId: "A", attempt: 1 },
    ]);
  });

  it("switch mid-stall: resetForTrack drops A's session, B promotes fresh and re-arms its own net", async () => {
    await ctrl.playTrack(trackA);
    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
    ]);
    vi.advanceTimersByTime(7000);

    await ctrl.playTrack(trackB); // new track mid-stall
    // A2 (R4): the switch intentionally starts a fresh buffering session for
    // B (resetForTrack is silent, then B's own request(true) promotes) — the
    // spinner stays visible; the extra true is B's session, not A's sticky one.
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
      { isBuffering: true, trackId: "B", attempt: 2 },
    ]);

    vi.advanceTimersByTime(7999); // B's re-armed net not yet fired
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
      { isBuffering: true, trackId: "B", attempt: 2 },
    ]);
    vi.advanceTimersByTime(1);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
      { isBuffering: true, trackId: "B", attempt: 2 },
      { isBuffering: false, trackId: "B", attempt: 2 },
    ]);
  });

  it("timers are cleaned up: seek arms display+deadline+failsafe, settle drains, release cancels", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("file-loaded"); // the load completed — clears the load deadline
    settleViaTicks();
    // R3.2: a loaded track is rolling engine-side, so the backfill machines are
    // armed. Park it paused (real user path) to isolate the seek/display timers.
    fireProperty("pause", true);
    expect(vi.getTimerCount()).toBe(0); // settle drained everything

    ctrl.seek(10);
    expect(vi.getTimerCount()).toBe(3); // display + deadline + seek failsafe
    ctrl.seek(20); // re-request — must not stack
    expect(vi.getTimerCount()).toBe(3);
    fireProperty("time-pos", 20); // acks seek(20) + tick 1
    fireProperty("time-pos", 20.5); // tick 2 — settles
    expect(vi.getTimerCount()).toBe(0); // settled (ack cleared the failsafe)
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
      { isBuffering: false, trackId: "A", attempt: 1 },
    ]); // v3: shown at playTrack, settled by the ticks

    ctrl.seek(30);
    expect(vi.getTimerCount()).toBe(3);
    ctrl.release();
    expect(vi.getTimerCount()).toBe(0); // release cancelled silently
    vi.advanceTimersByTime(9000);
    expect(buffering).toEqual([
      { isBuffering: true, trackId: "A", attempt: 1 },
      { isBuffering: false, trackId: "A", attempt: 1 },
    ]);
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
    fireProperty("pause", false); // engine play fact — playback is rolling
    expect(emitted("play")).toEqual([{ trackId: "A", attempt: 1 }]);
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
    expect(emitted("timeupdate")).toEqual([
      { trackId: "A", attempt: 1, currentTime: 90, duration: 0 },
    ]);
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

  it("paused: watchdog never polls", async () => {
    fireProperty("pause", true);
    expect(emitted("pause")).toEqual([{ trackId: "A", attempt: 1 }]);

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
    fireProperty("time-pos", 0.2); // real pushes, then mpv goes quiet
    fireProperty("time-pos", 0.4); // 2nd tick confirms playback (settles pending spinner)
    timeupdates.length = 0;

    await vi.advanceTimersByTimeAsync(3000);

    const filled = timeupdates.filter(
      (p) => p.currentTime > 0.5 && p.currentTime < 2.5,
    );
    expect(filled.length).toBeGreaterThanOrEqual(1);
    let prev = 0.4;
    for (const p of timeupdates) {
      expect(p.currentTime).toBeGreaterThan(prev);
      prev = p.currentTime;
    }
  });

  it("pause(true) mid-interpolation: synthetic emits stop immediately", async () => {
    fireProperty("pause", false);
    fireProperty("time-pos", 1);
    fireProperty("time-pos", 1.2); // 2nd tick confirms playback (settles pending spinner)
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
    fireProperty("time-pos", 0.4); // 2nd tick confirms playback (settles pending spinner)
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

  it("buffering shown mid-track: synthetic clock freezes until truth returns", async () => {
    fireProperty("pause", false);
    fireProperty("time-pos", 111);
    fireProperty("time-pos", 111.5); // settle the playTrack pending
    timeupdates.length = 0;

    fireProperty("paused-for-cache", true); // genuine mpv stall
    await vi.advanceTimersByTimeAsync(300); // sustain window -> shown
    timeupdates.length = 0;

    await vi.advanceTimersByTimeAsync(2000); // stall with no real push
    expect(timeupdates).toEqual([]);
  });

  it("buffering settle: resumes from new truth without the stalled wall-time jump", async () => {
    fireProperty("pause", false);
    fireProperty("time-pos", 111);
    fireProperty("time-pos", 111.5);
    timeupdates.length = 0;

    fireProperty("paused-for-cache", true);
    await vi.advanceTimersByTimeAsync(300);
    timeupdates.length = 0;
    await vi.advanceTimersByTimeAsync(5000); // long stall — stays frozen
    expect(timeupdates).toEqual([]);

    // mpv reports the stall over (v4 settle signal), then truth returns:
    // report(false) settles the spinner exactly once.
    fireProperty("paused-for-cache", false);
    fireProperty("time-pos", 112);
    await vi.advanceTimersByTimeAsync(250);
    fireProperty("time-pos", 112.5);
    const settled = timeupdates.map((p) => p.currentTime);
    expect(settled).toContain(112);
    expect(settled).toContain(112.5);

    timeupdates.length = 0;
    await vi.advanceTimersByTimeAsync(500);
    // Continues from 112.5 truth — never pays out the 5s stall as a jump.
    for (const p of timeupdates) {
      expect(p.currentTime - 112.5).toBeLessThan(1);
    }
  });
});

describe("MpvAudioController — lifecycle guard: onPauseChange (R3) + beginTrack invalidation (R2)", () => {
  let ctrl: MpvAudioController;
  let facts: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    resetWarnThrottleForTest();
    vi.mocked(captureError).mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
    // R3.2: the store projection moved to the policy adapter — the engine
    // suite now locks the emitted facts (play/pause) and the machine timers.
    facts = [];
    ctrl.on("play", () => facts.push("play"));
    ctrl.on("pause", () => facts.push("pause"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Parks playTrack after spawn (listeners live, no track yet) on a deferred
   * proxy-port reply — the exact window where mpv's initial `pause=false`
   * observe lands with currentTrackId still null.
   */
  async function parkBeforeFirstLoad(): Promise<() => Promise<void>> {
    let releasePort: (port: number) => void = () => {};
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "stream_proxy_start") {
        return new Promise<number>((resolve) => {
          releasePort = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const play = ctrl.playTrack(trackA);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(tauriListeners.get("mpv-property") ?? []).toHaveLength(1);
    return async () => {
      releasePort(PROXY_PORT);
      await play;
    };
  }

  it("spawn initial observe (currentTrackId=null): pause=false emits no fact and arms no timer", async () => {
    const finishLoad = await parkBeforeFirstLoad();
    // Parked proxy reply = its D8 bound timer is armed — sample the baseline
    // so the assertion still means "the pause event added no timer".
    const timersWhileParked = vi.getTimerCount();

    fireProperty("pause", false);

    expect(facts).toEqual([]);
    expect(vi.getTimerCount()).toBe(timersWhileParked);

    await finishLoad();
  });

  it("pause=true while no active track: no fact, timer cleanup stays idempotent", async () => {
    const finishLoad = await parkBeforeFirstLoad();
    const timersWhileParked = vi.getTimerCount();

    fireProperty("pause", true);

    expect(facts).toEqual([]);
    expect(vi.getTimerCount()).toBe(timersWhileParked);

    await finishLoad();
  });

  it("active track: pause=false -> play fact + 3 timers; pause=true -> pause fact + 0 timers", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("file-loaded"); // the load completed — clears the load deadline
    fireProperty("time-pos", 0.5);
    fireProperty("time-pos", 1); // two changed ticks settle the playTrack spinner
    // Park at a known stopped state: a loaded track is already rolling, so the
    // pause push is what disarms the three machines for the count below.
    fireProperty("pause", true);
    expect(facts).toEqual(["pause"]);
    expect(vi.getTimerCount()).toBe(0);

    fireProperty("pause", false);
    expect(facts).toEqual(["pause", "play"]);
    expect(vi.getTimerCount()).toBe(3); // watchdog + reconciler + interpolator

    fireProperty("pause", true);
    expect(facts).toEqual(["pause", "play", "pause"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("active track before file-loaded: pause=false still emits the play fact + arms timers (resume-on-switch)", async () => {
    await ctrl.playTrack(trackA); // loadfile sent, no file-loaded yet
    expect(vi.getTimerCount()).toBe(3); // load deadline + buffering net + interpolator

    fireProperty("pause", false);

    expect(facts).toEqual(["play"]);
    expect(vi.getTimerCount()).toBe(5); // + watchdog + reconciler
  });

  it("finished track (end-file eof): pause=false emits no fact and arms no timer", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("end-file", "eof");
    tauriMocks.invoke.mockClear();

    fireProperty("pause", false);

    expect(facts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("switch A->B: watchdog.stop + buffering.resetForTrack run before the pause-no command", async () => {
    const watchdogStop = vi.spyOn(TimePosWatchdog.prototype, "stop");
    const resetForTrack = vi.spyOn(BufferingTracker.prototype, "resetForTrack");
    await ctrl.playTrack(trackA);
    watchdogStop.mockClear();
    resetForTrack.mockClear();
    tauriMocks.invoke.mockClear();

    await ctrl.playTrack(trackB);

    expect(watchdogStop).toHaveBeenCalled();
    expect(resetForTrack).toHaveBeenCalled();

    const calls = tauriMocks.invoke.mock.calls as unknown as Array<
      [string, Record<string, unknown>?]
    >;
    const pauseIndex = calls.findIndex((call) => {
      const cmd = call[1]?.["cmd"] as string[] | undefined;
      return cmd?.[0] === "set_property" && cmd[1] === "pause";
    });
    expect(pauseIndex).toBeGreaterThanOrEqual(0);
    const pauseOrder =
      tauriMocks.invoke.mock.invocationCallOrder[pauseIndex] ?? 0;
    expect(watchdogStop.mock.invocationCallOrder[0]).toBeLessThan(pauseOrder);
    expect(resetForTrack.mock.invocationCallOrder[0]).toBeLessThan(pauseOrder);
  });

  it("switch A->B while playing: A's watchdog poll never lands after the switch", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("file-loaded");
    fireProperty("pause", false); // active: arms the watchdog for A
    expect(facts).toEqual(["play"]);

    await ctrl.playTrack(trackB); // beginTrack must invalidate A's interval
    tauriMocks.invoke.mockClear();

    await vi.advanceTimersByTimeAsync(3000);

    expect(commandNames()).not.toContain("mpv_get_property");
  });
});

describe("MpvAudioController — engineEpoch stale-event guard (Fix B3)", () => {
  let ctrl: MpvAudioController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // Date.now() off the 0 sentinel
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

  function engineEpochOf(controller: MpvAudioController): number {
    return (controller as unknown as { engineEpoch: number }).engineEpoch;
  }

  /** Every mpv_command resolves with Rust's additive `{ data, load_epoch }`
   *  reply shape; `loadfileReplies` scripts the tag per loadfile, in call
   *  order (non-loadfile replies are ignored by the engine). */
  function attachEpochMocks(loadfileReplies: number[]): void {
    tauriMocks.invoke.mockImplementation(
      (command: string, payload?: Record<string, unknown>) => {
        if (command === "stream_proxy_start") {
          return Promise.resolve(PROXY_PORT);
        }
        if (command === "mpv_command") {
          const cmd = (payload?.["cmd"] as string[] | undefined) ?? [];
          const loadEpoch =
            cmd[0] === "loadfile" ? (loadfileReplies.shift() ?? 0) : 0;
          return Promise.resolve({ data: null, load_epoch: loadEpoch });
        }
        return Promise.resolve(undefined);
      },
    );
  }

  it("stale property event (epoch < engineEpoch) is dropped", async () => {
    attachEpochMocks([1]);
    await ctrl.playTrack(trackA);

    fireTauri("mpv-property", { name: "time-pos", data: 42, epoch: 0 });

    expect(ctrl.getCurrentTime()).toBe(0);
    expect(engineEpochOf(ctrl)).toBe(1);
  });

  it("current property event (epoch === engineEpoch) passes", async () => {
    attachEpochMocks([1]);
    await ctrl.playTrack(trackA);

    fireTauri("mpv-property", { name: "time-pos", data: 42, epoch: 1 });

    expect(ctrl.getCurrentTime()).toBe(42);
  });

  it("stale mpv-event (epoch < engineEpoch) is dropped", async () => {
    attachEpochMocks([1]);
    await ctrl.playTrack(trackA);
    const ended = vi.fn();
    ctrl.on("ended", ended);

    fireTauri("mpv-event", {
      event: "end-file",
      reason: "eof",
      error: null,
      epoch: 0,
    });

    expect(ended).not.toHaveBeenCalled();
    expect(engineEpochOf(ctrl)).toBe(1);
  });

  it("current mpv-event (epoch === engineEpoch) passes", async () => {
    attachEpochMocks([1]);
    await ctrl.playTrack(trackA);
    const ended = vi.fn();
    ctrl.on("ended", ended);

    fireTauri("mpv-event", {
      event: "end-file",
      reason: "eof",
      error: null,
      epoch: 1,
    });

    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("payload without an epoch still passes (compatibility)", async () => {
    attachEpochMocks([1]);
    await ctrl.playTrack(trackA);

    fireProperty("time-pos", 7); // legacy shape: no epoch tag at all
    expect(ctrl.getCurrentTime()).toBe(7);

    const ended = vi.fn();
    ctrl.on("ended", ended);
    fireMpvEvent("end-file", "eof"); // legacy shape: no epoch tag at all
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("noteLoadEpoch raises to the reply's tag and never lowers it (Math.max)", async () => {
    attachEpochMocks([5, 3]);
    await ctrl.playTrack(trackA);
    expect(engineEpochOf(ctrl)).toBe(5);

    await ctrl.playTrack(trackB); // a lower reply tag must not regress the base

    expect(engineEpochOf(ctrl)).toBe(5);
    fireTauri("mpv-property", { name: "time-pos", data: 9, epoch: 4 });
    expect(ctrl.getCurrentTime()).toBe(0);
    fireTauri("mpv-property", { name: "time-pos", data: 9, epoch: 5 });
    expect(ctrl.getCurrentTime()).toBe(9);
  });

  it("a loadfile reply without a numeric tag leaves the base untouched", async () => {
    tauriMocks.invoke.mockImplementation((command: string) =>
      command === "stream_proxy_start"
        ? Promise.resolve(PROXY_PORT)
        : command === "mpv_command"
          ? Promise.resolve({ data: null })
          : Promise.resolve(undefined),
    );

    await ctrl.playTrack(trackA);

    expect(engineEpochOf(ctrl)).toBe(0);
  });

  it("release() resets engineEpoch to 0", async () => {
    attachEpochMocks([5]);
    await ctrl.playTrack(trackA);
    expect(engineEpochOf(ctrl)).toBe(5);

    ctrl.release();

    expect(engineEpochOf(ctrl)).toBe(0);
  });

  it("release + fresh spawn: the new sidecar's low epochs are the new base", async () => {
    attachEpochMocks([5, 1]);
    await ctrl.playTrack(trackA);
    ctrl.release();

    await ctrl.playTrack(trackA); // fresh mpv process: the counter restarts

    expect(engineEpochOf(ctrl)).toBe(1);
    fireTauri("mpv-property", { name: "time-pos", data: 4, epoch: 0 });
    expect(ctrl.getCurrentTime()).toBe(0);
    fireTauri("mpv-property", { name: "time-pos", data: 4, epoch: 1 });
    expect(ctrl.getCurrentTime()).toBe(4);
  });

  it("sidecar restart (load deadline) adopts the replacement's epoch base", async () => {
    attachEpochMocks([5, 1]);
    await ctrl.playTrack(trackA);
    expect(engineEpochOf(ctrl)).toBe(5);

    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS); // restart + reload

    expect(engineEpochOf(ctrl)).toBe(1);
    fireTauri("mpv-property", { name: "time-pos", data: 8, epoch: 1 });
    expect(ctrl.getCurrentTime()).toBe(8);
  });

  it("respawn after ipc-closed adopts the fresh instance's epoch base", async () => {
    attachEpochMocks([5, 1]);
    await ctrl.playTrack(trackA);
    fireMpvEvent("ipc-closed", "eof");
    tauriMocks.invoke.mockClear();

    await ctrl.playTrack(trackA); // ensureStarted -> fresh spawn + reload

    expect(engineEpochOf(ctrl)).toBe(1);
    fireTauri("mpv-property", { name: "time-pos", data: 2, epoch: 1 });
    expect(ctrl.getCurrentTime()).toBe(2);
  });
});
