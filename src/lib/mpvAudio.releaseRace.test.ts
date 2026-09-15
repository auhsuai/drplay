/**
 * Regression: release() racing an in-flight ensureStarted() (lifecycle epoch
 * + shared start promise). Without the epoch check the stale continuation
 * re-attaches leaked listeners, flips `started` back on against a shutdown
 * mpv and resurrects track state after a silent release.
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
import { captureError } from "../utils/errorLog";
import { WATCHDOG_INTERVAL_MS } from "./mpvProtocol";

const PROXY_PORT = 51234;
const PROXY_URL_PREFIX = "http://127.0.0.1:51234/stream/";

type TauriHandler = (event: { payload: unknown }) => void;
type UnlistenFn = () => void;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Mirrors Tauri's real listen(): the handler exists only once resolved. */
const tauriListeners = new Map<string, TauriHandler[]>();

interface ListenCall {
  name: string;
  handler: TauriHandler;
  gate: Deferred<UnlistenFn>;
  resolved: boolean;
}

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/** Signal-only deferred for commands whose resolved value is ignored. */
function signalGate(): Gate {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let listenCalls: ListenCall[] = [];
let spawnGates: Gate[] = [];
let loadfileGate: Gate | null = null;

function attachMocks(): void {
  tauriMocks.listen.mockImplementation(
    (name: string, handler: TauriHandler) => {
      const gate = deferred<UnlistenFn>();
      listenCalls.push({ name, handler, gate, resolved: false });
      return gate.promise;
    },
  );
  tauriMocks.invoke.mockImplementation(
    (command: string, args?: { cmd?: string[] }) => {
      if (command === "mpv_spawn") {
        const spawnGate = signalGate();
        spawnGates.push(spawnGate);
        return spawnGate.promise;
      }
      if (command === "stream_proxy_start") return Promise.resolve(PROXY_PORT);
      if (
        command === "mpv_command" &&
        args?.cmd?.[0] === "loadfile" &&
        loadfileGate
      ) {
        return loadfileGate.promise;
      }
      return Promise.resolve(undefined);
    },
  );
}

function resolveNextListen(): void {
  const call = listenCalls.find((c) => !c.resolved);
  if (!call) throw new Error("no pending listen call to resolve");
  call.resolved = true;
  const list = tauriListeners.get(call.name) ?? [];
  list.push(call.handler);
  tauriListeners.set(call.name, list);
  call.gate.resolve(() => {
    tauriListeners.set(
      call.name,
      (tauriListeners.get(call.name) ?? []).filter((h) => h !== call.handler),
    );
  });
}

/** Resolves the oldest pending mpv_spawn gate (one pending at a time here). */
function resolveNextSpawn(): void {
  const gate = spawnGates.shift();
  if (!gate) throw new Error("no pending mpv_spawn gate to resolve");
  gate.resolve();
}

const liveListeners = (name: string): number =>
  (tauriListeners.get(name) ?? []).length;

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function fireProperty(name: string, data: unknown): void {
  for (const handler of tauriListeners.get("mpv-property") ?? []) {
    handler({ payload: { name, data } });
  }
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

describe("MpvAudioController — release() vs in-flight start (lifecycle epoch)", () => {
  let ctrl: MpvAudioController;
  let errors: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    listenCalls = [];
    spawnGates = [];
    loadfileGate = null;
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    vi.mocked(captureError).mockClear();
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

  /**
   * Boots through all three listeners (mpv-property -> mpv-event ->
   * stream-proxy-error) and leaves mpv_spawn in flight. The pending playTrack
   * promise is returned inside an object — returning it directly from an
   * async helper would adopt it and deadlock the await here.
   */
  async function startUntilSpawnPending(): Promise<{ play: Promise<void> }> {
    const play = ctrl.playTrack(trackA);
    resolveNextListen(); // mpv-property handle attached
    await flushMicrotasks();
    resolveNextListen(); // mpv-event handle attached
    await flushMicrotasks();
    resolveNextListen(); // stream-proxy-error handle attached
    await flushMicrotasks();
    expect(spawnGates).toHaveLength(1);
    return { play };
  }

  /** Full boot of one track: listeners + spawn resolved in order. */
  async function bootEngine(): Promise<void> {
    const { play } = await startUntilSpawnPending();
    resolveNextSpawn();
    await play;
  }

  it("C1: release() while mpv_spawn is in flight — late listeners detached, no volume/loadfile, silent abort", async () => {
    const { play } = await startUntilSpawnPending();

    ctrl.release(); // race: teardown before the spawn resolves

    resolveNextSpawn();
    await expect(play).resolves.toBeUndefined();

    // (a) every handle created by the stale attempt was detached — no leak
    expect(liveListeners("mpv-property")).toBe(0);
    expect(liveListeners("mpv-event")).toBe(0);
    expect(liveListeners("stream-proxy-error")).toBe(0);
    // (b) no stale mpv commands: no volume re-apply, no loadfile
    expect(
      mpvCommands().some(
        (cmd) => cmd[0] === "set_property" && cmd[1] === "volume",
      ),
    ).toBe(false);
    expect(mpvCommands().some((cmd) => cmd[0] === "loadfile")).toBe(false);
    // (c) release stays silent for consumers
    expect(errors).toEqual([]);
    expect(vi.mocked(captureError)).not.toHaveBeenCalledWith(
      expect.objectContaining({ level: "error" }),
    );
  });

  it("C1b: release() while the second listen() is pending — both late handles detached", async () => {
    const play = ctrl.playTrack(trackA);
    resolveNextListen(); // property handle attached, epoch still current
    await flushMicrotasks();
    expect(listenCalls).toHaveLength(2); // event listen now in flight

    ctrl.release(); // race: teardown between the two listen resolutions

    resolveNextListen(); // event handle arrives AFTER release
    await flushMicrotasks();
    if (spawnGates.length > 0) resolveNextSpawn(); // old engine walks on
    await expect(play).resolves.toBeUndefined();

    expect(liveListeners("mpv-property")).toBe(0);
    expect(liveListeners("mpv-event")).toBe(0);
    expect(liveListeners("stream-proxy-error")).toBe(0);
    expect(mpvCommands().some((cmd) => cmd[0] === "loadfile")).toBe(false);
    expect(errors).toEqual([]);
  });

  it("C1c: release() while the third listen() (stream-proxy-error) is pending — all late handles detached", async () => {
    const play = ctrl.playTrack(trackA);
    resolveNextListen(); // mpv-property handle attached, epoch still current
    await flushMicrotasks();
    resolveNextListen(); // mpv-event handle attached, epoch still current
    await flushMicrotasks();
    expect(listenCalls).toHaveLength(3); // stream-proxy-error listen now in flight

    ctrl.release(); // race: teardown while the last listener is unresolved

    resolveNextListen(); // stream-proxy-error handle arrives AFTER release
    await flushMicrotasks();
    // The epoch check right after the third attach aborts before mpv_spawn —
    // the stale attempt must not even reach the spawn command.
    expect(spawnGates).toHaveLength(0);
    await expect(play).resolves.toBeUndefined();

    expect(liveListeners("mpv-property")).toBe(0);
    expect(liveListeners("mpv-event")).toBe(0);
    expect(liveListeners("stream-proxy-error")).toBe(0);
    expect(mpvCommands().some((cmd) => cmd[0] === "loadfile")).toBe(false);
    expect(errors).toEqual([]);
  });

  it("C2: after a mid-start release, the next playTrack boots from scratch (no stale state)", async () => {
    const { play } = await startUntilSpawnPending();
    ctrl.release();
    resolveNextSpawn();
    await play;
    expect(liveListeners("mpv-property")).toBe(0);
    expect(liveListeners("mpv-event")).toBe(0);
    expect(liveListeners("stream-proxy-error")).toBe(0);

    tauriMocks.invoke.mockClear();
    const next = ctrl.playTrack(trackB);
    // fresh boot re-registers the property listener (stale attempt left none)
    expect(listenCalls).toHaveLength(4);
    resolveNextListen();
    await flushMicrotasks();
    expect(listenCalls).toHaveLength(5);
    resolveNextListen();
    await flushMicrotasks();
    expect(listenCalls).toHaveLength(6);
    resolveNextListen();
    await flushMicrotasks();
    expect(spawnGates).toHaveLength(1); // a real respawn, not a stale `started`
    resolveNextSpawn();
    await next;

    expect(listenCalls.map((c) => c.name)).toEqual([
      "mpv-property",
      "mpv-event",
      "stream-proxy-error",
      "mpv-property",
      "mpv-event",
      "stream-proxy-error",
    ]);
    expect(commandNames().filter((n) => n === "mpv_spawn")).toHaveLength(1);
    expect(mpvCommands()).toContainEqual(["set_property", "volume", "100"]);
    expect(mpvCommands()).toContainEqual([
      "loadfile",
      `${PROXY_URL_PREFIX}B`,
      "replace",
    ]);
    expect(liveListeners("mpv-property")).toBe(1);
    expect(liveListeners("mpv-event")).toBe(1);
    expect(liveListeners("stream-proxy-error")).toBe(1);
  });

  it("C3: two concurrent playTrack before started — one listener set, one spawn (dedupe)", async () => {
    const first = ctrl.playTrack(trackA);
    const second = ctrl.playTrack(trackB);

    // The second call joins the first in-flight attempt — no second boot.
    expect(listenCalls).toHaveLength(1);
    resolveNextListen();
    await flushMicrotasks();
    expect(listenCalls).toHaveLength(2);
    resolveNextListen();
    await flushMicrotasks();
    expect(listenCalls).toHaveLength(3);
    resolveNextListen();
    await flushMicrotasks();
    expect(spawnGates).toHaveLength(1);
    resolveNextSpawn();
    await Promise.all([first, second]);

    expect(listenCalls).toHaveLength(3); // exactly one registration per event
    expect(liveListeners("mpv-property")).toBe(1);
    expect(liveListeners("mpv-event")).toBe(1);
    expect(liveListeners("stream-proxy-error")).toBe(1);
    expect(commandNames().filter((n) => n === "mpv_spawn")).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("C5: release() while loadfile is in flight — track state not resurrected, silent", async () => {
    await bootEngine();
    expect(liveListeners("mpv-property")).toBe(1);
    tauriMocks.invoke.mockClear();
    const releaseGate = signalGate();
    loadfileGate = releaseGate;

    const stale = ctrl.playTrack(trackB);
    await flushMicrotasks();
    expect(mpvCommands()).toContainEqual([
      "loadfile",
      `${PROXY_URL_PREFIX}B`,
      "replace",
    ]);

    ctrl.release(); // race: teardown while the new track is loading
    releaseGate.resolve();
    await expect(stale).resolves.toBeUndefined();

    // Observable: no lastTrack/playbackFinished resurrection — togglePlay is
    // a no-op and no buffering timer was armed by the stale continuation.
    tauriMocks.invoke.mockClear();
    ctrl.togglePlay();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("C6: release() while a watchdog poll is in flight — late poll result cannot emit first-audio/timeupdate", async () => {
    await bootEngine();
    const firstAudio = vi.fn();
    const timeupdate = vi.fn();
    ctrl.on("first-audio", firstAudio);
    ctrl.on("timeupdate", timeupdate);

    const pollGate = deferred<unknown>();
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "mpv_get_property") return pollGate.promise;
      return Promise.resolve(undefined);
    });

    storeMocks.isPlaying = true; // mirror the store flip pause=false performs
    fireProperty("pause", false); // arms the watchdog + interpolator
    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(tauriMocks.invoke).toHaveBeenCalledWith("mpv_get_property", {
      prop: "time-pos",
    });

    ctrl.release(); // race: teardown while the poll awaits its IPC reply
    pollGate.resolve(90);
    await flushMicrotasks();

    expect(firstAudio).not.toHaveBeenCalled();
    expect(timeupdate).not.toHaveBeenCalled();
    expect(ctrl.getCurrentTime()).toBe(0);
  });

  it("C5b: loadfile rejection after release() stays silent (no playbackFailure emit)", async () => {
    await bootEngine();
    vi.mocked(captureError).mockClear();
    const releaseGate = signalGate();
    loadfileGate = releaseGate;

    const stale = ctrl.playTrack(trackB);
    await flushMicrotasks();
    ctrl.release();
    releaseGate.reject(new Error("mpv is not running (shut down mid-load)"));
    await expect(stale).resolves.toBeUndefined();

    expect(errors).toEqual([]);
    expect(storeMocks.setIsPlaying).not.toHaveBeenCalledWith(false);
    expect(vi.mocked(captureError)).not.toHaveBeenCalledWith(
      expect.objectContaining({ level: "error" }),
    );
  });
});
