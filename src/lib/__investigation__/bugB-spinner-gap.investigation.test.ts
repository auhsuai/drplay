/**
 * INVESTIGATION-ONLY tests for Bug B ("chuyển bài chưa có nhạc mà chưa
 * trigger spinner loading"). Engine-level: proves the optimistic spinner
 * request armed by `playTrack` is silently cancelled by the mpv `pause=false`
 * confirmation that always follows a track switch made while paused.
 *
 * B1 is the control (switch while PLAYING: spinner promotes normally).
 * B2 is RED today (switch while PAUSED: no spinner at all while the new
 * track has no audio, even though the app already reports isPlaying=true).
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

  it("B1 (control): switching tracks while PLAYING promotes the spinner after the display delay", async () => {
    await ctrl.playTrack(trackA);
    buffering.length = 0;

    await ctrl.playTrack(trackB);
    vi.advanceTimersByTime(SPINNER_DELAY_MS);

    expect(buffering).toEqual([{ isBuffering: true }]);
  });

  it("B2 (RED today): switching tracks while PAUSED — mpv's async pause=false silently cancels the pending spinner, no buffering=true while the new track has no audio", async () => {
    await ctrl.playTrack(trackA);

    // User pauses track A: PlayerBar effect -> audio.pause(); mpv confirms.
    ctrl.pause();
    fireProperty("pause", true);
    expect(mpvCommands()).toContainEqual(["set_property", "pause", "yes"]);
    buffering.length = 0;
    tauriMocks.invoke.mockClear();

    // User clicks track B while paused. beginTrack clears the process-global
    // pause flag (mpvAudio.ts:278-289) and playTrack arms the optimistic
    // spinner request (mpvAudio.ts:322).
    await ctrl.playTrack(trackB);
    expect(mpvCommands()).toContainEqual([
      "loadfile",
      `${PROXY_URL_PREFIX}B`,
      "replace",
    ]);
    expect(mpvCommands()).toContainEqual(["set_property", "pause", "no"]);
    expect(buffering).toEqual([]); // pending — the 250ms display delay is running

    // mpv applies the unpause and pushes pause=false (async, well within the
    // display delay). The app treats this as "playback confirmed" and settles
    // the pending spinner SILENTLY — but it only proves the global pause flag
    // was cleared, not that any audio of track B flowed.
    fireProperty("pause", false);
    vi.advanceTimersByTime(SPINNER_DELAY_MS);

    // The button must still show the loading spinner for track B (isPlaying is
    // already true). Actual on the working tree: [] — spinner never shows.
    expect(buffering).toEqual([{ isBuffering: true }]);
  });

  it("B2b (variant): consecutive paused switches — every async pause=false leaves the pending spinner alive", async () => {
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
    // pause flag, so its async pause=false confirmation arrives while the
    // pending spinner request is still inside the 250ms display delay.
    await ctrl.playTrack(trackB);
    fireProperty("pause", false);
    expect(buffering).toEqual([]);

    // User pauses again before track B produced any audio, then switches to C
    // — the same confirmation races the re-armed pending request.
    ctrl.pause();
    fireProperty("pause", true);
    await ctrl.playTrack(trackC);
    fireProperty("pause", false);
    vi.advanceTimersByTime(SPINNER_DELAY_MS);

    expect(buffering).toEqual([{ isBuffering: true }]);
  });
});
