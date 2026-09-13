/**
 * REGRESSION tests for the v4 spin-hold defect reported by the user
 * (engine level): "vẫn bị nhảy thêm 1s thừa; lúc đó CHƯA có nhạc mà số
 * (clock/fill) chạy, và KHÔNG còn loading spinner."
 *
 * Root cause (v3 BufferingTracker): a changed time-pos tick pair settles the
 * spinner even while mpv reports paused-for-cache=true, and the 8s safety net
 * settles a shown spinner unconditionally. Both paths kill the spinner while
 * mpv still says the playhead is pinned — the interpolator gate
 * (() => buffering.isShown()) then opens and extrapolates an extra ~1s of
 * clock/fill with no audio.
 *
 * v4 contract under test:
 *   E1 — changed ticks while paused-for-cache=true never settle: no false,
 *        the synthetic clock stays parked at the last real truth.
 *   E2 — the 8s safety net re-arms instead of settling while mpv still
 *        reports the stall.
 *   E3 — report(false) is the settle signal (exactly one false); afterwards
 *        tick-settle works again and the clock resumes without a jump.
 *   E4 — terminal end-file still settles regardless of the flag.
 *   E5 — release()/cancel() drops the dead stall flag with it (a fresh engine
 *        must not inherit a stale paused-for-cache=true).
 *
 * Harness mirrors mpvAudio.test.ts (store isPlaying is mirrored so the
 * watchdog/interpolator read the live store).
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
import { BUFFERING_TIMEOUT_MS } from "../mpvProtocol";

const PROXY_PORT = 51234;
/** Runs far above this tolerance = the ~1s interpolation runaway. */
const CLOCK_RUNAWAY_EPS_SECS = 0.2;

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

function fireMpvEvent(event: string, reason?: string): void {
  for (const handler of tauriListeners.get("mpv-event") ?? [])
    handler({ payload: { event, reason } });
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

describe("buffering hold investigation — engine level (v4 spin-hold)", () => {
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
    storeMocks.isPlaying = false;
    storeMocks.setIsPlaying.mockReset();
    // Mirror the real store: setIsPlaying flips the isPlaying the watchdog and
    // the interpolator read on every tick.
    storeMocks.setIsPlaying.mockImplementation(
      (playing: boolean | ((prev: boolean) => boolean)) => {
        storeMocks.isPlaying =
          typeof playing === "function"
            ? playing(storeMocks.isPlaying)
            : playing;
      },
    );
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
    ctrl.on("play", () => log.push("play"));
    ctrl.on("pause", () => log.push("pause"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("E1 (RED): two CHANGED ticks while paused-for-cache=true never settle — no false, clock stays parked at truth", async () => {
    await ctrl.playTrack(trackA); // v3: immediate promote
    fireProperty("pause", false);
    fireProperty("paused-for-cache", true); // mpv: playhead pinned
    fireProperty("time-pos", 0.5); // truth #1
    fireProperty("time-pos", 0.6); // truth #2 (changed pair — v3 settled here)
    log.push("-- two changed ticks while paused-for-cache=true");
    await vi.advanceTimersByTimeAsync(600);

    console.log(log.join("\n"));
    expect(
      buffering,
      "tick pair settled the spinner while mpv reported paused-for-cache",
    ).toEqual([true]);
    const runaway = timeupdates.filter((t) => t > 0.6 + CLOCK_RUNAWAY_EPS_SECS);
    expect(
      runaway,
      `clock interpolated with no audio: ${JSON.stringify(timeupdates)}`,
    ).toEqual([]);
  });

  it("E2 (RED): the 8s safety net re-arms while paused-for-cache=true — spinner holds, clock stays parked", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("pause", false);
    fireProperty("time-pos", 0.4); // base truth for the interpolator
    fireProperty("paused-for-cache", true);
    log.push("-- stalled; advancing past the 8s safety net");
    await vi.advanceTimersByTimeAsync(BUFFERING_TIMEOUT_MS + 500);

    console.log(log.join("\n"));
    expect(
      buffering,
      "safety net settled a spinner while mpv still reported the stall",
    ).toEqual([true]);
    const runaway = timeupdates.filter((t) => t > 0.4 + CLOCK_RUNAWAY_EPS_SECS);
    expect(
      runaway,
      `clock ran during the stall: ${JSON.stringify(timeupdates)}`,
    ).toEqual([]);
  });

  it("E3 (GREEN path): report(false) settles exactly once; tick-settle re-opens and the clock resumes without a jump", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("pause", false);
    fireProperty("time-pos", 0.5);
    fireProperty("paused-for-cache", true);
    fireProperty("time-pos", 0.6); // changed tick — must not settle (E1)
    await vi.advanceTimersByTimeAsync(1000);
    expect(buffering).toEqual([true]);

    fireProperty("paused-for-cache", false); // stall over -> the one settle
    log.push("-- paused-for-cache=false");
    expect(buffering).toEqual([true, false]);

    fireProperty("time-pos", 0.9); // truth resumes — tracker idle: no crash
    fireProperty("time-pos", 1.2);
    expect(buffering).toEqual([true, false]);

    timeupdates.length = 0;
    fireProperty("time-pos", 1.5);
    await vi.advanceTimersByTimeAsync(600);
    log.push(
      `-- after resume (getCurrentTime=${String(ctrl.getCurrentTime())})`,
    );

    console.log(log.join("\n"));
    expect(ctrl.getCurrentTime()).toBeGreaterThanOrEqual(1.5);
    const last = timeupdates[timeupdates.length - 1] ?? Number.NaN;
    expect(
      last,
      `clock stayed stuck after the stall ended: ${JSON.stringify(timeupdates)}`,
    ).toBeGreaterThan(1.5);

    // Tick-settle works again for the next request (flag cleared by report(false)).
    buffering.length = 0;
    await ctrl.playTrack(trackB);
    fireProperty("time-pos", 10);
    fireProperty("time-pos", 10.5);
    expect(buffering, "tick-settle did not recover after the stall").toEqual([
      true,
      false,
    ]);
  });

  it("E4 (terminal guard): end-file error settles even while paused-for-cache=true", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("pause", false);
    fireProperty("paused-for-cache", true);
    expect(buffering).toEqual([true]);
    buffering.length = 0;
    log.length = 0;

    fireMpvEvent("end-file", "error");
    await vi.advanceTimersByTimeAsync(100);

    console.log(log.join("\n"));
    expect(
      buffering,
      "the paused-for-cache flag blocked the terminal settle",
    ).toEqual([false]);
  });

  it("E5 (variant): release() drops the stale stall flag — the next engine's ticks settle normally", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("paused-for-cache", true);
    expect(buffering).toEqual([true]);

    ctrl.release(); // cancel path: silent, but the dead stall flag dies too
    await vi.advanceTimersByTimeAsync(BUFFERING_TIMEOUT_MS + 500);
    expect(buffering).toEqual([true]); // no false, no resurrected timer

    await ctrl.playTrack(trackB); // fresh cycle
    expect(buffering).toEqual([true, true]);
    fireProperty("time-pos", 1);
    fireProperty("time-pos", 1.5);
    expect(
      buffering,
      "cancel() leaked paused-for-cache=true into the next engine",
    ).toEqual([true, true, false]);
  });
});
