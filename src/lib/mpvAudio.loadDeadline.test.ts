/**
 * Regression: the silent wedge cures from the 2026-09-17 freeze report.
 * - H2: a track switch made while mpv's `pause` property-push was lost left
 *   the engine cached as unpaused while mpv stayed frozen — beginTrack must
 *   always clear mpv's process-global pause flag after a loadfile.
 * - H1: `loadfile replace` can wedge mpv's playback chain (no `file-loaded`,
 *   no `end-file`, no error, pipe alive, demuxer still downloading). The only
 *   proven cure is a fresh mpv process, so the engine restarts the sidecar
 *   once per load and then surfaces a bounded network_interrupted error.
 */
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
import {
  LOADFILE_DEADLINE_MS,
  LOADFILE_RESTART_TIMEOUT_MS,
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

function fireMpvEvent(
  event: string,
  reason: string | null = null,
  error: string | null = null,
): void {
  fireTauri("mpv-event", { event, reason, error });
}

function fireProperty(name: string, data: unknown): void {
  fireTauri("mpv-property", { name, data });
}

function commandNames(): string[] {
  return (tauriMocks.invoke.mock.calls as unknown as Array<[string]>).map(
    (call) => call[0],
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

describe("MpvAudioController — load deadline + sidecar restart (H1)", () => {
  let ctrl: MpvAudioController;
  let errors: { message: string; code: string }[];
  let plays: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // Date.now() off the 0 sentinel
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    attachMocks();
    ctrl = new MpvAudioController();
    errors = [];
    ctrl.on("error", (payload) => {
      errors.push(payload);
    });
    // R3.2: the store projection moved to the policy adapter — the no-forced-
    // play assertions below lock the missing engine `play` fact instead.
    plays = [];
    ctrl.on("play", (payload) => {
      plays.push(payload);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("(H1) no file-loaded within the deadline restarts the sidecar and reloads the track once", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS);

    expect(commandNames().filter((name) => name !== "mpv_command")).toEqual([
      "mpv_shutdown",
      "mpv_spawn",
    ]);
    expect(mpvCommands()).toEqual([
      // Fresh mpv starts at volume 100 — the engine re-applies the facade.
      ["set_property", "volume", "100"],
      ["loadfile", `${PROXY_URL_PREFIX}A`, "replace"],
      ["set_property", "pause", "no"],
    ]);
    // The restart is internal: no error may surface while it is being tried.
    expect(errors).toEqual([]);
  });

  it("(H1) the reload missing its own deadline too surfaces a bounded error instead of restarting forever", async () => {
    await ctrl.playTrack(trackA);
    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS); // restart #1
    tauriMocks.invoke.mockClear();

    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS); // reload never loads either

    expect(commandNames().filter((name) => name !== "mpv_command")).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({ code: "network_interrupted" }),
    ]);
  });

  it("(H1) a reload command that itself fails surfaces the bounded error (no unhandled rejection)", async () => {
    await ctrl.playTrack(trackA);
    // The sidecar swap works, the reload's loadfile rejects (mpv already gone).
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "stream_proxy_start") return Promise.resolve(PROXY_PORT);
      if (command === "mpv_command")
        return Promise.reject(
          new Error("mpv is not running (call mpv_spawn first)"),
        );
      return Promise.resolve(undefined);
    });

    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS);

    expect(errors).toEqual([
      expect.objectContaining({ code: "network_interrupted" }),
    ]);
  });

  it("(H1) a hung restart IPC is bounded: the load ends in the bounded error, not a second silent wedge", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "stream_proxy_start") return Promise.resolve(PROXY_PORT);
      if (command === "mpv_shutdown") return new Promise(() => {}); // never settles
      return Promise.resolve(undefined);
    });

    await vi.advanceTimersByTimeAsync(
      LOADFILE_DEADLINE_MS + LOADFILE_RESTART_TIMEOUT_MS,
    );

    expect(errors).toEqual([
      expect.objectContaining({ code: "network_interrupted" }),
    ]);
  });

  it("a healthy load (file-loaded in time) never restarts the sidecar", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("file-loaded"); // the load completed — clears the load deadline
    // R3.2: a loaded track arms the backfill machines engine-side; park it
    // paused so only a (wrongly) surviving deadline could issue IPC here.
    fireProperty("pause", true);
    tauriMocks.invoke.mockClear();

    await vi.advanceTimersByTimeAsync(3 * LOADFILE_DEADLINE_MS);

    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("a stale deadline never restarts the sidecar after another track took over", async () => {
    await ctrl.playTrack(trackA);
    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS - 1000);
    await ctrl.playTrack(trackB); // supersedes A's deadline with a fresh one
    tauriMocks.invoke.mockClear();

    await vi.advanceTimersByTimeAsync(2000); // A's original deadline passes

    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("a terminal end-file before the deadline cancels it", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("end-file", "eof");
    tauriMocks.invoke.mockClear();

    await vi.advanceTimersByTimeAsync(3 * LOADFILE_DEADLINE_MS);

    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("release() before the deadline cancels it (no restart of a torn-down engine)", async () => {
    await ctrl.playTrack(trackA);
    ctrl.release();
    tauriMocks.invoke.mockClear();

    await vi.advanceTimersByTimeAsync(3 * LOADFILE_DEADLINE_MS);

    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("(F5-6) a pause requested inside the load window pins the loaded track paused; play then resumes it", async () => {
    // Hold the proxy start open so playTrack is still inside the load window
    // when the user pauses: no track exists yet, pause() has nowhere to land.
    let resolveProxy: ((port: number) => void) | undefined;
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "stream_proxy_start") {
        return new Promise<number>((resolve) => {
          resolveProxy = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const play = ctrl.playTrack(trackA);
    await vi.advanceTimersByTimeAsync(0); // spawn settles, proxy still pending
    ctrl.pause(); // user pause while currentTrackId is still null
    resolveProxy?.(PROXY_PORT);
    await play;

    // The load comes up pinned: never pause=no, the pause intent wins.
    expect(mpvCommands()).toEqual([
      ["set_property", "volume", "100"],
      ["loadfile", `${PROXY_URL_PREFIX}A`, "replace"],
      ["set_property", "pause", "yes"],
    ]);
    expect(plays).toEqual([]);

    tauriMocks.invoke.mockClear();
    await ctrl.playTrack(trackA); // explicit play resumes — no reload
    expect(mpvCommands()).toEqual([["set_property", "pause", "no"]]);
  });

  it("(F8-2) a sidecar restart after a user pause reloads the track paused (no forced play)", async () => {
    await ctrl.playTrack(trackA);
    ctrl.pause(); // user pause while the load chain is wedged (no file-loaded)
    tauriMocks.invoke.mockClear();

    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS);

    expect(commandNames().filter((name) => name !== "mpv_command")).toEqual([
      "mpv_shutdown",
      "mpv_spawn",
    ]);
    expect(mpvCommands()).toEqual([
      ["set_property", "volume", "100"],
      ["loadfile", `${PROXY_URL_PREFIX}A`, "replace"],
      // The reload honors the pause intent — the old forced pause=no here is
      // what dragged the store back to playing after the restart.
      ["set_property", "pause", "yes"],
    ]);
    // A real mpv answers the pin with pause=true: no play fact may surface.
    fireProperty("pause", true);
    expect(plays).toEqual([]);
  });
});

describe("MpvAudioController — switch clears mpv's pause flag without a pause event (H2)", () => {
  let ctrl: MpvAudioController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
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

  it("mpv never emits a pause event: the new track still gets set_property pause no", async () => {
    await ctrl.playTrack(trackA);
    // No `pause` property event ever arrives (lost push chain) — the engine's
    // cached flag stays false while mpv may actually be paused.
    tauriMocks.invoke.mockClear();

    await ctrl.playTrack(trackB);

    expect(mpvCommands()).toEqual([
      ["loadfile", `${PROXY_URL_PREFIX}B`, "replace"],
      ["set_property", "pause", "no"],
    ]);
  });
});

interface SwapGate {
  promise: Promise<void>;
  resolve: () => void;
}

function swapGate(): SwapGate {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(times = 50): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("MpvAudioController — load-deadline supersede + resume (F8-1/F3-9)", () => {
  let ctrl: MpvAudioController;
  let errors: { message: string; code: string }[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    attachMocks();
    ctrl = new MpvAudioController();
    errors = [];
    ctrl.on("error", (payload) => {
      errors.push(payload);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Holds the load-deadline restart mid-swap so a user switch can land. */
  function holdSidecarSwap(): { shutdown: SwapGate; spawn: SwapGate } {
    const shutdown = swapGate();
    const spawn = swapGate();
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "stream_proxy_start") return Promise.resolve(PROXY_PORT);
      if (command === "mpv_shutdown") return shutdown.promise;
      if (command === "mpv_spawn") return spawn.promise;
      return Promise.resolve(undefined);
    });
    return { shutdown, spawn };
  }

  it("(F8-1) a switch during the restart's shutdown await is never clobbered by the stale reload", async () => {
    await ctrl.playTrack(trackA); // wedge: no file-loaded ever arrives
    tauriMocks.invoke.mockClear();
    const gates = holdSidecarSwap();

    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS);
    expect(commandNames()).toEqual(["mpv_shutdown"]); // swap awaiting its reply

    const switched = ctrl.playTrack(trackB); // user clicks B during the swap
    await flushMicrotasks();
    // B must not race a dying sidecar: no loadfile until the swap settles.
    expect(mpvCommands()).toEqual([]);

    gates.shutdown.resolve();
    await flushMicrotasks();
    expect(commandNames().filter((name) => name !== "mpv_command")).toEqual([
      "mpv_shutdown",
      "mpv_spawn",
    ]);
    expect(mpvCommands()).toEqual([]); // still parked — replacement not up

    gates.spawn.resolve();
    await switched;

    // B loads on the replacement sidecar; A's stale reload never happens.
    expect(mpvCommands()).toEqual([
      ["set_property", "volume", "100"],
      ["loadfile", `${PROXY_URL_PREFIX}B`, "replace"],
      ["set_property", "pause", "no"],
    ]);
    expect(errors).toEqual([]);
  });

  it("(F8-1) a switch between shutdown and spawn is not clobbered either", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();
    const gates = holdSidecarSwap();

    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS);
    gates.shutdown.resolve();
    await flushMicrotasks();
    expect(commandNames().filter((name) => name !== "mpv_command")).toEqual([
      "mpv_shutdown",
      "mpv_spawn",
    ]);

    const switched = ctrl.playTrack(trackB);
    await flushMicrotasks();
    expect(mpvCommands()).toEqual([]); // parked until the new sidecar is up

    gates.spawn.resolve();
    await switched;

    expect(mpvCommands()).toEqual([
      ["set_property", "volume", "100"],
      ["loadfile", `${PROXY_URL_PREFIX}B`, "replace"],
      ["set_property", "pause", "no"],
    ]);
    expect(errors).toEqual([]);
  });

  it("(F3-9) the deadline restart replays the original startTime (resume position)", async () => {
    await ctrl.playTrack(trackA, 42);
    tauriMocks.invoke.mockClear();

    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS); // restart + reload

    expect(mpvCommands()).toContainEqual([
      "loadfile",
      `${PROXY_URL_PREFIX}A`,
      "replace",
    ]);
    expect(mpvCommands().some((cmd) => cmd[0] === "seek")).toBe(false);

    fireMpvEvent("file-loaded");

    // The recovery resumes at the position queued before the wedge instead of
    // restarting the track from the top.
    expect(mpvCommands()).toContainEqual(["seek", "42", "absolute"]);
    expect(ctrl.getCurrentTime()).toBe(42);
  });

  it("(F8-1) a same-track re-click during the restart does not cancel the recovery reload", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();
    const gates = holdSidecarSwap();

    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS);
    const again = ctrl.playTrack(trackA); // impatient re-click of the same track
    gates.shutdown.resolve();
    gates.spawn.resolve();
    await again;
    await flushMicrotasks();

    // The restart's own reload still cures the wedge — the no-op click must
    // not be mistaken for a supersede.
    expect(mpvCommands()).toEqual([
      ["set_property", "volume", "100"],
      ["loadfile", `${PROXY_URL_PREFIX}A`, "replace"],
      ["set_property", "pause", "no"],
    ]);
    expect(errors).toEqual([]);
  });

  it("(regression) release() while the restart is swapping stays silent: no spawn, no reload", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();
    const gates = holdSidecarSwap();

    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS);
    expect(commandNames()).toEqual(["mpv_shutdown"]);

    ctrl.release();
    gates.shutdown.resolve();
    await flushMicrotasks();

    expect(commandNames()).not.toContain("mpv_spawn");
    expect(mpvCommands()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("(regression) a track switch parked on the swap is not booted after a release during the wait", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();
    const gates = holdSidecarSwap();

    await vi.advanceTimersByTimeAsync(LOADFILE_DEADLINE_MS);
    const switched = ctrl.playTrack(trackB); // parked on the sidecar swap
    await flushMicrotasks();
    expect(mpvCommands()).toEqual([]);

    ctrl.release(); // teardown while the switch is still parked
    gates.shutdown.resolve();
    gates.spawn.resolve();
    await switched;

    // The parked request is stale: it must not resurrect a fresh engine or
    // issue any loadfile for the torn-down lifecycle.
    expect(commandNames()).not.toContain("mpv_spawn");
    expect(mpvCommands()).toEqual([]);
    expect(errors).toEqual([]);
  });
});
