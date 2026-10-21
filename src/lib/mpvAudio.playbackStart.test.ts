/**
 * Contract tests for the "playback actually started" gate (RC1/RC4/RC5):
 * mpv's `playback-restart` is the ONLY proof that the playback chain is up.
 *
 * - The time-pos watchdog may only poll once the chain is confirmed: a
 *   `pause=false` or a `file-loaded` alone proves nothing (a track that was
 *   loaded but never started is not a track that is playing).
 * - The startup loader (the load's spinner) may only be dismissed by that
 *   confirmation, by a real cache stall that ended, or by a user pause —
 *   never by the first `paused-for-cache=false`, a time-pos tick pair or the
 *   8s net.
 * - Every load attempt owns its own chain state: a late event of the previous
 *   attempt may not arm the new one.
 */
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
import {
  BUFFERING_TIMEOUT_MS,
  resetWarnThrottleForTest,
  WATCHDOG_INTERVAL_MS,
} from "./mpvProtocol";

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

/** mpv's confirmed playback start — the chain is up. */
function firePlaybackRestart(): void {
  fireMpvEvent("playback-restart");
}

function getPropertyCalls(): number {
  return (tauriMocks.invoke.mock.calls as unknown as Array<[string]>).filter(
    (call) => call[0] === "mpv_get_property",
  ).length;
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

describe("MpvAudioController — playback-start gate (watchdog arming)", () => {
  let ctrl: MpvAudioController;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    resetWarnThrottleForTest();
    attachMocks();
    ctrl = new MpvAudioController();
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pause=false alone never polls time-pos — the chain is not confirmed", async () => {
    fireProperty("pause", false);

    await vi.advanceTimersByTimeAsync(3 * WATCHDOG_INTERVAL_MS);

    expect(getPropertyCalls()).toBe(0);
  });

  it("file-loaded alone never polls time-pos", async () => {
    fireMpvEvent("file-loaded");

    await vi.advanceTimersByTimeAsync(3 * WATCHDOG_INTERVAL_MS);

    expect(getPropertyCalls()).toBe(0);
  });

  it("playback-restart arms the watchdog: a push gap polls once and backfills", async () => {
    tauriMocks.invoke.mockImplementation((command: string) =>
      command === "mpv_get_property"
        ? Promise.resolve(90)
        : command === "stream_proxy_start"
          ? Promise.resolve(PROXY_PORT)
          : Promise.resolve(undefined),
    );
    firePlaybackRestart();

    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(getPropertyCalls()).toBe(0); // 1s since the arm <= the stale window

    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(getPropertyCalls()).toBe(1);
    // The backfill goes through the real onTimeUpdate path (clock + emit).
    expect(ctrl.getCurrentTime()).toBe(90);
  });

  it("regular pushes keep the watchdog quiet (no mpv_get_property)", async () => {
    firePlaybackRestart();

    for (let i = 0; i < 8; i++) {
      fireProperty("time-pos", i);
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(getPropertyCalls()).toBe(0);
  });

  it("a user pause stops the watchdog", async () => {
    firePlaybackRestart();
    fireProperty("pause", true);

    await vi.advanceTimersByTimeAsync(3 * WATCHDOG_INTERVAL_MS);

    expect(getPropertyCalls()).toBe(0);
    // The watchdog interval is gone (the load deadline may still be armed —
    // it is the load's own bound, not the watchdog's).
    expect(ctrl.activeTimerNames()).not.toContain("watchdog");
  });

  it("end-file stops the watchdog", async () => {
    firePlaybackRestart();
    fireMpvEvent("end-file", "eof");

    await vi.advanceTimersByTimeAsync(3 * WATCHDOG_INTERVAL_MS);

    expect(getPropertyCalls()).toBe(0);
  });

  it("release() stops the watchdog (no timer leak)", async () => {
    firePlaybackRestart();
    ctrl.release();

    await vi.advanceTimersByTimeAsync(3 * WATCHDOG_INTERVAL_MS);

    expect(getPropertyCalls()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a track replacement while a poll is in flight never mutates the new track", async () => {
    let resolvePoll: (value: unknown) => void = () => {};
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "mpv_get_property") {
        return new Promise((resolve) => {
          resolvePoll = resolve;
        });
      }
      return command === "stream_proxy_start"
        ? Promise.resolve(PROXY_PORT)
        : Promise.resolve(undefined);
    });
    firePlaybackRestart();
    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(getPropertyCalls()).toBe(1); // the poll awaits its IPC reply

    await ctrl.playTrack(trackB); // the new attempt takes over
    resolvePoll(90); // the late poll describes the DEAD attempt
    await vi.advanceTimersByTimeAsync(0);

    expect(ctrl.getCurrentTime()).toBe(0); // the new track was not mutated
    tauriMocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(3 * WATCHDOG_INTERVAL_MS);
    // The watchdog was stopped with the old attempt — it never resurrects.
    expect(getPropertyCalls()).toBe(0);
  });

  it("a seek re-confirms the chain and the watchdog keeps working", async () => {
    firePlaybackRestart();
    tauriMocks.invoke.mockImplementation((command: string) =>
      command === "mpv_get_property"
        ? Promise.resolve(7)
        : command === "stream_proxy_start"
          ? Promise.resolve(PROXY_PORT)
          : Promise.resolve(undefined),
    );

    ctrl.seek(5);
    firePlaybackRestart(); // mpv fires it again after a seek

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);

    expect(getPropertyCalls()).toBeGreaterThan(0);
  });
});

