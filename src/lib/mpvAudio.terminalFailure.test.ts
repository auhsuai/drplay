/**
 * Regression (audit F8-5/F8-6, slice S10): a failed load/command is terminal.
 * - F8-5: playbackFailure must set playbackFinished — otherwise the next
 *   playTrack of the same track took the same-track resume branch and
 *   no-op'd/resumed again instead of reloading (the resume command itself
 *   rejecting is the reachable case).
 * - F8-6: a crash mid-loadfile fires both onEngineClosed and the
 *   command-rejection catch — one terminal event must surface exactly ONE
 *   failure fact (error), never two. R3.2: the isPlaying projection of that
 *   fact is the policy adapter's job (usePlayerPlaybackPolicy.test.ts).
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
  fireTauri("mpv-event", { event, reason, error: null });
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

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
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

describe("MpvAudioController — terminal failure semantics (F8-5/F8-6)", () => {
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

  it("(F8-5) a failed resume command is terminal: the next playTrack reloads instead of resuming again", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("pause", true); // paused, track still current
    // The resume command now fails (the engine died between the events): the
    // same-track branch rejects and playbackFailure surfaces.
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "stream_proxy_start") return Promise.resolve(PROXY_PORT);
      if (command === "mpv_command")
        return Promise.reject(new Error("mpv is not running"));
      return Promise.resolve(undefined);
    });

    await ctrl.playTrack(trackA);
    expect(errors).toEqual([
      expect.objectContaining({ code: "network_interrupted" }),
    ]);

    // The failure is terminal: a seek is dropped (no live track) instead of
    // arming a dead spinner window — same rule as after end-file.
    tauriMocks.invoke.mockClear();
    ctrl.seek(30);
    expect(mpvCommands()).toEqual([]);

    // Healthy again: the retry must be a real reload, not another no-op resume.
    attachMocks();
    tauriMocks.invoke.mockClear();
    await ctrl.playTrack(trackA);

    expect(mpvCommands()).toContainEqual([
      "loadfile",
      `${PROXY_URL_PREFIX}A`,
      "replace",
    ]);
  });

  it("(R2.1) a failed switch is attributed to the requested track, not the engine's previous one", async () => {
    await ctrl.playTrack(trackA);
    // The switch to B fails before the engine begins B (command rejected), so
    // the engine's currentTrackId is still A — the error must still carry B.
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "stream_proxy_start") return Promise.resolve(PROXY_PORT);
      if (command === "mpv_command")
        return Promise.reject(new Error("mpv is not running"));
      return Promise.resolve(undefined);
    });

    await ctrl.playTrack(trackB);

    expect(errors).toEqual([
      expect.objectContaining({ code: "network_interrupted", trackId: "B" }),
    ]);
  });

  it("(F8-6) engine closes while the loadfile command is in flight: one failure surface, not two", async () => {
    let rejectLoad!: (e: Error) => void;
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "stream_proxy_start") return Promise.resolve(PROXY_PORT);
      if (command === "mpv_command")
        return new Promise<never>((_, reject) => {
          rejectLoad = reject;
        });
      return Promise.resolve(undefined);
    });

    const play = ctrl.playTrack(trackA);
    await flushMicrotasks(); // spawn/proxy done, loadfile awaiting its reply
    expect(mpvCommands().some((cmd) => cmd[0] === "loadfile")).toBe(true);

    fireMpvEvent("ipc-closed", "eof"); // mpv dies mid-loadfile
    rejectLoad(new Error("mpv is not running (call mpv_spawn first)"));
    await play;

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("network_interrupted");
  });

  it("(F8-6) the command rejection lands first: the later engine-closed event is suppressed, retry still reloads", async () => {
    let rejectLoad!: (e: Error) => void;
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "stream_proxy_start") return Promise.resolve(PROXY_PORT);
      if (command === "mpv_command")
        return new Promise<never>((_, reject) => {
          rejectLoad = reject;
        });
      return Promise.resolve(undefined);
    });

    const play = ctrl.playTrack(trackA);
    await flushMicrotasks();
    rejectLoad(new Error("mpv is not running (call mpv_spawn first)"));
    await play;

    fireMpvEvent("ipc-closed", "eof"); // the pipe death surfaces afterwards

    expect(errors).toHaveLength(1);

    // The attempt is terminal: the retry respawns mpv and reloads the track.
    attachMocks();
    tauriMocks.invoke.mockClear();
    await ctrl.playTrack(trackA);

    expect(commandNames()).toContain("mpv_spawn");
    expect(mpvCommands()).toContainEqual([
      "loadfile",
      `${PROXY_URL_PREFIX}A`,
      "replace",
    ]);
  });

  it("(regression) same-track resume after a user pause stays a resume — no reload, no failure", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("pause", true);
    tauriMocks.invoke.mockClear();

    await ctrl.playTrack(trackA);

    expect(mpvCommands()).toEqual([["set_property", "pause", "no"]]);
    expect(errors).toEqual([]);
  });
});
