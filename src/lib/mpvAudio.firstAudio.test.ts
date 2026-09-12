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

function fireTauri(name: string, payload: unknown): void {
  for (const handler of tauriListeners.get(name) ?? []) handler({ payload });
}

function fireProperty(name: string, data: unknown): void {
  fireTauri("mpv-property", { name, data });
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

describe("MpvAudioController — first-audio (metadata-defer signal)", () => {
  let ctrl: MpvAudioController;
  let firstAudio: unknown[];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    storeMocks.setIsPlaying.mockClear();
    storeMocks.isPlaying = false;
    attachMocks();
    ctrl = new MpvAudioController();
    firstAudio = [];
    ctrl.on("first-audio", (payload) => {
      firstAudio.push(payload);
    });
    await ctrl.playTrack(trackA);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("no real push yet (interpolator gap) -> NO first-audio; interpolator never fakes it", async () => {
    // New track, mpv quiet — the interpolator stays silent without a base,
    // and even time passing must not produce the signal.
    await vi.advanceTimersByTimeAsync(2000);
    expect(firstAudio).toEqual([]);
  });

  it("first REAL time-pos push -> exactly one first-audio; further pushes/interpolation never re-emit", async () => {
    fireProperty("pause", false);
    fireProperty("time-pos", 0.2);
    expect(firstAudio).toEqual([undefined]);

    // More real pushes + interpolated ticks in the gap: still exactly once.
    fireProperty("time-pos", 0.4);
    await vi.advanceTimersByTimeAsync(3000);
    fireProperty("time-pos", 3);
    expect(firstAudio).toHaveLength(1);
  });

  it("track change re-arms: next track emits its own single first-audio", async () => {
    fireProperty("pause", false);
    fireProperty("time-pos", 1);
    expect(firstAudio).toHaveLength(1);

    await ctrl.playTrack(trackB);
    // Fresh track, no push yet — no carry-over emit from the old track.
    await vi.advanceTimersByTimeAsync(2000);
    expect(firstAudio).toHaveLength(1);

    fireProperty("time-pos", 0.5);
    expect(firstAudio).toHaveLength(2);
    fireProperty("time-pos", 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(firstAudio).toHaveLength(2);
  });
});
