/**
 * REGRESSION tests for the spinner/seek/settle defects reported by the user
 * (S1 + S4, engine level), now encoding the fixed contract v3:
 *
 * S1 — "đang load/spinner quay mà user seek → fill nhảy về vị trí cũ":
 *   E1/E2/E3 pin the three stale sources that used to rewrite the clock after
 *   `seek()`: the interpolator's pre-seek base, a late pre-seek time-pos push
 *   and an in-flight watchdog poll. v3: seek snaps the clock to the target,
 *   drops every report outside SEEK_ACK_TOLERANCE_SECS until the ack lands.
 * S4 — "spinner tắt sớm hoặc quay mãi không tắt":
 *   E4 (switch while paused after the spinner was shown: mpv's pause=false
 *   must NOT settle; track B keeps its spinner until truth arrives), E5
 *   (pause while shown then resume: the resume's pause=false must not
 *   settle while the stall persists), E6 (the stale pre-seek tick is dropped,
 *   so a single real post-seek tick cannot settle), E7 (end-file error
 *   settles immediately instead of riding the 8s safety net).
 *   E8: buffering=true is emitted at playTrack — BEFORE first-audio (v3
 *   immediate promote closes the S2 source gap).
 *   E9/E10/E11 (variants, same root causes): frozen-value ticks are not
 *   progress; sequential seeks re-target the ack filter; eof settles too.
 *
 * Harness mirrors mpvAudio.test.ts. R3.2: the engine owns its playback truth
 * (no store mirror) — the watchdog/interpolator gates read engine state.
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
import {
  BUFFERING_TIMEOUT_MS,
  SEEK_ACK_TIMEOUT_MS,
  SPINNER_DELAY_MS,
} from "../mpvProtocol";

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

describe("spinner/seek/settle investigation — engine level (S1 + S4)", () => {
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
    ctrl.on("play", () => log.push("play"));
    ctrl.on("pause", () => log.push("pause"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Plays A to a settled, spinner-idle state with a known clock position. */
  async function playSettled(position: number): Promise<void> {
    await ctrl.playTrack(trackA);
    fireProperty("pause", false);
    // Two ticks: v3 promotes the spinner immediately at playTrack (S2), then
    // the 2nd changed tick settles it — net [true, false], tracker idle.
    fireProperty("time-pos", position);
    fireProperty("time-pos", position + 0.2);
    await vi.advanceTimersByTimeAsync(300);
    expect(buffering).toEqual([true, false]);
    // R3.2: the store projection moved to the policy adapter — the engine
    // fact proving playback is rolling is the `play` event itself (logged).
    expect(log).toContain("play");
  }

  it("E1 (S1 fixed): seek() snaps the clock to the target — the stale pre-seek interpolation base never repaints", async () => {
    await playSettled(100);
    timeupdates.length = 0;

    ctrl.seek(120);
    log.push("-- seek(120) sent");
    await vi.advanceTimersByTimeAsync(SPINNER_DELAY_MS + 200);

    // v3: seek force-emits the target immediately and resets the interpolator
    // base, so nothing can regress to the old clock while unacknowledged.
    console.log(log.join("\n"));
    expect(timeupdates.length).toBeGreaterThan(0);
    expect(
      timeupdates.every((t) => t >= 120),
      `emissions after seek(120) regressed to the pre-seek clock: ${JSON.stringify(timeupdates)}`,
    ).toBe(true);
  });

  it("E2 (S1 fixed): a late pre-seek time-pos push after seek(120) is dropped (clock + fill stay at the target)", async () => {
    await playSettled(10);
    buffering.length = 0;
    timeupdates.length = 0;

    ctrl.seek(120);
    await vi.advanceTimersByTimeAsync(300); // pending -> shown at 250ms
    fireProperty("time-pos", 10.6); // queued pre-seek push delivered late
    log.push(
      `-- stale push 10.6 (getCurrentTime=${String(ctrl.getCurrentTime())})`,
    );

    console.log(log.join("\n"));
    expect(
      ctrl.getCurrentTime(),
      "getCurrentTime() regressed below the seek target",
    ).toBeGreaterThanOrEqual(120);
    expect(
      timeupdates.every((t) => t >= 120),
      `stale pre-seek time-pos was emitted to consumers: ${JSON.stringify(timeupdates)}`,
    ).toBe(true);
  });

  it("E3 (S1 fixed): an in-flight watchdog poll resolving after seek(120) is dropped too", async () => {
    await playSettled(10);
    let resolvePoll: (value: unknown) => void = () => {};
    let pollCalls = 0;
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "mpv_get_property") {
        pollCalls += 1;
        return new Promise((resolve) => {
          resolvePoll = resolve;
        });
      }
      return command === "stream_proxy_start"
        ? Promise.resolve(PROXY_PORT)
        : Promise.resolve(undefined);
    });
    await vi.advanceTimersByTimeAsync(2200); // push stall -> poll in flight
    expect(pollCalls).toBe(1);

    timeupdates.length = 0;
    ctrl.seek(120);
    log.push("-- seek(120) sent (poll still in flight)");
    resolvePoll(10.2); // the poll only knows the pre-seek position
    await vi.advanceTimersByTimeAsync(500);
    log.push(
      `-- poll resolved (getCurrentTime=${String(ctrl.getCurrentTime())})`,
    );

    console.log(log.join("\n"));
    expect(
      ctrl.getCurrentTime(),
      "stale poll result overwrote the post-seek clock",
    ).toBeGreaterThanOrEqual(120);
    expect(
      timeupdates.every((t) => t >= 120),
      `stale poll value was re-based + emitted: ${JSON.stringify(timeupdates)}`,
    ).toBe(true);
  });

  it("E4 (S3/S4 fixed): switch while paused with the spinner already shown — pause=false no longer settles it, B keeps the spinner", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("pause", false);
    await vi.advanceTimersByTimeAsync(SPINNER_DELAY_MS);
    // v3: A's spinner promoted immediately at playTrack (no display delay).
    expect(buffering).toEqual([true]);

    // User pauses while A is still buffering. The tracker is NOT cancelled
    // (mpvAudio.onPauseChange never touches buffering), so it stays shown.
    fireProperty("pause", true);
    await vi.advanceTimersByTimeAsync(1000);
    buffering.length = 0;
    log.length = 0;

    // User selects track B while paused: beginTrack clears mpv's process
    // global pause flag and playTrack re-arms the spinner request.
    await ctrl.playTrack(trackB);
    fireProperty("pause", false); // mpv confirms the flag clear (NOT playback)
    await vi.advanceTimersByTimeAsync(SPINNER_DELAY_MS);
    log.push("-- +250ms after B's request");

    console.log(log.join("\n"));
    // A2 (R4): the switch resets A's session and promotes B's own — exactly
    // one fresh true; crucially NO false — the spinner never drops while B
    // has produced no audio.
    expect(buffering, "no false may drop B's spinner").not.toContain(false);
    expect(buffering).toEqual([true]);
    // Tracker is still alive: B's progressing ticks settle it exactly once.
    fireProperty("time-pos", 1);
    fireProperty("time-pos", 1.5);
    expect(buffering).toEqual([true, false]);
  });

  it("E5 (S4 fixed): pause while shown then resume — the resume's pause=false never settles the stall away", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("pause", false);
    await vi.advanceTimersByTimeAsync(SPINNER_DELAY_MS);
    expect(buffering).toEqual([true]);

    fireProperty("pause", true); // user pauses during the stall
    log.length = 0;
    buffering.length = 0;

    fireProperty("pause", false); // user hits play again — stall continues
    await vi.advanceTimersByTimeAsync(1000);
    log.push("-- +1s after resume (no real time-pos push arrived)");

    console.log(log.join("\n"));
    // No truth arrived since resume: the spinner must stay until playback is
    // actually confirmed — and no false may have been emitted.
    expect(
      buffering,
      "resume settled the spinner without any confirming time-pos tick",
    ).toEqual([]);
  });

  it("E6 (S4 fixed): the stale pre-seek tick is dropped — ONE real post-seek tick cannot settle the spinner", async () => {
    await playSettled(10);
    buffering.length = 0;
    log.length = 0;

    ctrl.seek(120);
    await vi.advanceTimersByTimeAsync(300); // pending -> shown
    expect(buffering).toEqual([true]);
    fireProperty("time-pos", 10.6); // stale queued pre-seek push — rejected by the ack filter
    log.push("-- stale tick 10.6 (dropped: outside seek-ack tolerance)");
    await vi.advanceTimersByTimeAsync(300);
    fireProperty("time-pos", 119.8); // first real post-seek truth — tick 1
    log.push("-- real tick 119.8 (acks the seek, counts as the 1st tick)");

    console.log(log.join("\n"));
    // Only one progressing post-seek tick arrived: not "two ticks of
    // progress" — the spinner must stay until a second changed tick.
    expect(
      buffering,
      "spinner settled with only ONE progressing post-seek tick",
    ).toEqual([true]);
  });

  it("E8 (S2 fixed): buffering=true is emitted at playTrack, BEFORE first-audio — no spinner gap", async () => {
    await ctrl.playTrack(trackA); // v3 immediate promote at request(true)
    log.push("-- playTrack (v3: immediate promote)");

    await vi.advanceTimersByTimeAsync(100);
    fireProperty("time-pos", 0.1); // first real push = first-audio moment
    log.push("-- first push @+100ms");

    const snapshot = [...log];
    expect(snapshot).toContain("buffering=true");
    expect(snapshot).toContain("first-audio");
    // The spinner source exists BEFORE the first-audio signal turns the
    // hook's isDownloading off — the Pause-icon flash window is closed.
    expect(snapshot.indexOf("buffering=true")).toBeLessThan(
      snapshot.indexOf("first-audio"),
    );

    await vi.advanceTimersByTimeAsync(SPINNER_DELAY_MS - 100);
    log.push("-- @+250ms");

    console.log(log.join("\n"));
    expect(log.indexOf("buffering=true")).toBeLessThan(
      log.indexOf("first-audio"),
    );
  });

  it("E7 (S4 fixed): end-file error while shown settles immediately — no 8s safety-net ride", async () => {
    await ctrl.playTrack(trackA);
    fireProperty("pause", false);
    await vi.advanceTimersByTimeAsync(SPINNER_DELAY_MS);
    expect(buffering).toEqual([true]);
    buffering.length = 0;
    log.length = 0;

    fireMpvEvent("end-file", "error");
    await vi.advanceTimersByTimeAsync(1000); // terminal state -> settle expected

    console.log(log.join("\n"));
    // The track failed; the tracker settles at the terminal event instead of
    // spinning on a dead track until the safety net.
    expect(buffering, "spinner outlived the end-file error").toContain(false);

    await vi.advanceTimersByTimeAsync(BUFFERING_TIMEOUT_MS - 1000);
    expect(buffering).toEqual([false]); // nothing else emitted afterwards
  });

  it("E9 (variant S4): frozen time-pos repeats are not progress — a changed tick is still required to settle", async () => {
    await ctrl.playTrack(trackA); // v3: shown
    expect(buffering).toEqual([true]);
    buffering.length = 0;

    fireProperty("time-pos", 5); // 1st counted value
    fireProperty("time-pos", 5); // identical — frozen, must not count
    fireProperty("time-pos", 5); // identical — frozen, must not count
    await vi.advanceTimersByTimeAsync(300);
    expect(buffering).toEqual([]); // still shown: no progress

    fireProperty("time-pos", 5.1); // changed within 1s of the last counted tick
    expect(buffering).toEqual([false]);
  });

  it("E10 (variant S1): a second seek re-targets the ack filter — the first target's late report is dropped", async () => {
    await playSettled(10);
    timeupdates.length = 0;

    ctrl.seek(120);
    ctrl.seek(200);
    expect(ctrl.getCurrentTime()).toBe(200);

    fireProperty("time-pos", 120.2); // acked the OLD target, stale for the new
    expect(
      ctrl.getCurrentTime(),
      "the first seek's report leaked past the re-targeted filter",
    ).toBe(200);

    fireProperty("time-pos", 200.1); // acks the new target
    expect(ctrl.getCurrentTime()).toBe(200.1);
  });

  it("E11 (variant S4): eof is terminal too — the spinner settles at end-file, not at the safety net", async () => {
    await ctrl.playTrack(trackA); // v3: shown
    expect(buffering).toEqual([true]);

    fireMpvEvent("end-file", "eof");
    expect(buffering).toEqual([true, false]);
  });

  it("E12 (variant S1): the seek-ack failsafe unfilters after SEEK_ACK_TIMEOUT_MS when no ack ever arrives", async () => {
    await playSettled(10);

    ctrl.seek(120);
    fireProperty("time-pos", 10.6); // dropped while the filter is armed
    expect(ctrl.getCurrentTime()).toBe(120);

    await vi.advanceTimersByTimeAsync(SEEK_ACK_TIMEOUT_MS);
    // mpv never confirmed: the failsafe releases the filter so the clock can
    // resync from real reports again instead of freezing forever.
    fireProperty("time-pos", 10.7);
    expect(ctrl.getCurrentTime()).toBe(10.7);
  });
});
