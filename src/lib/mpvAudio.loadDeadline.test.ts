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

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // Date.now() off the 0 sentinel
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    storeMocks.setIsPlaying.mockImplementation(
      (playing: boolean | ((prev: boolean) => boolean)) => {
        storeMocks.isPlaying =
          typeof playing === "function"
            ? playing(storeMocks.isPlaying)
            : playing;
      },
    );
    storeMocks.isPlaying = false;
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
    expect(storeMocks.setIsPlaying).not.toHaveBeenCalledWith(false);
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
    expect(storeMocks.setIsPlaying).toHaveBeenCalledWith(false);
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
    expect(storeMocks.setIsPlaying).toHaveBeenCalledWith(false);
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
    expect(storeMocks.setIsPlaying).toHaveBeenCalledWith(false);
  });

  it("a healthy load (file-loaded in time) never restarts the sidecar", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("file-loaded");
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
});

describe("MpvAudioController — switch clears mpv's pause flag without a pause event (H2)", () => {
  let ctrl: MpvAudioController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
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
