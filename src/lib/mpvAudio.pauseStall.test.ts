/**
 * A user pause is NOT buffering.
 *
 * mpv computes `paused-for-cache` from the cache state ALONE — it does not
 * depend on the user's pause — so a push can arrive while the user paused.
 * If the engine turned that into a spinner, the UI would show a "waiting for
 * the cache" affordance over a track the user deliberately stopped.
 *
 * The contract therefore lives in the ENGINE, not in the UI: the engine's
 * buffering signal is the single truth the UI follows, and the engine must
 * never raise it while the user paused. The raw mpv fact is kept and replayed
 * on resume, so a REAL stall after the resume still shows.
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
import {
  BUFFERING_TIMEOUT_MS,
  resetWarnThrottleForTest,
  SPINNER_DELAY_MS,
} from "./mpvProtocol";

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
  for (const handler of tauriListeners.get("mpv-property") ?? []) {
    handler({ payload: { name, data } });
  }
}

function fireMpvEvent(event: string, reason: string | null = null): void {
  for (const handler of tauriListeners.get("mpv-event") ?? []) {
    handler({ payload: { event, reason, error: null } });
  }
}

const trackA: Track = {
  id: "A",
  title: "Track A",
  artist: "Artist",
  streamUrl: "/drive-stream/A",
};

describe("MpvAudioController — a user pause is never reported as buffering", () => {
  let ctrl: MpvAudioController;
  let buffering: boolean[];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    tauriListeners.clear();
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    resetWarnThrottleForTest();
    attachMocks();
    ctrl = new MpvAudioController();
    buffering = [];
    ctrl.on("buffering", ({ isBuffering }) => buffering.push(isBuffering));
    await ctrl.playTrack(trackA);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("the user pause turns the spinner off", () => {
    expect(buffering).toEqual([true]);

    fireProperty("pause", true);

    expect(buffering).toEqual([true, false]);
  });

  it("mpv's paused-for-cache=true WHILE the user paused raises no spinner", () => {
    fireProperty("pause", true);
    buffering.length = 0;

    // mpv computes paused-for-cache from the cache state alone — the user's
    // pause does not stop it from reporting a low cache.
    fireProperty("paused-for-cache", true);
    vi.advanceTimersByTime(SPINNER_DELAY_MS * 4);

    expect(buffering, "a deliberate pause was reported as buffering").toEqual(
      [],
    );
  });

  it("a resume with no stall raises nothing", () => {
    fireProperty("pause", true);
    buffering.length = 0;

    fireProperty("pause", false);
    vi.advanceTimersByTime(SPINNER_DELAY_MS * 4);

    expect(buffering).toEqual([]);
  });

  it("a real stall after the resume DOES raise the spinner", () => {
    fireProperty("pause", true);
    fireProperty("pause", false); // the user is playing again
    buffering.length = 0;

    // A fresh stall report while playing.
    fireProperty("paused-for-cache", true);
    vi.advanceTimersByTime(SPINNER_DELAY_MS);

    expect(buffering).toEqual([true]);
  });

  it("a stall that is still in force at the resume is replayed (the raw fact)", () => {
    fireProperty("pause", true);
    // mpv reports the low cache while the user is paused: the fact is kept,
    // the signal is not raised.
    fireProperty("paused-for-cache", true);
    vi.advanceTimersByTime(SPINNER_DELAY_MS * 4);
    buffering.length = 0;

    // The resume replays the raw fact: the stall is still in force, so the
    // spinner comes up — from the REPLAY, not from the ignored report.
    fireProperty("pause", false);
    vi.advanceTimersByTime(SPINNER_DELAY_MS);

    expect(
      buffering,
      "the stall that survived the pause was not replayed on resume",
    ).toEqual([true]);
  });

  it("the pause forgets the stall: a seek issued while paused is still settled by the net", () => {
    // A genuine stall before the pause.
    fireProperty("paused-for-cache", true);
    fireProperty("pause", true);
    expect(buffering).toEqual([true, false]);

    ctrl.seek(30);
    vi.advanceTimersByTime(SPINNER_DELAY_MS);
    expect(buffering).toEqual([true, false, true]);

    // The stale stall flag must not make the net re-arm forever.
    vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS);
    expect(
      buffering,
      "a stale stall kept the seek spinner alive forever",
    ).toEqual([true, false, true, false]);
  });

  it("the terminal end-file still settles while a stall is in force", () => {
    fireProperty("paused-for-cache", true);
    expect(buffering).toEqual([true]);

    fireMpvEvent("end-file", "error");

    expect(buffering).toEqual([true, false]);
  });
});
