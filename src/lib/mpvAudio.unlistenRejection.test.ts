/**
 * Regression (audit B6): Tauri's listen() returns an ASYNC unlisten at runtime
 * (the `UnlistenFn = () => void` type understates the promise), so a rejecting
 * unlisten escaped detachListeners' sync try/catch as an unhandled rejection
 * during engine teardown. One failing handle must neither block the remaining
 * handles nor go unlogged.
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
import { captureError } from "../utils/errorLog";

const PROXY_PORT = 51234;

const trackA: Track = {
  id: "A",
  title: "Track A",
  artist: "Artist",
  streamUrl: "/drive-stream/A",
};

/** Unlisten calls in detach order; the 2nd handle (mpv-event) rejects. */
const unlistenOrder: string[] = [];
let listenSeq = 0;

function attachMocks(): void {
  tauriMocks.invoke.mockImplementation((command: string) =>
    command === "stream_proxy_start"
      ? Promise.resolve(PROXY_PORT)
      : Promise.resolve(undefined),
  );
  tauriMocks.listen.mockImplementation((): Promise<() => void> => {
    const index = listenSeq++;
    return Promise.resolve(() => {
      unlistenOrder.push(`u${String(index)}`);
      if (index === 1) return Promise.reject(new Error("ipc torn down"));
      return undefined;
    });
  });
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("MpvAudioController — unlisten rejection during teardown (B6)", () => {
  let ctrl: MpvAudioController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // move Date.now() off 0 for throttle clocks
    listenSeq = 0;
    unlistenOrder.length = 0;
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    vi.mocked(captureError).mockClear();
    attachMocks();
    ctrl = new MpvAudioController();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("release(): rejecting unlisten is logged, remaining handles still run, no unhandled rejection", async () => {
    await ctrl.playTrack(trackA);
    expect(unlistenOrder).toEqual([]); // sanity: handles attached, nothing detached yet
    vi.mocked(captureError).mockClear();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      ctrl.release();
      await flushMicrotasks();

      // Every handle detached — one rejection never blocks the rest.
      expect(unlistenOrder).toEqual(["u0", "u1", "u2"]);
      expect(captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          source: "MpvAudioController",
          message: expect.stringContaining(
            "unlisten-failed",
          ) as unknown as string,
        }),
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
