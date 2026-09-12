/**
 * INVESTIGATION-ONLY control test for Bug A: proves the engine (mpvAudio)
 * itself never emits `timeupdate` when the user pauses — in particular no
 * zero-position event. Therefore the 0:00 / 0% seen on pause can only come
 * from the SeekBar sync effect re-running, not from the audio engine.
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

const PROXY_PORT = 51234;

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

const trackA: Track = {
  id: "A",
  title: "Track A",
  artist: "Artist",
  streamUrl: "/drive-stream/A",
};

describe("Bug A investigation — engine emissions on pause", () => {
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

  it("A3 (control): pause emits NO timeupdate (and no timeupdate with currentTime=0)", async () => {
    const timeupdates: Array<{ currentTime: number; duration: number }> = [];
    await ctrl.playTrack(trackA);
    ctrl.on("timeupdate", (payload) => {
      timeupdates.push(payload);
    });

    fireProperty("duration", 240);
    fireProperty("time-pos", 63);
    expect(timeupdates.map((t) => t.currentTime)).toEqual([63]);
    timeupdates.length = 0;

    ctrl.pause();
    fireProperty("pause", true);
    vi.advanceTimersByTime(2000);

    expect(timeupdates).toEqual([]);
  });
});
