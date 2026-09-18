/**
 * REGRESSION tests for Bug B ("chuyển bài chưa có nhạc mà chưa trigger
 * spinner loading"). Engine-level, updated to contract v3: `playTrack` calls
 * `buffering.request(true)` (immediate promote) and `pause=false` never
 * settles the tracker, so a track switch — playing or paused — always keeps a
 * spinner source on while the new track has no audio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";

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

vi.mock("../../store/playerStore", () => ({
  usePlayerStore: {
    getState: vi.fn(() => ({
      setIsPlaying: storeMocks.setIsPlaying,
      isPlaying: storeMocks.isPlaying,
    })),
  },
}));

vi.mock("../../utils/errorLog", () => ({ captureError: vi.fn() }));

import { MpvAudioController } from "../mpvAudio";
import { SPINNER_DELAY_MS } from "../mpvProtocol";

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

function fireProperty(name: string, data: unknown): void {
  for (const handler of tauriListeners.get("mpv-property") ?? [])
    handler({ payload: { name, data } });
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

describe("Bug B investigation — spinner gone on track switch", () => {
  let ctrl: MpvAudioController;
  let buffering: Array<{ isBuffering: boolean }>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
    buffering = [];
    ctrl.on("buffering", (payload) => {
      buffering.push(payload);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("B1 (control): switching tracks while PLAYING — A's promoted spinner stays on through the switch (shown dedupe, no drop)", async () => {
    await ctrl.playTrack(trackA);
    expect(buffering).toEqual([{ isBuffering: true }]); // v3: immediate promote
    buffering.length = 0;

    await ctrl.playTrack(trackB);
    vi.advanceTimersByTime(SPINNER_DELAY_MS);

    // A2 (R4): the switch intentionally starts B's own fresh buffering
    // session — exactly one promote for B; crucially still no false while B
    // has not produced audio yet.
    expect(buffering).toEqual([{ isBuffering: true }]);

    // Tracker is alive: B's progressing ticks settle it exactly once.
    fireProperty("time-pos", 1);
    fireProperty("time-pos", 2);
    expect(buffering).toEqual([{ isBuffering: true }, { isBuffering: false }]);
  });

  it("B2 (fixed): switching tracks while PAUSED — the spinner stays on for B; mpv's async pause=false no longer cancels it", async () => {
    await ctrl.playTrack(trackA);

    // User pauses track A: PlayerBar effect -> audio.pause(); mpv confirms.
    ctrl.pause();
    fireProperty("pause", true);
    expect(mpvCommands()).toContainEqual(["set_property", "pause", "yes"]);
    buffering.length = 0;
    tauriMocks.invoke.mockClear();

    // User clicks track B while paused. beginTrack clears the process-global
    // pause flag, resets the old session and playTrack re-arms the spinner
    // request (v3 immediate promote: one fresh true for B's own session).
    await ctrl.playTrack(trackB);
    expect(mpvCommands()).toContainEqual([
      "loadfile",
      `${PROXY_URL_PREFIX}B`,
      "replace",
    ]);
    expect(mpvCommands()).toContainEqual(["set_property", "pause", "no"]);
    expect(buffering).toEqual([{ isBuffering: true }]); // B's session — never a false

    // mpv applies the unpause and pushes pause=false (async, well within the
    // display delay). v3: this is NOT a settle signal — the button keeps the
    // spinner for track B while no audio of B has flowed.
    fireProperty("pause", false);
    vi.advanceTimersByTime(SPINNER_DELAY_MS);
    expect(buffering).toEqual([{ isBuffering: true }]); // no false, no re-promote

    // Tracker is still alive: B's first progressing ticks settle it once.
    fireProperty("time-pos", 1);
    fireProperty("time-pos", 1.5);
    expect(buffering).toEqual([{ isBuffering: true }, { isBuffering: false }]);
  });

  it("B2b (variant): consecutive paused switches — every async pause=false leaves the spinner alive", async () => {
    const trackC: Track = {
      id: "C",
      title: "Track C",
      artist: "Artist",
      streamUrl: "/drive-stream/C",
    };

    await ctrl.playTrack(trackA);
    ctrl.pause();
    fireProperty("pause", true);
    buffering.length = 0;

    // Switch 1 (A -> B while paused): beginTrack clears mpv's process-global
    // pause flag; its async pause=false confirmation must not settle. A2 (R4):
    // the switch promotes B's own fresh session.
    await ctrl.playTrack(trackB);
    fireProperty("pause", false);
    expect(buffering).toEqual([{ isBuffering: true }]);

    // User pauses again before track B produced any audio, then switches to C
    // — the same confirmation races the re-armed session.
    ctrl.pause();
    fireProperty("pause", true);
    await ctrl.playTrack(trackC);
    fireProperty("pause", false);
    vi.advanceTimersByTime(SPINNER_DELAY_MS);
    // v3: settle only comes from truth, so no false may appear here — only
    // C's own fresh promote on top of B's.
    expect(buffering).toEqual([{ isBuffering: true }, { isBuffering: true }]);

    // Alive check: C's progressing ticks settle the spinner exactly once.
    fireProperty("time-pos", 1);
    fireProperty("time-pos", 1.5);
    expect(buffering).toEqual([
      { isBuffering: true },
      { isBuffering: true },
      { isBuffering: false },
    ]);
  });
});
