/**
 * Regression: F5 must stop the native mpv engine BEFORE the WebView
 * reloads. The engine lives in Rust (process-lifetime), so a bare page reload
 * leaves the audio playing while the fresh UI knows nothing about it. These
 * tests pin the awaitable shutdown, its lock, and the unchanged release() path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../types";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

const hubMocks = vi.hoisted(() => ({ detachThrows: false }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriMocks.listen }));
vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));
// Fault injection for the teardown step (private, only reachable through the
// reload path): the partial mock keeps the real EventHub and listener detach.
vi.mock("./mpvAudio/eventHub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mpvAudio/eventHub")>();
  return {
    ...actual,
    detachListeners: (
      fns: Parameters<typeof actual.detachListeners>[0],
    ): void => {
      if (hubMocks.detachThrows) throw new Error("detach failed");
      actual.detachListeners(fns);
    },
  };
});

import { MpvAudioController } from "./mpvAudio";
import { RELOAD_SHUTDOWN_TIMEOUT_MS } from "./mpvProtocol";

const PROXY_PORT = 51234;

type TauriHandler = (event: { payload: unknown }) => void;

const tauriListeners = new Map<string, TauriHandler[]>();

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

const liveListeners = (name: string): number =>
  (tauriListeners.get(name) ?? []).length;

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

describe("MpvAudioController — awaitable shutdown for a UI reload", () => {
  let ctrl: MpvAudioController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    hubMocks.detachThrows = false;
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    attachMocks();
    ctrl = new MpvAudioController();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("awaits exactly one mpv_shutdown, locks playback, then tears everything down", async () => {
    await ctrl.playTrack(trackA);
    expect(liveListeners("mpv-property")).toBe(1);
    expect(ctrl.activeTimerCount()).toBeGreaterThan(0);

    const ended = vi.fn();
    const error = vi.fn();
    ctrl.on("ended", ended);
    ctrl.on("error", error);

    const gate = deferred<undefined>();
    tauriMocks.invoke.mockClear();
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "mpv_shutdown") return gate.promise;
      return Promise.resolve(undefined);
    });

    const shutdown = ctrl.shutdownForReload();
    await Promise.resolve();
    expect(commandNames()).toEqual(["mpv_shutdown"]);

    // Still pending: playback entry points are locked and no command reaches
    // the dying engine.
    await ctrl.playTrack(trackB);
    ctrl.togglePlay();
    expect(mpvCommands()).toEqual([]);
    expect(commandNames()).toEqual(["mpv_shutdown"]);

    // Late engine events during the shutdown must not surface an error or an
    // auto-advance — the page is going away.
    fireTauri("mpv-event", { event: "end-file", reason: "eof", error: null });
    fireTauri("mpv-event", {
      event: "ipc-closed",
      reason: "shut down",
      error: null,
    });
    expect(ended).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    // Failure-path contract: listeners stay attached until shutdown resolves.
    expect(liveListeners("mpv-property")).toBe(1);
    expect(liveListeners("mpv-event")).toBe(1);
    expect(liveListeners("stream-proxy-error")).toBe(1);

    gate.resolve(undefined);
    await shutdown;

    expect(liveListeners("mpv-property")).toBe(0);
    expect(liveListeners("mpv-event")).toBe(0);
    expect(liveListeners("stream-proxy-error")).toBe(0);
    expect(ctrl.activeTimerCount()).toBe(0);
    expect(ctrl.getCurrentTrackId()).toBeNull();

    // The lock stays closed after a successful shutdown (the page reloads).
    tauriMocks.invoke.mockClear();
    await ctrl.playTrack(trackB);
    expect(commandNames()).toEqual([]);
    expect(ctrl.getCurrentTrackId()).toBeNull();
  });

  it("two concurrent shutdowns join one native mpv_shutdown and both wait for it", async () => {
    await ctrl.playTrack(trackA);
    const gate = deferred<undefined>();
    tauriMocks.invoke.mockClear();
    tauriMocks.invoke.mockImplementation((command: string) =>
      command === "mpv_shutdown" ? gate.promise : Promise.resolve(undefined),
    );

    const first = ctrl.shutdownForReload();
    const second = ctrl.shutdownForReload();

    await Promise.resolve();
    expect(
      commandNames().filter((name) => name === "mpv_shutdown"),
    ).toHaveLength(1);

    gate.resolve(undefined);
    await Promise.all([first, second]);
    expect(
      commandNames().filter((name) => name === "mpv_shutdown"),
    ).toHaveLength(1);
    expect(liveListeners("mpv-property")).toBe(0);
  });

  it("a rejected shutdown keeps playback locked and a retry issues one fresh mpv_shutdown", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();
    tauriMocks.invoke.mockImplementation((command: string) =>
      command === "mpv_shutdown"
        ? Promise.reject(new Error("mpv shutdown failed"))
        : Promise.resolve(undefined),
    );

    await expect(ctrl.shutdownForReload()).rejects.toThrow(
      "mpv shutdown failed",
    );

    // The native lifecycle is unresolved: the local engine state must NOT be
    // reported as torn down, and no Play track may reach the engine.
    expect(liveListeners("mpv-property")).toBe(1);
    expect(ctrl.getCurrentTrackId()).toBe("A");
    tauriMocks.invoke.mockClear();
    await ctrl.playTrack(trackB);
    ctrl.togglePlay();
    expect(commandNames()).toEqual([]);

    // A retry is the explicit recovery: it issues a fresh shutdown and only
    // its success unlocks the page lifecycle.
    tauriMocks.invoke.mockClear();
    tauriMocks.invoke.mockImplementation(() => Promise.resolve(undefined));
    await ctrl.shutdownForReload();
    expect(
      commandNames().filter((name) => name === "mpv_shutdown"),
    ).toHaveLength(1);
    expect(liveListeners("mpv-property")).toBe(0);
    expect(ctrl.getCurrentTrackId()).toBeNull();
  });

  it("a frontend timeout never unlocks playback and a retry joins the SAME native shutdown", async () => {
    await ctrl.playTrack(trackA);
    const gate = deferred<undefined>();
    let shutdownInvocations = 0;
    tauriMocks.invoke.mockClear();
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command !== "mpv_shutdown") return Promise.resolve(undefined);
      shutdownInvocations += 1;
      return gate.promise;
    });

    const pending = ctrl.shutdownForReload();
    const rejects = expect(pending).rejects.toThrow(/mpv IPC timeout/);
    await vi.advanceTimersByTimeAsync(RELOAD_SHUTDOWN_TIMEOUT_MS);
    await rejects;

    // The JS timeout does not cancel the Rust command, so it proves nothing
    // about the engine: no Play/spawn may start a second session.
    expect(liveListeners("mpv-property")).toBe(1);
    expect(ctrl.getCurrentTrackId()).toBe("A");
    tauriMocks.invoke.mockClear();
    await ctrl.playTrack(trackB);
    ctrl.togglePlay();
    expect(commandNames()).toEqual([]);

    // Retry joins the in-flight shutdown instead of issuing a second one...
    const retry = ctrl.shutdownForReload();
    await Promise.resolve();
    expect(shutdownInvocations).toBe(1);

    // ...and only the real completion resolves it and tears the state down.
    gate.resolve(undefined);
    await retry;
    expect(liveListeners("mpv-property")).toBe(0);
    expect(ctrl.getCurrentTrackId()).toBeNull();
  });

  it("a teardown failure is not cached: the next attempt runs a fresh shutdown", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();
    tauriMocks.invoke.mockImplementation(() => Promise.resolve(undefined));

    hubMocks.detachThrows = true;
    await expect(ctrl.shutdownForReload()).rejects.toThrow("detach failed");
    hubMocks.detachThrows = false;

    // Playback stays locked while the local teardown is unresolved.
    tauriMocks.invoke.mockClear();
    await ctrl.playTrack(trackB);
    expect(commandNames()).toEqual([]);

    // Retry: the rejected promise must not be cached — a fresh shutdown runs.
    tauriMocks.invoke.mockClear();
    await ctrl.shutdownForReload();

    expect(
      commandNames().filter((name) => name === "mpv_shutdown"),
    ).toHaveLength(1);
    expect(liveListeners("mpv-property")).toBe(0);
    expect(ctrl.getCurrentTrackId()).toBeNull();
  });

  it("release() keeps its observable behavior: one fire-and-forget shutdown + full detach", async () => {
    await ctrl.playTrack(trackA);
    tauriMocks.invoke.mockClear();

    ctrl.release();

    expect(commandNames()).toEqual(["mpv_shutdown"]);
    expect(liveListeners("mpv-property")).toBe(0);
    expect(liveListeners("mpv-event")).toBe(0);
    expect(liveListeners("stream-proxy-error")).toBe(0);
    expect(ctrl.activeTimerCount()).toBe(0);
    expect(ctrl.getCurrentTrackId()).toBeNull();
  });
});
