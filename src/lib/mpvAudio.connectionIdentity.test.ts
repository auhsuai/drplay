/**
 * Regression (R2.2 — RC-6 / B1 / RC-1): Rust tags every `mpv-property` /
 * `mpv-event` payload with the id of the connection that dispatched it
 * (monotonic process-wide, fresh per spawned sidecar) and `mpv_spawn` replies
 * with the new connection's id. The engine only accepts events of the live
 * connection.
 *
 * Why the epoch filter alone was not enough: a fresh sidecar restarts its
 * per-connection epoch counter at 0 (Fix B3 adopts that base), so an in-flight
 * event of the REPLACED connection (epoch >= new base) passed the guard (B1),
 * and `release()` resetting the base to 0 let late events drive a torn-down
 * engine again — restarting the watchdog and re-emitting first-audio (RC-1).
 */
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
import { LOADFILE_DEADLINE_MS } from "./mpvProtocol";

const PROXY_PORT = 51234;

type TauriHandler = (event: { payload: unknown }) => void;

const tauriListeners = new Map<string, TauriHandler[]>();

/** Scripted `mpv_spawn` replies, in call order. `undefined` = legacy Rust
 *  (reply has no conn). */
let spawnReplies: unknown[] = [];
/** Scripted `loadfile` reply epochs, in call order. */
let loadEpochs: number[] = [];