describe("MpvAudioController — startup loader (chain-ready contract)", () => {
  let ctrl: MpvAudioController;
  let buffering: boolean[];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    resetWarnThrottleForTest();
    attachMocks();
    ctrl = new MpvAudioController();
    buffering = [];
    ctrl.on("buffering", ({ isBuffering }) => buffering.push(isBuffering));
    await ctrl.playTrack(trackA);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("the loader is up from the load and survives every non-confirmation signal", async () => {
    expect(buffering).toEqual([true]);

    fireProperty("paused-for-cache", false); // the first observation
    fireProperty("pause", false); // mpv's global flag, not a playback proof
    fireProperty("time-pos", 0.5); // a tick pair
    fireProperty("time-pos", 1);
    await vi.advanceTimersByTimeAsync(BUFFERING_TIMEOUT_MS);

    expect(
      buffering,
      "the startup loader was dismissed without a confirmed start",
    ).toEqual([true]);
  });

  it("playback-restart dismisses the loader exactly once", () => {
    firePlaybackRestart();
    expect(buffering).toEqual([true, false]);

    firePlaybackRestart(); // mpv may fire it again (a seek)
    expect(buffering).toEqual([true, false]);
  });

  it("a user pause turns the spinner off — a pause is not buffering", () => {
    fireProperty("pause", true);

    expect(buffering).toEqual([true, false]);
  });

  it("a real cache stall that ends dismisses the loader", async () => {
    fireProperty("paused-for-cache", true); // a genuine stall
    await vi.advanceTimersByTimeAsync(250);
    fireProperty("paused-for-cache", false); // mpv resumed

    expect(buffering).toEqual([true, false]);
  });

  it("a stall in force holds the loader even after the confirmed start", async () => {
    fireProperty("paused-for-cache", true);
    await vi.advanceTimersByTimeAsync(250);

    firePlaybackRestart();

    expect(
      buffering,
      "the confirmed start dismissed a loader mpv still holds stalled",
    ).toEqual([true]);
  });
});

describe("MpvAudioController — attempt identity (a late restart never arms the next attempt)", () => {
  let ctrl: MpvAudioController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    resetWarnThrottleForTest();
    attachMocks();
    ctrl = new MpvAudioController();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Every loadfile reply carries the load epoch the engine filters by. */
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

  it("a playback-restart of the PREVIOUS attempt never arms the new one", async () => {
    attachEpochMocks([1]);
    const buffering = vi.fn();
    ctrl.on("buffering", buffering);
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    // Stale epoch — it belongs to the load before the current one.
    fireTauri("mpv-event", { event: "playback-restart", epoch: 0 });
    await vi.advanceTimersByTimeAsync(3 * WATCHDOG_INTERVAL_MS);
    expect(getPropertyCalls()).toBe(0);
    // It must not touch the current attempt's loader either.
    expect(buffering).not.toHaveBeenCalledWith(
      expect.objectContaining({ isBuffering: false }),
    );

    // The current attempt's restart is accepted.
    fireTauri("mpv-event", { event: "playback-restart", epoch: 1 });
    await vi.advanceTimersByTimeAsync(3 * WATCHDOG_INTERVAL_MS);
    expect(getPropertyCalls()).toBeGreaterThan(0);
    expect(buffering).toHaveBeenCalledWith(
      expect.objectContaining({ isBuffering: false }),
    );
  });
});
