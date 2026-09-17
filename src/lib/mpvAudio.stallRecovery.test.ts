/**
 * Regression: the "player kẹt" wedge (user report: the clock stops, seeks
 * still hit the network, no error is logged, only an app restart cures it).
 * mpv can pin the playhead with no end-file/error ever reaching the app, and
 * the old engine had no reconciliation (a lost paused-for-cache=false froze
 * the spinner forever) and no self-heal (nothing detected a pinned playhead).
 * Coverage:
 * - (e) polled truth with paused-for-cache=false settles a stuck spinner;
 * - (f) a playhead pinned for STALL_RECOVER_MS reloads the stream (bounded
 *   attempts, resume seek), then surfaces network_interrupted and a replay of
 *   the same track must reload again;
 * - (g) file-loaded re-arms the watchdog so track 2+ keeps its backfill after
 *   track 1's end-file stopped it;
 * - (h) a user pause never triggers a reconcile query or a recovery.
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
import {
  resetWarnThrottleForTest,
  STALL_LOAD_GRACE_MS,
  STALL_RECONCILE_MS,
  STALL_RECOVER_MS,
  STALL_RECOVERY_MAX_ATTEMPTS,
  WATCHDOG_INTERVAL_MS,
} from "./mpvProtocol";

const PROXY_PORT = 51234;
const PROXY_URL_PREFIX = "http://127.0.0.1:51234/stream/";
const PINNED_TIME_POS = 42;

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

function mpvCommands(): string[][] {
  return (
    tauriMocks.invoke.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >
  )
    .filter((call) => call[0] === "mpv_command")
    .map((call) => call[1]["cmd"] as string[]);
}

const loadfiles = (): string[][] =>
  mpvCommands().filter((cmd) => cmd[0] === "loadfile");

/** Frozen truth: the playhead never moves and the cache never grows. */
function freezeTruth(pausedForCache: boolean): void {
  tauriMocks.invoke.mockImplementation(
    (command: string, args?: { prop?: string }) => {
      if (command === "stream_proxy_start") return Promise.resolve(PROXY_PORT);
      if (command === "mpv_get_property") {
        if (args?.prop === "time-pos") return Promise.resolve(PINNED_TIME_POS);
        if (args?.prop === "paused-for-cache")
          return Promise.resolve(pausedForCache);
        if (args?.prop === "demuxer-cache-state")
          return Promise.resolve({
            "seekable-ranges": [{ start: 0, end: 100 }],
          });
      }
      return Promise.resolve(undefined);
    },
  );
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

describe("MpvAudioController — stall reconciler (pinned-playhead self-heal)", () => {
  let ctrl: MpvAudioController;
  let errors: { message: string; code: string }[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // Date.now() off the 0 sentinel
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    // Mirror the real store: setIsPlaying flips the isPlaying the reconciler
    // and watchdog read.
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
    errors = [];
    ctrl.on("error", (payload) => {
      errors.push(payload);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("(e) stuck spinner (lost paused-for-cache=false) + polled truth=false -> buffering emits true then false", async () => {
    const buffering: Array<{ isBuffering: boolean }> = [];
    ctrl.on("buffering", (payload) => {
      buffering.push(payload);
    });

    await ctrl.playTrack(trackA); // v3: immediate promote -> true
    fireMpvEvent("file-loaded"); // the load itself succeeded — only playback wedged
    fireProperty("pause", false);
    fireProperty("paused-for-cache", true); // genuine stall: the net re-arms
    expect(buffering).toEqual([{ isBuffering: true }]);
    buffering.length = 0;

    freezeTruth(false); // mpv says the stall is over — the event was lost
    await vi.advanceTimersByTimeAsync(STALL_RECONCILE_MS);

    expect(buffering).toEqual([{ isBuffering: false }]);
  });

  it("(f) pinned playhead: reload per attempt at 75s (resume seek), exhausted after 2, replay reloads", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("file-loaded"); // past the load phase: the playhead is live
    fireProperty("pause", false);
    freezeTruth(true);
    tauriMocks.invoke.mockClear();

    await vi.advanceTimersByTimeAsync(STALL_RECOVER_MS);
    expect(loadfiles()).toEqual([
      ["loadfile", `${PROXY_URL_PREFIX}A`, "replace"],
    ]);

    // The reload resumes at the pinned position via the file-loaded path.
    fireMpvEvent("file-loaded");
    expect(mpvCommands()).toContainEqual([
      "seek",
      String(PINNED_TIME_POS),
      "absolute",
    ]);

    await vi.advanceTimersByTimeAsync(STALL_RECOVER_MS);
    expect(loadfiles()).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(STALL_RECOVER_MS);
    expect(loadfiles()).toHaveLength(2); // budget spent: no attempt 3
    expect(errors).toEqual([
      expect.objectContaining({ code: "network_interrupted" }),
    ]);
    expect(storeMocks.setIsPlaying).toHaveBeenCalledWith(false);

    // Replay of the same track after the exhausted error must reload.
    tauriMocks.invoke.mockClear();
    await ctrl.playTrack(trackA);
    expect(loadfiles()).toEqual([
      ["loadfile", `${PROXY_URL_PREFIX}A`, "replace"],
    ]);
  });

  it("(g) track 2 after track 1's end-file: file-loaded re-arms the watchdog backfill", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("pause", false);
    fireMpvEvent("end-file", "eof"); // terminal: stops the watchdog

    await ctrl.playTrack(trackB); // auto-advance — no pause event follows
    fireMpvEvent("file-loaded");
    tauriMocks.invoke.mockClear();

    // No time-pos pushes at all: once the staleness window elapses the
    // watchdog must poll mpv again.
    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);

    expect(tauriMocks.invoke).toHaveBeenCalledWith("mpv_get_property", {
      prop: "time-pos",
    });
  });

  it("(h) user pause: no reconcile query and no recovery while paused", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("file-loaded"); // the track loaded, then the user paused it
    fireProperty("pause", false);
    fireProperty("pause", true); // user pauses — nothing is stalled
    freezeTruth(false);
    tauriMocks.invoke.mockClear();

    await vi.advanceTimersByTimeAsync(10 * STALL_RECOVER_MS);

    expect(tauriMocks.invoke).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("(i) playhead never started (time-pos 0) while cache downloads: grace -> recovery reloads -> bounded error, no silent download", async () => {
    await ctrl.playTrack(trackA);
    fireMpvEvent("file-loaded");
    fireProperty("pause", false);
    let cacheEnd = 100;
    tauriMocks.invoke.mockImplementation(
      (command: string, args?: { prop?: string }) => {
        if (command === "stream_proxy_start")
          return Promise.resolve(PROXY_PORT);
        if (command === "mpv_get_property") {
          if (args?.prop === "time-pos") return Promise.resolve(0);
          if (args?.prop === "paused-for-cache") return Promise.resolve(false);
          if (args?.prop === "demuxer-cache-state") {
            cacheEnd += 10; // still downloading — the old rule read this as progress
            return Promise.resolve({
              "seekable-ranges": [{ start: 0, end: cacheEnd }],
            });
          }
        }
        return Promise.resolve(undefined);
      },
    );
    tauriMocks.invoke.mockClear();

    await vi.advanceTimersByTimeAsync(
      STALL_LOAD_GRACE_MS +
        (STALL_RECOVERY_MAX_ATTEMPTS + 1) * STALL_RECOVER_MS,
    );

    // One recovery reload per attempt (no load deadline: file-loaded arrived),
    // then the single bounded error surface.
    expect(loadfiles()).toEqual([
      ["loadfile", `${PROXY_URL_PREFIX}A`, "replace"],
      ["loadfile", `${PROXY_URL_PREFIX}A`, "replace"],
    ]);
    expect(errors).toEqual([
      expect.objectContaining({ code: "network_interrupted" }),
    ]);
    expect(storeMocks.setIsPlaying).toHaveBeenCalledWith(false);
  });
});
