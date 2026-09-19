/**
 * REGRESSION tests for the user-reported clock/fill oscillation at the start
 * of a track, while audio has not started flowing yet:
 *
 *   "Đồng hồ/fill ở seekbar đếm 1-2-1-2 (tiến rồi bị kéo ngược về, lặp lại)
 *   trong lúc bài CHƯA có nhạc; tới khi nhạc thật sự chạy thì mới đếm tiếp
 *   bình thường."
 *
 * Root cause (engine level): the interpolator extrapolates forward from the
 * last truth on every 250ms tick, gated only by isPlaying + the buffering
 * spinner. When mpv's push chain stalls at head-of-file without
 * paused-for-cache, the watchdog polls `time-pos` and gets the SAME frozen
 * value back; that frozen poll re-anchors the interpolator base and is emitted
 * to consumers — the clock snaps back to the frozen truth, then the next tick
 * runs forward again, repeating on every poll (~2s) until real playback moves.
 *
 * E1 pins the oscillation: at most ONE snap-back to the truth is allowed, and
 * after it the clock must stand still at the truth (no more extrapolation)
 * until a truth that actually advances arrives.
 * E2 pins the clear path: once real truth progresses (0.6 -> 1.0 + pushes),
 * the clock must resume advancing (no permanent freeze).
 *
 * Harness mirrors spinner-seek-settle.investigation.test.ts (store isPlaying
 * is mirrored so the watchdog/interpolator read the live store).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriMocks.listen }));

vi.mock("../../utils/errorLog", () => ({ captureError: vi.fn() }));

import { MpvAudioController } from "../mpvAudio";

const PROXY_PORT = 51234;
/** Frozen truth the watchdog keeps backfilling before audio flows. */
const FROZEN_TIME_POS = 0.5;

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

/** Freezes the watchdog backfill: every poll returns the same stale value. */
function freezeWatchdogPoll(): void {
  tauriMocks.invoke.mockImplementation((command: string) =>
    command === "mpv_get_property"
      ? Promise.resolve(FROZEN_TIME_POS)
      : Promise.resolve(undefined),
  );
}

const trackA: Track = {
  id: "A",
  title: "Track A",
  artist: "Artist",
  streamUrl: "/drive-stream/A",
};

describe("clock-stall oscillation — engine level (head-of-file, no audio yet)", () => {
  let ctrl: MpvAudioController;
  let buffering: boolean[];
  let timeupdates: number[];
  let log: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    attachMocks();
    ctrl = new MpvAudioController();
    buffering = [];
    timeupdates = [];
    log = [];
    ctrl.on("buffering", ({ isBuffering }) => {
      buffering.push(isBuffering);
      log.push(`buffering=${String(isBuffering)}`);
    });
    ctrl.on("timeupdate", ({ currentTime }) => {
      timeupdates.push(currentTime);
      log.push(`timeupdate=${String(currentTime)}`);
    });
    ctrl.on("first-audio", () => log.push("first-audio"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Plays A through the first two real pushes (spinner settles), then stops
   * any further push: from here on only the watchdog could resync.
   */
  async function playSettledThenSilence(): Promise<void> {
    await ctrl.playTrack(trackA);
    fireProperty("pause", false);
    fireProperty("time-pos", 0.5);
    fireProperty("time-pos", 0.6);
    await vi.advanceTimersByTimeAsync(300);
    expect(buffering).toEqual([true, false]);
    timeupdates.length = 0;
    log.length = 0;
  }

  it("E1: frozen watchdog backfill parks the clock at the truth — at most one snap-back (no 1-2-1-2)", async () => {
    await playSettledThenSilence();
    freezeWatchdogPoll();

    // Push chain dead, mpv frozen: let the watchdog poll (~2s cadence) and the
    // interpolator tick (250ms cadence) run for ~10s.
    for (let i = 0; i < 100; i++) await vi.advanceTimersByTimeAsync(100);

    let regressions = 0;
    let lastRegressionAt = -1;
    for (let i = 1; i < timeupdates.length; i++) {
      const prev = timeupdates[i - 1] ?? Number.NaN;
      const cur = timeupdates[i] ?? Number.NaN;
      if (cur < prev) {
        regressions += 1;
        lastRegressionAt = i;
      }
    }

    console.log(log.join("\n"));
    expect(
      regressions,
      `clock oscillated (repeated snap-backs to the frozen truth): ${JSON.stringify(timeupdates)}`,
    ).toBeLessThanOrEqual(1);
    // After the (single) snap-back the clock must stand still at the truth:
    // any later forward value would be extrapolation over a frozen playhead.
    expect(
      lastRegressionAt,
      `no snap-back recorded at all: ${JSON.stringify(timeupdates)}`,
    ).toBeGreaterThanOrEqual(0);
    const afterSnapBack = timeupdates.slice(lastRegressionAt + 1);
    expect(
      afterSnapBack.every((t) => t === FROZEN_TIME_POS),
      `clock kept moving while the truth was frozen: ${JSON.stringify(timeupdates)}`,
    ).toBe(true);
  });

  it("E2: truth progressing again after frozen polls resumes the clock (not stuck forever)", async () => {
    await playSettledThenSilence();
    freezeWatchdogPoll();

    await vi.advanceTimersByTimeAsync(4000); // frozen polls at ~3s and ~5s
    expect(
      timeupdates[timeupdates.length - 1] ?? Number.NaN,
      `clock should be parked at the frozen truth, got: ${JSON.stringify(timeupdates)}`,
    ).toBe(FROZEN_TIME_POS);

    // Real playback finally moves: pushes carry advancing truth.
    const resumeIndex = timeupdates.length;
    fireProperty("time-pos", 0.6);
    await vi.advanceTimersByTimeAsync(300);
    fireProperty("time-pos", 1.0);
    await vi.advanceTimersByTimeAsync(500);

    const afterResume = timeupdates.slice(resumeIndex);
    console.log(log.join("\n"));
    expect(
      afterResume.some((t) => t > 1.0),
      `clock stayed frozen after real truth progressed: ${JSON.stringify(timeupdates)}`,
    ).toBe(true);
  });
});
