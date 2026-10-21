/**
 * The STARTUP session owns the loader of a LOAD — from the loadfile until the
 * playback chain is confirmed (`playback-restart`). A seek that arrives while
 * that session is open must not take it over: the tick-pair settle and the 8s
 * net are the SEEK's rules, and applying them to a load that was never
 * confirmed drops the loader of a slow load at the 8s mark.
 *
 * The seek that used to break it is the DEFERRED one: `playTrack(track,
 * startTime)` arms the seek before the file is loaded, and `applyPendingSeek`
 * issues it on `file-loaded` — i.e. exactly while the startup session is open.
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
import { BUFFERING_TIMEOUT_MS, resetWarnThrottleForTest } from "./mpvProtocol";

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

function fireMpvEvent(event: string): void {
  for (const handler of tauriListeners.get("mpv-event") ?? []) {
    handler({ payload: { event, reason: null, error: null } });
  }
}

const trackA: Track = {
  id: "A",
  title: "Track A",
  artist: "Artist",
  streamUrl: "/drive-stream/A",
};

describe("MpvAudioController — the startup session survives a seek", () => {
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
    await ctrl.playTrack(trackA, 120);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("the deferred seek of playTrack(track, 120) does not dismiss the loader", () => {
    expect(buffering).toEqual([true]);

    // file-loaded issues the deferred seek — the seek lands INSIDE the open
    // startup session.
    fireMpvEvent("file-loaded");

    // The loader is still up: the seek did not take the session over.
    expect(buffering).toEqual([true]);

    // A tick pair is the SEEK's settle rule — it must not apply here.
    fireProperty("time-pos", 120);
    fireProperty("time-pos", 121);
    expect(buffering).toEqual([true]);
  });

  it("the 8s net does not dismiss the loader of an unconfirmed load", () => {
    fireMpvEvent("file-loaded");

    vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS);

    expect(
      buffering,
      "the startup loader was dismissed by the seek's 8s net",
    ).toEqual([true]);
  });

  it("only the confirmed playback start dismisses the loader", () => {
    fireMpvEvent("file-loaded");
    vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS);

    fireMpvEvent("playback-restart");

    expect(buffering).toEqual([true, false]);
  });
});

describe("MpvAudioController — a seek after playback started keeps its own rules", () => {
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
    // The chain is up: the startup session is over.
    fireMpvEvent("playback-restart");
    buffering.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("the seek spinner is shown after the display delay and settled by a tick pair", () => {
    ctrl.seek(60);

    vi.advanceTimersByTime(249);
    expect(buffering).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(buffering).toEqual([true]);

    fireProperty("time-pos", 60);
    fireProperty("time-pos", 60.5);
    expect(buffering).toEqual([true, false]);
  });

  it("the seek's 8s net still settles a seek that no tick ever confirms", () => {
    ctrl.seek(60);
    vi.advanceTimersByTime(250);
    expect(buffering).toEqual([true]);

    vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS);
    expect(buffering).toEqual([true, false]);
  });
});