function attachMocks(): void {
  tauriMocks.invoke.mockImplementation(
    (command: string, payload?: Record<string, unknown>) => {
      if (command === "stream_proxy_start") return Promise.resolve(PROXY_PORT);
      if (command === "mpv_spawn") return Promise.resolve(spawnReplies.shift());
      if (command === "mpv_command") {
        const cmd = (payload?.["cmd"] as string[] | undefined) ?? [];
        return Promise.resolve({
          data: null,
          load_epoch: cmd[0] === "loadfile" ? (loadEpochs.shift() ?? 0) : 0,
        });
      }
      return Promise.resolve(undefined);
    },
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

function fireMpvEvent(
  event: string,
  reason: string | null = null,
  error: string | null = null,
): void {
  fireTauri("mpv-event", { event, reason, error });
}

function capturedHandlers(name: string): TauriHandler[] {
  return [...(tauriListeners.get(name) ?? [])];
}

const trackA: Track = {
  id: "A",
  title: "Track A",
  artist: "Artist",
  streamUrl: "/drive-stream/A",
};

describe("MpvAudioController — connection identity (R2.2)", () => {
  let ctrl: MpvAudioController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // Date.now() off the 0 sentinel
    tauriListeners.clear();
    spawnReplies = [];
    loadEpochs = [];
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

  function engineConnOf(controller: MpvAudioController): number | null {
    return (controller as unknown as { engineConn: number | null }).engineConn;
  }

  function engineEpochOf(controller: MpvAudioController): number {
    return (controller as unknown as { engineEpoch: number }).engineEpoch;
  }

  it("B1: after a respawn, events of the replaced connection are dropped, the new connection's pass", async () => {
    spawnReplies.push({ conn: 1 }, { conn: 2 });
    loadEpochs.push(3, 1);

    await ctrl.playTrack(trackA);
    fireTauri("mpv-property", {
      name: "time-pos",
      data: 42,
      epoch: 3,
      conn: 1,
    });
    expect(ctrl.getCurrentTime()).toBe(42);

    fireMpvEvent("ipc-closed", "eof"); // sidecar died
    await ctrl.playTrack(trackA); // respawn: new connection, epoch base back to 1

    // In-flight event of the OLD connection: epoch 2 >= base 1 → it passed
    // the epoch guard before the connection filter existed.
    fireTauri("mpv-property", {
      name: "time-pos",
      data: 99,
      epoch: 2,
      conn: 1,
    });
    expect(ctrl.getCurrentTime()).toBe(0);

    const ended = vi.fn();
    ctrl.on("ended", ended);
    fireTauri("mpv-event", {
      event: "end-file",
      reason: "eof",
      error: null,
      epoch: 2,
      conn: 1,
    });
    expect(ended).not.toHaveBeenCalled();

    // The live connection's event passes as before.
    fireTauri("mpv-property", {
      name: "time-pos",
      data: 55,
      epoch: 1,
      conn: 2,
    });
    expect(ctrl.getCurrentTime()).toBe(55);

    expect(engineConnOf(ctrl)).toBe(2);
    expect(engineEpochOf(ctrl)).toBe(1);
  });

  it("RC-1: late events of the released connection mutate nothing and emit nothing", async () => {
    spawnReplies.push({ conn: 1 });
    loadEpochs.push(1);
    await ctrl.playTrack(trackA);

    const firstAudio = vi.fn();
    const timeupdate = vi.fn();
    ctrl.on("first-audio", firstAudio);
    ctrl.on("timeupdate", timeupdate);
    const propertyHandlers = capturedHandlers("mpv-property");
    const eventHandlers = capturedHandlers("mpv-event");
    const isPlayingCalls = storeMocks.setIsPlaying.mock.calls.length;

    ctrl.release();

    // Deliveries already queued when release() ran: the handler closures are
    // invoked directly (the bridge would deliver them mid-teardown).
    for (const handler of propertyHandlers) {
      handler({ payload: { name: "time-pos", data: 77, epoch: 1, conn: 1 } });
    }
    for (const handler of eventHandlers) {
      handler({
        payload: {
          event: "file-loaded",
          reason: null,
          error: null,
          epoch: 1,
          conn: 1,
        },
      });
    }

    expect(firstAudio).not.toHaveBeenCalled();
    expect(timeupdate).not.toHaveBeenCalled();
    expect(ctrl.getCurrentTime()).toBe(0);
    expect(storeMocks.setIsPlaying).toHaveBeenCalledTimes(isPlayingCalls);
    // file-loaded must not re-arm the watchdog / reconciler / interpolator.
    expect(vi.getTimerCount()).toBe(0);
    expect(engineConnOf(ctrl)).toBeNull();
  });

  it("legacy payload without conn keeps the old behavior; a conn tag with no live connection is dropped", async () => {
    spawnReplies.push(undefined); // legacy Rust: the spawn reply carries no conn
    loadEpochs.push(4);
    await ctrl.playTrack(trackA);

    fireTauri("mpv-property", { name: "time-pos", data: 33, epoch: 4 });
    expect(ctrl.getCurrentTime()).toBe(33);

    fireTauri("mpv-property", {
      name: "time-pos",
      data: 44,
      epoch: 4,
      conn: 9,
    });
    expect(ctrl.getCurrentTime()).toBe(33);
    expect(engineConnOf(ctrl)).toBeNull();
  });

  it("a load-deadline sidecar restart adopts the replacement connection id", async () => {
    spawnReplies.push({ conn: 1 }, { conn: 2 });
    loadEpochs.push(3, 1);
    await ctrl.playTrack(trackA);
    expect(engineConnOf(ctrl)).toBe(1);

    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS); // shutdown + spawn + reload

    expect(engineConnOf(ctrl)).toBe(2);

    fireTauri("mpv-property", {
      name: "time-pos",
      data: 12,
      epoch: 3,
      conn: 1,
    });
    expect(ctrl.getCurrentTime()).toBe(0);

    fireTauri("mpv-property", {
      name: "time-pos",
      data: 21,
      epoch: 1,
      conn: 2,
    });
    expect(ctrl.getCurrentTime()).toBe(21);
  });

  it("keeps the epoch filter for events of the live connection", async () => {
    spawnReplies.push({ conn: 1 });
    loadEpochs.push(5);
    await ctrl.playTrack(trackA);

    fireTauri("mpv-property", {
      name: "time-pos",
      data: 61,
      epoch: 4,
      conn: 1,
    });
    expect(ctrl.getCurrentTime()).toBe(0);
    fireTauri("mpv-property", {
      name: "time-pos",
      data: 62,
      epoch: 5,
      conn: 1,
    });
    expect(ctrl.getCurrentTime()).toBe(62);
  });
});
