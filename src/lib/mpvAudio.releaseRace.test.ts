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
   * Boots through both listeners and leaves mpv_spawn in flight. The pending
   * playTrack promise is returned inside an object — returning it directly
   * from an async helper would adopt it and deadlock the await here.
   */
  async function startUntilSpawnPending(): Promise<{ play: Promise<void> }> {
    const play = ctrl.playTrack(trackA);
    resolveNextListen();
    await flushMicrotasks();
    resolveNextListen();
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

    tauriMocks.invoke.mockClear();
    const next = ctrl.playTrack(trackB);
    // fresh boot re-registers the property listener (stale attempt left none)
    expect(listenCalls).toHaveLength(3);
    resolveNextListen();
    await flushMicrotasks();
    expect(listenCalls).toHaveLength(4);
    resolveNextListen();
    await flushMicrotasks();
    expect(spawnGates).toHaveLength(1); // a real respawn, not a stale `started`
    resolveNextSpawn();
    await next;

    expect(listenCalls.map((c) => c.name)).toEqual([
      "mpv-property",
      "mpv-event",
      "mpv-property",
      "mpv-event",
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
    expect(spawnGates).toHaveLength(1);
    resolveNextSpawn();
    await Promise.all([first, second]);

    expect(listenCalls).toHaveLength(2); // exactly one registration per event
    expect(liveListeners("mpv-property")).toBe(1);
    expect(liveListeners("mpv-event")).toBe(1);
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
